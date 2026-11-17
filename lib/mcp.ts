// MCP endpoint at /mcp: JSON-RPC over streamable HTTP, legacy era (the client tries
// server/discover, gets -32601, and falls back to the initialize handshake — the
// suite's discover check passes that as "pre-discover revision"). Tools act on the
// same store as REST/GraphQL. Stateless: no session ids.

import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { createIssueRec, createPullRec, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

export interface McpReply {
  status: number;
  payload?: unknown; // undefined => empty body (notifications)
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}
function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}
function toolResult(id: unknown, value: unknown): McpReply {
  const text = JSON.stringify(value);
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: false,
  });
}

function toolError(id: unknown, message: string): McpReply {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function repoOf(forge: Forge, args: Record<string, unknown>): RepoRec | undefined {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return undefined;
  return forge.getRepo(owner, repo);
}

function callTool(forge: Forge, id: unknown, name: string, args: Record<string, unknown>): McpReply {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = forge.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return toolResult(id, repoJson(existing));
      const repo = forge.createRepo(
        VIEWER.login,
        repoName,
        typeof args.private === 'boolean' ? args.private : false,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolResult(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return toolError(id, 'repository not found');
      return toolResult(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return toolError(id, 'repository not found');
      const issue = createIssueRec(repo, String(args.title), typeof args.body === 'string' ? args.body : '', [], forge.nextSeq());
      return toolResult(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return toolError(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolResult(id, issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return toolError(id, 'repository not found');
      const result = createPullRec(
        forge,
        repo,
        {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        },
        forge.nextSeq(),
      );
      if (result.pull === undefined) return toolError(id, 'pull request could not be created');
      return toolResult(id, pullJson(forge, repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      if (repo === undefined) return toolError(id, 'repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError(id, 'pull request not found');
      const outcome = mergePull(forge, repo, pull);
      if (!outcome.merged) return toolError(id, outcome.message);
      return toolResult(id, pullJson(forge, repo, pull));
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/**
 * Handle one POST /mcp body. `rawBody` is the exact request bytes (the parse-error
 * check needs a -32700 for non-JSON). Auth is enforced by app.ts before this runs.
 */
export function handleMcp(forge: Forge, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    // JSON-RPC batch: answer each request in order.
    const responses: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleOne(forge, entry);
      if (reply.payload !== undefined) responses.push(reply.payload);
    }
    return { status: 200, payload: responses };
  }
  return handleOne(forge, parsed);
}

function handleOne(forge: Forge, entry: unknown): McpReply {
  if (typeof entry !== 'object' || entry === null) return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = entry as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== 'string') return rpcError(id ?? null, -32600, 'Invalid Request');
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize': {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const revision =
        typeof requested === 'string' && SUPPORTED_REVISIONS.includes(requested) ? requested : SUPPORTED_REVISIONS[0];
      return rpcResult(id, {
        protocolVersion: revision,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202 };
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof callParams.name === 'string' ? callParams.name : '';
      const args = typeof callParams.arguments === 'object' && callParams.arguments !== null ? (callParams.arguments as Record<string, unknown>) : {};
      return callTool(forge, id, name, args);
    }
    default:
      if (isNotification) return { status: 202 };
      // server/discover and anything else: method not found (the pre-discover era).
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
