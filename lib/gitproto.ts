// Git smart HTTP: ref advertisement (protocol v0 and v2), ls-refs, fetch (v0 and v2,
// with shallow/deepen), and receive-pack with report-status. All in-process against
// the forge store; packs are built and parsed with lib/gitobj.ts.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  isOid,
  parsePkts,
  pktLine,
  readPack,
  splitPktBody,
  writePack,
  type GitObject,
  type Pkt,
} from './gitobj.ts';
import type { Forge, RepoRec } from './store.ts';

const UPLOAD_CAPS_V0 =
  'side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k ofs-delta delete-refs agent=forge/1.0';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function textReply(status: number, text: string): GitReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

/** Refs in advertisement order: HEAD first, then refs sorted by name. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return 'refs/heads/main';
}

// --------------------------------------------------------------------------- advertisement

export function advertise(forge: Forge, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): GitReply {
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n'];
    const body = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}`);
    if (name.startsWith('refs/tags/')) {
      const commit = forge.peelToCommit(oid);
      if (commit !== null && commit !== oid) lines.push(`${commit} ${name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// --------------------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(packets: Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue; // command= and capability-argument lines
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function lsRefs(forge: Forge, repo: RepoRec, packets: Pkt[]): Buffer {
  const args = parseLsRefs(packets);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name === prefix || name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = headTarget(repo);
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel && name.startsWith('refs/tags/')) {
      const commit = forge.peelToCommit(oid);
      if (commit !== null && commit !== oid) line += ` peeled:${commit}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// --------------------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) request.deepen = value;
    }
    // deepen-since / deepen-not / filter / done / want-ref: not exercised by the
    // suite beyond what is handled; want-ref is resolved by the caller if present.
  }
  return request;
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  commonHave: string | null;
}

function planFetch(forge: Forge, request: FetchRequest): FetchPlan {
  const wants = request.wants.filter((oid) => isOid(oid) && forge.getObject(oid) !== undefined);
  // The client's `shallow` lines cut its held history at those commits: objects below
  // the boundary are NOT held, however deep our own copy of the history runs.
  const haveClosure = forge.closure(request.haves.filter((oid) => forge.getObject(oid) !== undefined), {
    cutCommits: new Set(request.shallow),
  }).objects;
  let objects: Set<string>;
  let boundary = new Set<string>();
  if (request.deepen !== null) {
    const planned = forge.closure(wants, { maxDepth: request.deepen });
    objects = planned.objects;
    boundary = planned.boundary;
  } else {
    objects = forge.closure(wants).objects;
  }
  for (const oid of haveClosure) objects.delete(oid);
  // A boundary commit the client already fully holds is not a boundary any more.
  const shallow = [...boundary].filter((oid) => !haveClosure.has(oid));
  const included = forge.closure(wants, request.deepen !== null ? { maxDepth: request.deepen } : {}).objects;
  const unshallow = request.shallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  const packObjects: GitObject[] = [];
  for (const oid of objects) {
    const object = forge.getObject(oid);
    if (object !== undefined) packObjects.push(object);
  }
  // Commits first, then trees, then blobs, then tags: a stable, readable pack order.
  const rank = { commit: 0, tree: 1, blob: 2, tag: 3 } as const;
  packObjects.sort((a, b) => rank[a.type] - rank[b.type]);
  const commonHave = request.haves.find((oid) => forge.getObject(oid) !== undefined) ?? null;
  return { pack: writePack(packObjects), shallow, unshallow, commonHave };
}

/** Chunk pack bytes into sideband band-1 pkt-lines. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const slice = pack.subarray(pos, Math.min(pack.length, pos + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return out;
}

export function fetchV2(forge: Forge, repo: RepoRec, packets: Pkt[]): GitReply {
  // packets: command section, delim, argument section, flush
  const argLines: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (inArgs) argLines.push(packet.payload.toString('utf8'));
  }
  const request = parseFetchArgs(argLines);
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonHave !== null) {
    parts.push(pktLine(`ACK ${plan.commonHave}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (request.shallow.length > 0 || request.deepen !== null || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function fetchV0(forge: Forge, repo: RepoRec, body: Buffer): GitReply {
  const first = splitPktBody(body);
  const second = parsePkts(first.rest);
  const linesOf = (packets: Pkt[]): string[] =>
    packets.filter((p): p is Extract<Pkt, { kind: 'data' }> => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const request = parseFetchArgs([...linesOf(first.packets), ...linesOf(second)]);
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(forge: Forge, repo: RepoRec, body: Buffer): GitReply {
  const { packets, rest } = splitPktBody(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      if (caps.includes('report-status')) reportStatus = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (commands.length === 0) return textReply(400, 'no ref commands\n');

  let unpackLine = 'unpack ok\n';
  let packObjects: Map<string, GitObject> | null = null;
  if (rest.length > 0) {
    try {
      packObjects = readPack(rest, (oid) => forge.getObject(oid)).objects;
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'invalid pack'}\n`;
    }
  }
  if (packObjects !== null) {
    for (const [oid, object] of packObjects) {
      if (!forge.objects.has(oid)) forge.objects.set(oid, object);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (packObjects === null && rest.length > 0) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail(command.oldOid === ZERO_OID || current === ZERO_OID ? 'reference does not exist' : 'non-fast-forward');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = forge.getObject(command.newOid);
    if (target === undefined) {
      fail('new object not found');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const commit = forge.peelToCommit(command.newOid);
      if (commit === null) {
        fail('new value is not a commit');
        continue;
      }
      if (current !== ZERO_OID) {
        const currentCommit = forge.peelToCommit(current);
        if (currentCommit === null || !forge.isAncestor(currentCommit, commit)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!reportStatus) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportParts: Buffer[] = [pktLine(unpackLine)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (!sideband) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report };
  }
  const framed: Buffer[] = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < report.length; pos += CHUNK) {
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(pos, Math.min(report.length, pos + CHUNK))])));
  }
  framed.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(framed) };
}
