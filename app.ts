// The forge's HTTP server: routing, bearer auth, the X-GitHub-Request-Id discipline,
// and total error containment (a malformed request gets an error reply, never a
// crashed process — a crash scores 0 on every column). Surfaces:
//   GET  /healthz                          the env's boot probe
//   /{owner}/{repo}.git/...                git smart HTTP (lib/gitproto.ts)
//   /api/v3/...                            REST v3 (lib/rest.ts)
//   /api/graphql                           GraphQL v4 (lib/graphql.ts)
//   /mcp                                   MCP (lib/mcp.ts)
// main.ts is the entry <-> env lifecycle and stays as the starter wrote it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER } from './lib/store.ts';
import { advertise, fetchV0, fetchV2, lsRefs, receivePack, type GitReply } from './lib/gitproto.ts';
import { parsePkts } from './lib/gitobj.ts';
import { routeRest, type RestReply } from './lib/rest.ts';
import { executeGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** Whether the request carries the trial's bearer token (MAKEFUN_SHOP_TOKEN). */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  if (expected === '') return true; // local development: any presented token
  return header === `Bearer ${expected}` || header === `token ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendGit(res: ServerResponse, reply: GitReply): void {
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': reply.body.length,
    'x-github-request-id': requestId(),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
  res.end(reply.body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(forge, req, res).catch(() => {
      // Last-resort containment: the process must survive anything.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
        else res.end();
      } catch {
        // socket already gone
      }
    });
  });
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1]);
    const repoName = decodeSegment(gitMatch[2]);
    const endpoint = gitMatch[3];
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="forge"' });
      res.end('authentication required\n');
      return;
    }
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('repository not found\n');
      return;
    }
    const protocolHeader = req.headers['git-protocol'];
    const protocolV2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('service not available\n');
        return;
      }
      sendGit(res, advertise(forge, repo, service, protocolV2));
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      if (protocolV2) {
        const packets = parsePkts(body);
        const firstData = packets.find((packet) => packet.kind === 'data');
        const commandLine = firstData?.kind === 'data' ? firstData.payload.toString('utf8') : '';
        if (commandLine.startsWith('command=ls-refs')) {
          sendGit(res, { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(forge, repo, packets) });
          return;
        }
        if (commandLine.startsWith('command=fetch')) {
          sendGit(res, fetchV2(forge, repo, packets));
          return;
        }
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unknown command\n');
        return;
      }
      sendGit(res, fetchV0(forge, repo, body));
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      sendGit(res, receivePack(forge, repo, body));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- GraphQL
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const reply = executeGraphQL(forge, parsed);
    sendJson(res, reply.status, reply.payload);
    return;
  }

  // ---- MCP
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    const body = await readBody(req);
    const reply = handleMcp(forge, body);
    if (reply.payload === undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.payload);
    return;
  }

  // ---- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
    if (!isPublic && !authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    let body: unknown;
    let bodyError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyError = true;
        }
      }
    }
    const reply: RestReply = routeRest(forge, {
      method,
      segments,
      query: url.searchParams,
      body,
      bodyError,
      host: req.headers.host ?? '127.0.0.1',
    });
    if (reply.status === 204) {
      res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body ?? {}, reply.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
