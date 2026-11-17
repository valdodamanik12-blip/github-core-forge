// GraphQL v4 surface: a small lexer/parser for the query language plus an executor
// over the forge store, covering the schema the suite's documents use (gh and
// github-mcp-server shapes): viewer, repository, node(id:), __type introspection,
// issue/pull-request connections with cursor pagination, and the five mutations.
// Unknown fields are GraphQL errors (HTTP 200 + `errors`), never HTTP errors.

import { DEFAULT_BRANCH, VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { createIssueRec, createPullRec, globalId, mergePull, parseGlobalId, pullFiles } from './rest.ts';

// --------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const value = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let text = '';
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) {
        text += input[j];
        j += 1;
      }
      const value = Number(text);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      let value = '';
      while (j < input.length && isNameChar(input[j])) {
        value += input[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type Selection =
  | { type: 'field'; alias?: string; name: string; args: Map<string, ValueNode>; selection?: Selection[] }
  | { type: 'spread'; name: string }
  | { type: 'inline'; typeCondition?: string; selection: Selection[] };

interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  selection: Selection[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const operation = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        const ahead = this.peek();
        if (ahead !== undefined && ahead.kind === 'name') name = this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected on in fragment');
        this.expectName(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const ahead = this.peek();
      if (ahead !== undefined && ahead.kind === 'name' && ahead.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { type: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { type: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      for (const [key, value] of this.parseArguments()) args.set(key, value);
    }
    this.skipDirectives();
    let selection: Selection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { type: 'field', alias, name, args, selection };
  }

  private parseArguments(): Array<[string, ValueNode]> {
    this.expectPunct('(');
    const out: Array<[string, ValueNode]> = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated arguments');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return out;
      }
      const name = this.expectName();
      this.expectPunct(':');
      out.push([name, this.parseValue()]);
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        const ahead = this.peek();
        if (ahead === undefined) throw new Error('unterminated list');
        if (ahead.kind === 'punct' && ahead.value === ']') {
          this.next();
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const ahead = this.peek();
        if (ahead === undefined) throw new Error('unterminated object');
        if (ahead.kind === 'punct' && ahead.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema / executor

interface GObj {
  __type: string;
  ref: unknown;
}

const obj = (type: string, ref: unknown): GObj => ({ __type: type, ref });

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: Array<{ message: string }>;
}

const ISSUE_FIELDS = ['author', 'body', 'closedAt', 'comments', 'createdAt', 'id', 'labels', 'number', 'repository', 'state', 'title', 'updatedAt', 'url'];
const PULL_FIELDS = ['additions', 'author', 'baseRef', 'baseRefName', 'body', 'changedFiles', 'closedAt', 'comments', 'createdAt', 'deletions', 'files', 'headRef', 'headRefName', 'id', 'merged', 'mergedAt', 'mergeable', 'number', 'repository', 'state', 'title', 'updatedAt', 'url'];
const REPO_FIELDS = ['createdAt', 'databaseId', 'defaultBranchRef', 'description', 'hasIssuesEnabled', 'id', 'isPrivate', 'issue', 'issues', 'name', 'nameWithOwner', 'owner', 'pullRequest', 'pullRequests', 'pushedAt', 'updatedAt', 'url', 'viewerPermission'];
const TYPE_FIELDS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ISSUE_FIELDS },
  PullRequest: { kind: 'OBJECT', fields: PULL_FIELDS },
  Repository: { kind: 'OBJECT', fields: REPO_FIELDS },
  User: { kind: 'OBJECT', fields: ['email', 'id', 'login', 'name', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  PageInfo: { kind: 'OBJECT', fields: ['endCursor', 'hasNextPage', 'hasPreviousPage', 'startCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['edges', 'nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['edges', 'nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['additions', 'deletions', 'path'] },
  IssueComment: { kind: 'OBJECT', fields: ['author', 'body', 'createdAt', 'id', 'url'] },
  Label: { kind: 'OBJECT', fields: ['color', 'id', 'name'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'totalCount'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['CLOSED', 'OPEN'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['CLOSED', 'MERGED', 'OPEN'] },
  MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'] },
};

function repoById(forge: Forge, id: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueGObj(repo: RepoRec, issue: IssueRec): GObj {
  return obj('Issue', { repo, issue });
}
function pullGObj(repo: RepoRec, pull: PullRec): GObj {
  return obj('PullRequest', { repo, pull });
}

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

interface Connection {
  nodes: GObj[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginate(items: GObj[], args: Map<string, unknown>): Connection {
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' && firstRaw >= 0 ? Math.floor(firstRaw) : items.length;
  const afterIndex = cursorIndex(args.get('after'));
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const slice = items.slice(start, start + first);
  return {
    nodes: slice,
    totalCount: items.length,
    hasNextPage: start + slice.length < items.length,
    endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : (typeof args.get('after') === 'string' ? (args.get('after') as string) : null),
    startCursor: slice.length > 0 ? cursorOf(start) : null,
  };
}

function argsOf(field: Extract<Selection, { type: 'field' }>, ctx: Ctx): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [name, value] of field.args) out.set(name, resolveValue(value, ctx.variables));
  return out;
}

type Resolver = (ctx: Ctx, source: GObj, args: Map<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => obj('User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    repository: (ctx, _s, args) => {
      const owner = args.get('owner');
      const name = args.get('name');
      if (owner !== VIEWER.login || typeof name !== 'string') return null;
      const repo = ctx.forge.getRepo(VIEWER.login, name);
      return repo === undefined ? null : obj('Repository', repo);
    },
    node: (ctx, _s, args) => {
      const id = args.get('id');
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = repoById(ctx.forge, Number(parsed.key));
        return repo === undefined ? null : obj('Repository', repo);
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const [repoId, number] = parsed.key.split(':').map((x) => Number(x));
        const repo = repoById(ctx.forge, repoId);
        if (repo === undefined) return null;
        if (parsed.type === 'Issue') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueGObj(repo, issue);
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullGObj(repo, pull);
      }
      if (parsed.type === 'User') return obj('User', { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
      return null;
    },
    __type: (_ctx, _s, args) => {
      const name = args.get('name');
      if (typeof name !== 'string' || TYPE_FIELDS[name] === undefined) return null;
      return obj('__Type', { name, def: TYPE_FIELDS[name] });
    },
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.type === 'Repository' ? repoById(ctx.forge, Number(parsed.key)) : undefined;
      if (repo === undefined) throw new Error('repository not found for createIssue');
      const issue = createIssueRec(repo, String(input.title ?? ''), String(input.body ?? ''), [], ctx.forge.nextSeq());
      return obj('CreateIssuePayload', { issue: issueGObj(repo, issue) });
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      if (parsed?.type !== 'Issue') throw new Error('issue not found for closeIssue');
      const [repoId, number] = parsed.key.split(':').map((x) => Number(x));
      const repo = repoById(ctx.forge, repoId);
      const issue = repo?.issues.get(number);
      if (repo === undefined || issue === undefined) throw new Error('issue not found for closeIssue');
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueGObj(repo, issue) });
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.type === 'Repository' ? repoById(ctx.forge, Number(parsed.key)) : undefined;
      if (repo === undefined) throw new Error('repository not found for createPullRequest');
      const result = createPullRec(
        ctx.forge,
        repo,
        {
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        },
        ctx.forge.nextSeq(),
      );
      if (result.pull === undefined) throw new Error('createPullRequest was refused');
      return obj('CreatePullRequestPayload', { pull: pullGObj(repo, result.pull) });
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      if (parsed?.type !== 'PullRequest') throw new Error('pull request not found for mergePullRequest');
      const [repoId, number] = parsed.key.split(':').map((x) => Number(x));
      const repo = repoById(ctx.forge, repoId);
      const pull = repo?.pulls.get(number);
      if (repo === undefined || pull === undefined) throw new Error('pull request not found for mergePullRequest');
      const outcome = mergePull(ctx.forge, repo, pull);
      if (!outcome.merged) throw new Error('mergePullRequest was refused: not mergeable');
      return obj('MergePullRequestPayload', { pull: pullGObj(repo, pull) });
    },
    addComment: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      if (parsed === null || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) throw new Error('subject not found for addComment');
      const [repoId, number] = parsed.key.split(':').map((x) => Number(x));
      const repo = repoById(ctx.forge, repoId);
      if (repo === undefined) throw new Error('subject not found for addComment');
      const body = String(input.body ?? '');
      if (parsed.type === 'Issue') {
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new Error('subject not found for addComment');
        const comment = { id: ctx.forge.allocCommentId(), body, seq: ctx.forge.nextSeq() };
        issue.comments.push(comment);
        return obj('AddCommentPayload', { comment: obj('IssueComment', { repo, comment }) });
      }
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error('subject not found for addComment');
      const comment = { id: ctx.forge.allocCommentId(), body, seq: ctx.forge.nextSeq() };
      // Pull-request comments live on the shared issue thread in GitHub; the suite
      // only comments on issues, so a PR comment is kept with the PR record's number.
      const host = repo.issues.get(number);
      if (host !== undefined) host.comments.push(comment);
      return obj('AddCommentPayload', { comment: obj('IssueComment', { repo, comment }) });
    },
  },
  User: {
    login: (_c, s) => (s.ref as { login: string }).login,
    id: (_c, s) => globalId('User', String((s.ref as { id: number }).id)),
    name: (_c, s) => (s.ref as { name: string }).name,
    email: (_c, s) => (s.ref as { email: string }).email,
    url: () => '',
  },
  Repository: {
    id: (_c, s) => globalId('Repository', String((s.ref as RepoRec).id)),
    databaseId: (_c, s) => (s.ref as RepoRec).id,
    name: (_c, s) => (s.ref as RepoRec).name,
    nameWithOwner: (_c, s) => `${(s.ref as RepoRec).owner}/${(s.ref as RepoRec).name}`,
    owner: (_c, s) => obj('User', { login: (s.ref as RepoRec).owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    defaultBranchRef: () => obj('Ref', { name: DEFAULT_BRANCH }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (_c, s) => (s.ref as RepoRec).priv,
    description: (_c, s) => (s.ref as RepoRec).description,
    createdAt: () => '2023-11-14T22:13:20Z',
    updatedAt: () => '2023-11-14T22:13:20Z',
    pushedAt: () => '2023-11-14T22:13:20Z',
    url: () => '',
    issue: (_c, s, args) => {
      const repo = s.ref as RepoRec;
      const number = args.get('number');
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue === undefined ? null : issueGObj(repo, issue);
    },
    issues: (_c, s, args) => {
      const repo = s.ref as RepoRec;
      let issues = [...repo.issues.values()];
      const states = args.get('states');
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toLowerCase());
        issues = issues.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
      issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
      return obj('IssueConnection', paginate(issues.map((issue) => issueGObj(repo, issue)), args));
    },
    pullRequest: (_c, s, args) => {
      const repo = s.ref as RepoRec;
      const number = args.get('number');
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pull === undefined ? null : pullGObj(repo, pull);
    },
    pullRequests: (_c, s, args) => {
      const repo = s.ref as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = args.get('states');
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toUpperCase());
        pulls = pulls.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
      return obj('PullRequestConnection', paginate(pulls.map((pull) => pullGObj(repo, pull)), args));
    },
  },
  Ref: {
    name: (_c, s) => (s.ref as { name: string }).name,
    prefix: () => 'refs/heads/',
    target: () => null,
  },
  Issue: {
    id: (_c, s) => globalId('Issue', `${(s.ref as { repo: RepoRec }).repo.id}:${(s.ref as { issue: IssueRec }).issue.number}`),
    number: (_c, s) => (s.ref as { issue: IssueRec }).issue.number,
    title: (_c, s) => (s.ref as { issue: IssueRec }).issue.title,
    body: (_c, s) => (s.ref as { issue: IssueRec }).issue.body,
    state: (_c, s) => (s.ref as { issue: IssueRec }).issue.state.toUpperCase(),
    author: (_c, s) => obj('User', { login: (s.ref as { repo: RepoRec }).repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    repository: (_c, s) => obj('Repository', (s.ref as { repo: RepoRec }).repo),
    labels: (_c, s) => {
      const { repo, issue } = s.ref as { repo: RepoRec; issue: IssueRec };
      return obj('LabelConnection', {
        nodes: issue.labels.map((name) => obj('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })),
        totalCount: issue.labels.length,
      });
    },
    comments: (_c, s) => {
      const { repo, issue } = s.ref as { repo: RepoRec; issue: IssueRec };
      return obj('IssueCommentConnection', {
        nodes: issue.comments.map((comment) => obj('IssueComment', { repo, comment })),
        totalCount: issue.comments.length,
      });
    },
    createdAt: () => '2023-11-14T22:13:20Z',
    updatedAt: () => '2023-11-14T22:13:20Z',
    closedAt: (_c, s) => ((s.ref as { issue: IssueRec }).issue.state === 'closed' ? '2023-11-14T22:13:20Z' : null),
    url: () => '',
  },
  PullRequest: {
    id: (_c, s) => globalId('PullRequest', `${(s.ref as { repo: RepoRec }).repo.id}:${(s.ref as { pull: PullRec }).pull.number}`),
    number: (_c, s) => (s.ref as { pull: PullRec }).pull.number,
    title: (_c, s) => (s.ref as { pull: PullRec }).pull.title,
    body: (_c, s) => (s.ref as { pull: PullRec }).pull.body,
    state: (_c, s) => {
      const pull = (s.ref as { pull: PullRec }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_c, s) => (s.ref as { pull: PullRec }).pull.merged,
    mergedAt: (_c, s) => (s.ref as { pull: PullRec }).pull.mergedAt,
    headRefName: (_c, s) => (s.ref as { pull: PullRec }).pull.head,
    baseRefName: (_c, s) => (s.ref as { pull: PullRec }).pull.base,
    headRef: (_c, s) => obj('Ref', { name: (s.ref as { pull: PullRec }).pull.head }),
    baseRef: (_c, s) => obj('Ref', { name: (s.ref as { pull: PullRec }).pull.base }),
    mergeable: (ctx, s) => {
      const { repo, pull } = s.ref as { repo: RepoRec; pull: PullRec };
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      const headSha = repo.refs.get(`refs/heads/${pull.head}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
      if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
      const headCommit = ctx.forge.peelToCommit(headSha);
      const baseCommit = ctx.forge.peelToCommit(baseSha);
      if (headCommit === null || baseCommit === null) return 'UNKNOWN';
      const base = ctx.forge.mergeBase(baseCommit, headCommit);
      if (base === null) return 'UNKNOWN';
      const baseInfo = ctx.forge.commitInfo(base);
      const oursInfo = ctx.forge.commitInfo(baseCommit);
      const theirsInfo = ctx.forge.commitInfo(headCommit);
      if (baseInfo === null || oursInfo === null || theirsInfo === null) return 'UNKNOWN';
      // Reuse the REST merge's conflict rule without mutating anything.
      const files = pullFiles(ctx.forge, repo, pull);
      void files;
      const merged = mergeTreesProbe(ctx.forge, baseInfo.tree, oursInfo.tree, theirsInfo.tree);
      return merged ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (ctx, s, args) => {
      const { repo, pull } = s.ref as { repo: RepoRec; pull: PullRec };
      const files = pullFiles(ctx.forge, repo, pull);
      const nodes = files.map((file) => obj('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions }));
      return obj('PullRequestChangedFileConnection', paginate(nodes, args));
    },
    additions: (ctx, s) => pullFiles(ctx.forge, (s.ref as { repo: RepoRec }).repo, (s.ref as { pull: PullRec }).pull).reduce((sum, f) => sum + f.additions, 0),
    deletions: (ctx, s) => pullFiles(ctx.forge, (s.ref as { repo: RepoRec }).repo, (s.ref as { pull: PullRec }).pull).reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: (ctx, s) => pullFiles(ctx.forge, (s.ref as { repo: RepoRec }).repo, (s.ref as { pull: PullRec }).pull).length,
    author: (_c, s) => obj('User', { login: (s.ref as { repo: RepoRec }).repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    repository: (_c, s) => obj('Repository', (s.ref as { repo: RepoRec }).repo),
    comments: () => obj('IssueCommentConnection', { nodes: [], totalCount: 0 }),
    createdAt: () => '2023-11-14T22:13:20Z',
    updatedAt: () => '2023-11-14T22:13:20Z',
    closedAt: (_c, s) => ((s.ref as { pull: PullRec }).pull.state === 'closed' ? '2023-11-14T22:13:20Z' : null),
    url: () => '',
  },
  IssueComment: {
    id: (_c, s) => globalId('IssueComment', String((s.ref as { comment: { id: number } }).comment.id)),
    body: (_c, s) => (s.ref as { comment: { body: string } }).comment.body,
    author: (_c, s) => obj('User', { login: (s.ref as { repo: RepoRec }).repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }),
    createdAt: () => '2023-11-14T22:13:20Z',
    url: () => '',
  },
  Label: {
    name: (_c, s) => (s.ref as { name: string }).name,
    color: (_c, s) => (s.ref as { color: string }).color,
    id: (_c, s) => globalId('Label', (s.ref as { name: string }).name),
  },
  PageInfo: {
    hasNextPage: (_c, s) => (s.ref as Connection).hasNextPage,
    hasPreviousPage: () => false,
    startCursor: (_c, s) => (s.ref as Connection).startCursor,
    endCursor: (_c, s) => (s.ref as Connection).endCursor,
  },
  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  PullRequestChangedFileConnection: connectionResolvers(),
  LabelConnection: connectionResolvers(),
  IssueCommentConnection: connectionResolvers(),
  PullRequestChangedFile: {
    path: (_c, s) => (s.ref as { path: string }).path,
    additions: (_c, s) => (s.ref as { additions: number }).additions,
    deletions: (_c, s) => (s.ref as { deletions: number }).deletions,
  },
  CreateIssuePayload: {
    issue: (_c, s) => (s.ref as { issue: GObj }).issue,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (_c, s) => (s.ref as { issue: GObj }).issue,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_c, s) => (s.ref as { pull: GObj }).pull,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (_c, s) => (s.ref as { pull: GObj }).pull,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (_c, s) => obj('IssueCommentEdge', { node: (s.ref as { comment: GObj }).comment }),
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (_c, s) => (s.ref as { node: GObj }).node,
    cursor: () => cursorOf(0),
  },
  __Type: {
    name: (_c, s) => (s.ref as { name: string }).name,
    kind: (_c, s) => (s.ref as { def: { kind: string } }).def.kind,
    description: () => null,
    fields: (_c, s) => {
      const def = (s.ref as { def: { fields?: string[] } }).def;
      return (def.fields ?? []).map((name) => obj('__Field', { name }));
    },
    enumValues: (_c, s) => {
      const def = (s.ref as { def: { enumValues?: string[] } }).def;
      return (def.enumValues ?? []).map((name) => obj('__EnumValue', { name }));
    },
  },
  __Field: {
    name: (_c, s) => (s.ref as { name: string }).name,
    description: () => null,
  },
  __EnumValue: {
    name: (_c, s) => (s.ref as { name: string }).name,
    description: () => null,
  },
};

function connectionResolvers(): Record<string, Resolver> {
  return {
    nodes: (_c, s) => (s.ref as Connection).nodes ?? (s.ref as { nodes: GObj[] }).nodes,
    edges: (_c, s) => {
      const conn = s.ref as Connection;
      return (conn.nodes ?? []).map((node) => obj('Edge', { node, cursor: conn.endCursor }));
    },
    pageInfo: (_c, s) => obj('PageInfo', s.ref),
    totalCount: (_c, s) => (s.ref as Connection).totalCount ?? (s.ref as { totalCount: number }).totalCount,
  };
}

/** Conflict probe identical to rest.mergePull's tree merge, without side effects. */
function mergeTreesProbe(forge: Forge, baseTree: string, oursTree: string, theirsTree: string): boolean {
  const base = forge.flattenTree(baseTree);
  const ours = forge.flattenTree(oursTree);
  const theirs = forge.flattenTree(theirsTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t || b === o || b === t) continue;
    return false;
  }
  return true;
}

// --------------------------------------------------------------------------- execution

function executeSelectionSet(ctx: Ctx, type: string, source: GObj, selections: Selection[], out: Record<string, unknown>): void {
  for (const selection of selections) {
    if (selection.type === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) executeSelectionSet(ctx, type, source, fragment, out);
      continue;
    }
    if (selection.type === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === type || (type === 'Repository' && selection.typeCondition === 'Node')) {
        executeSelectionSet(ctx, type, source, selection.selection, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = type;
      continue;
    }
    const resolver = RESOLVERS[type]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(ctx, source, argsOf(selection, ctx));
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection);
  }
}

function completeValue(ctx: Ctx, value: unknown, selection: Extract<Selection, { type: 'field' }>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const gobj = value as GObj;
    if (selection.selection === undefined) return null;
    const out: Record<string, unknown> = {};
    executeSelectionSet(ctx, gobj.__type, gobj, selection.selection, out);
    return out;
  }
  return value;
}

export interface GraphQLReply {
  status: number;
  payload: unknown;
}

/** Execute one HTTP body (a single operation object, or an array for batching). */
export function executeGraphQL(forge: Forge, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(forge, entry));
    return { status: 200, payload: results };
  }
  const result = executeOne(forge, body);
  return { status: 200, payload: result };
}

function executeOne(forge: Forge, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid GraphQL request' }] };
  const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query === '') return { errors: [{ message: 'No GraphQL query provided' }] };
  let document: { operations: Operation[]; fragments: Map<string, Selection[]> };
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Parse error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operation =
    document.operations.find((op) => typeof operationName === 'string' && op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = {
    forge,
    variables: typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  executeSelectionSet(ctx, rootType, obj(rootType, null), operation.selection, data);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return payload;
}
