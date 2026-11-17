// REST v3 surface, plus the shared repository/issue/pull-request operations that the
// GraphQL and MCP surfaces reuse (one store, one behaviour). Handlers return
// {status, body, headers?}; app.ts serializes. Every error body carries a `message`.

import { isTreeMode, parseTree } from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  VIEWER,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
export const err = (status: number, message: string): RestReply => ({ status, body: { message } });
const notFound = (): RestReply => err(404, 'Not Found');

// --------------------------------------------------------------------------- ids (GraphQL global ids)

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { type: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.priv,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    fork: false,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
    pushed_at: '2023-11-14T22:13:20Z',
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issueDbId(repo, issue.number),
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
    closed_at: issue.state === 'closed' ? '2023-11-14T22:13:20Z' : null,
  };
}

/** A stable numeric id for an issue/PR record (REST `id`, distinct from its number). */
export function issueDbId(repo: RepoRec, number: number): number {
  return repo.id * 1_000_000 + number;
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headShaFallback;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseShaFallback;
  return {
    id: issueDbId(repo, pull.number),
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
    closed_at: pull.state === 'closed' ? '2023-11-14T22:13:20Z' : null,
  };
}

// --------------------------------------------------------------------------- shared operations

export function createIssueRec(repo: RepoRec, title: string, body: string, labels: string[], seq: number): IssueRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = { number, title, body, state: 'open', labels: [...labels], comments: [], seq };
  repo.issues.set(number, issue);
  return issue;
}

export interface PullCreateResult {
  pull?: PullRec;
  error?: RestReply;
}

export function createPullRec(forge: Forge, repo: RepoRec, input: { title: string; body: string; head: string; base: string }, seq: number): PullCreateResult {
  const head = input.head.includes(':') ? input.head.slice(input.head.indexOf(':') + 1) : input.head;
  const base = input.base.includes(':') ? input.base.slice(input.base.indexOf(':') + 1) : input.base;
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return { error: err(422, `Head ref ${head} does not exist`) };
  if (baseSha === undefined) return { error: err(422, `Base ref ${base} does not exist`) };
  if (head === base) return { error: err(422, 'Head and base refs are the same') };
  const headCommit = forge.peelToCommit(headSha);
  const baseCommit = forge.peelToCommit(baseSha);
  if (headCommit === null || baseCommit === null) return { error: err(422, 'Head or base is not a commit') };
  if (headCommit === baseCommit || forge.isAncestor(headCommit, baseCommit)) {
    return { error: err(422, `No commits between ${base} and ${head}`) };
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return { error: err(422, `A pull request already exists for ${head} into ${base}`) };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    head,
    base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headShaFallback: headSha,
    baseShaFallback: baseSha,
    seq,
  };
  repo.pulls.set(number, pull);
  return { pull };
}

/** Line multiset difference counts between two file contents. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const lines = (text: string): string[] => {
    if (text === '') return [];
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const counts = new Map<string, number>();
  for (const line of lines(oldText)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of lines(newText)) {
    const available = counts.get(line) ?? 0;
    if (available > 0) counts.set(line, available - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const value of counts.values()) deletions += value;
  return { additions, deletions };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: merge-base tree -> head tree. */
export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): FileChange[] {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (headSha === undefined || baseSha === undefined) return [];
  const headCommit = forge.peelToCommit(headSha);
  const baseCommit = forge.peelToCommit(baseSha);
  if (headCommit === null || baseCommit === null) return [];
  const mergeBase = forge.mergeBase(baseCommit, headCommit) ?? baseCommit;
  const baseInfo = forge.commitInfo(mergeBase);
  const headInfo = forge.commitInfo(headCommit);
  if (baseInfo === null || headInfo === null) return [];
  const baseFlat = forge.flattenTree(baseInfo.tree);
  const headFlat = forge.flattenTree(headInfo.tree);
  const text = (oid: string): string => forge.getObject(oid)?.data.toString('utf8') ?? '';
  const changes: FileChange[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    if (before === undefined && after !== undefined) {
      const { additions } = lineDiff('', text(after.oid));
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after === undefined) {
      const { deletions } = lineDiff(text(before.oid), '');
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before !== undefined && after !== undefined) {
      const { additions, deletions } = lineDiff(text(before.oid), text(after.oid));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/**
 * Three-way tree merge. Returns the merged flat map, or null on conflict
 * (both sides changed the same path differently, or changed vs deleted).
 */
export function mergeTrees(
  base: ReadonlyMap<string, { mode: string; oid: string }>,
  ours: ReadonlyMap<string, { mode: string; oid: string }>,
  theirs: ReadonlyMap<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return null;
    }
  }
  return merged;
}

export type MergeOutcome =
  | { merged: true; sha: string }
  | { merged: false; status: number; message: string };

/** Squash-merge a pull request onto its base branch (shared by REST/GraphQL/MCP). */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec): MergeOutcome {
  if (pull.merged) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  if (pull.state !== 'open') return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  const headSha = repo.refs.get(`refs/heads/${pull.head}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
  if (headSha === undefined || baseSha === undefined) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  const headCommit = forge.peelToCommit(headSha);
  const baseCommit = forge.peelToCommit(baseSha);
  if (headCommit === null || baseCommit === null) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  if (forge.isAncestor(headCommit, baseCommit)) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  const mergeBase = forge.mergeBase(baseCommit, headCommit);
  if (mergeBase === null) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  const baseInfo = forge.commitInfo(mergeBase);
  const oursInfo = forge.commitInfo(baseCommit);
  const theirsInfo = forge.commitInfo(headCommit);
  if (baseInfo === null || oursInfo === null || theirsInfo === null) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  const mergedFlat = mergeTrees(forge.flattenTree(baseInfo.tree), forge.flattenTree(oursInfo.tree), forge.flattenTree(theirsInfo.tree));
  if (mergedFlat === null) return { merged: false, status: 405, message: 'Pull Request is not mergeable' };
  const tree = forge.buildTreeFromFlat(mergedFlat);
  const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
  const sha = forge.authorCommit({ tree, parents: [baseCommit], message });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.isoNow();
  pull.mergeCommitSha = sha;
  return { merged: true, sha };
}

// --------------------------------------------------------------------------- the REST router

export interface RestRequest {
  method: string;
  segments: string[]; // decoded path segments after /api/v3
  query: URLSearchParams;
  body: unknown; // parsed JSON body, or undefined when absent
  bodyError: boolean; // a body was present but not valid JSON
  host: string; // request Host header, for absolute pagination links
}

function repoOr404(forge: Forge, owner: string, name: string): RepoRec | RestReply {
  if (owner !== VIEWER.login) return notFound();
  return forge.getRepo(owner, name) ?? notFound();
}

function isReply(value: RepoRec | RestReply): value is RestReply {
  return (value as RestReply).status !== undefined;
}

export function routeRest(forge: Forge, req: RestRequest): RestReply {
  const seg = req.segments;
  const { method } = req;
  if (req.bodyError && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    return err(400, 'Problems parsing JSON');
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  // Root and meta (public, like GitHub).
  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org, user' },
    );
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return ok(200, { installed_version: 'forge-1.0.0', verifiable_password_authentication: false });
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return notFound();
    return ok(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false });
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') return listUserRepos(forge, req);
    if (method === 'POST') return createUserRepo(forge, body);
    return notFound();
  }
  if (seg.length >= 3 && seg[0] === 'repos') {
    const found = repoOr404(forge, seg[1], seg[2]);
    if (isReply(found)) return found;
    return routeRepo(forge, req, found, seg.slice(3), body);
  }
  return notFound();
}

function createUserRepo(forge: Forge, body: Record<string, unknown>): RestReply {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || name.includes('/') || name === '.' || name === '..') {
    return err(422, 'Repository creation failed: name is invalid');
  }
  if (forge.getRepo(VIEWER.login, name) !== undefined) {
    return err(422, 'Repository creation failed: name already exists on this account');
  }
  const priv = typeof body.private === 'boolean' ? body.private : false;
  const description = typeof body.description === 'string' ? body.description : '';
  const repo = forge.createRepo(VIEWER.login, name, priv, description);
  return ok(201, repoJson(repo));
}

function listUserRepos(forge: Forge, req: RestRequest): RestReply {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const all = forge.reposOf(VIEWER.login);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage).map(repoJson);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const base = `http://${req.host}/api/v3/user/repos`;
    const lastPage = Math.ceil(all.length / perPage);
    headers.link =
      `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next", ` +
      `<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`;
  }
  return ok(200, items, headers);
}

function routeRepo(forge: Forge, req: RestRequest, repo: RepoRec, rest: string[], body: Record<string, unknown>): RestReply {
  const { method } = req;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        // Rename: keep the same record under the new key.
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = body.name;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  // ---- git data
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || forge.getObject(sha) === undefined) return err(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, node_id: globalId('GitRef', `${repo.id}:${ref}`), object: { sha, type: forge.getObject(sha)?.type ?? 'commit' }, url: '' });
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        return ok(200, [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })));
      }
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
      if (sha === undefined) return notFound();
      const full = repo.refs.has(ref) ? ref : `refs/${ref}`;
      return ok(200, { ref: full, object: { sha, type: forge.getObject(sha)?.type ?? 'commit' } });
    }
    return notFound();
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return ok(200, branches);
    }
    if (method === 'GET' && rest.length >= 2) {
      const name = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) return notFound();
      return ok(200, { name, commit: { sha }, protected: false });
    }
    return notFound();
  }

  // ---- commits
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    const shaParam = req.query.get('sha');
    let tip: string | null = null;
    if (shaParam === null || shaParam === '') tip = forge.defaultTip(repo);
    else {
      const at = forge.treeAtRef(repo, shaParam);
      tip = at?.commit ?? (forge.getObject(shaParam)?.type === 'commit' ? shaParam : null);
    }
    if (tip === null) return ok(200, []);
    const history = forge.commitHistory(tip);
    const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '30', 10);
    const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : 30;
    return ok(
      200,
      history.slice(0, perPage).map((oid) => {
        const info = forge.commitInfo(oid)!;
        return {
          sha: oid,
          commit: {
            message: info.message.replace(/\n$/, ''),
            author: parseIdentity(info.author),
            committer: parseIdentity(info.committer),
            tree: { sha: info.tree },
          },
          parents: info.parents.map((parent) => ({ sha: parent })),
        };
      }),
    );
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(forge, repo, path, req.query.get('ref'));
    if (method === 'PUT') return putContents(forge, repo, path, body);
    if (method === 'DELETE') return deleteContents(forge, repo, path, body);
    return notFound();
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = str(body.name);
      if (name === '') return err(422, 'Invalid label name');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const color = str(body.color) || 'ededed';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color, default: false });
    }
    if (method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
    }
    return notFound();
  }

  // ---- issues and comments
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssueRoute(forge, repo, body);
      if (method === 'GET') return listIssuesRoute(repo, req);
      return notFound();
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((x): x is string => typeof x === 'string');
          for (const name of names) if (!repo.labels.has(name)) return err(422, `Label ${name} does not exist`);
          issue.labels = names;
        }
        return ok(200, issueJson(repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'POST') {
        const text = str(body.body);
        const comment = { id: forge.allocCommentId(), body: text, seq: forge.nextSeq() };
        issue.comments.push(comment);
        return ok(201, { id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER.id }, created_at: '2023-11-14T22:13:20Z' });
      }
      if (method === 'GET') {
        return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER.id }, created_at: '2023-11-14T22:13:20Z' })));
      }
      return notFound();
    }
    return notFound();
  }

  // ---- pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = str(body.title);
        const head = str(body.head);
        const base = str(body.base) || DEFAULT_BRANCH;
        if (title === '' || head === '') return err(422, 'Invalid pull request');
        const result = createPullRec(forge, repo, { title, body: str(body.body), head, base }, forge.nextSeq());
        if (result.error !== undefined) return result.error;
        return ok(201, pullJson(forge, repo, result.pull!));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        return ok(200, pulls.map((pull) => pullJson(forge, repo, pull)));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return ok(200, pullJson(forge, repo, pull));
      if (method === 'PATCH') {
        if (body.state === 'closed' || body.state === 'open') {
          if (!(body.state === 'open' && pull.merged)) pull.state = body.state;
        }
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        return ok(200, pullJson(forge, repo, pull));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return ok(200, pullFiles(forge, repo, pull).map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes, sha: '' })));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const outcome = mergePull(forge, repo, pull);
      if (!outcome.merged) return err(outcome.status, outcome.message);
      return ok(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '2023-11-14T22:13:20Z' };
  return { name: match[1], email: match[2], date: new Date(Number.parseInt(match[3], 10) * 1000).toISOString() };
}

// --------------------------------------------------------------------------- contents

function contentsTarget(forge: Forge, repo: RepoRec, branch: string | undefined): { refName: string; commit: string | null; tree: string | null } {
  const refName = `refs/heads/${branch ?? DEFAULT_BRANCH}`;
  const oid = repo.refs.get(refName);
  if (oid === undefined) return { refName, commit: null, tree: null };
  const at = forge.treeAtRef(repo, refName);
  return { refName, commit: at?.commit ?? null, tree: at?.tree ?? null };
}

function getContents(forge: Forge, repo: RepoRec, path: string, ref: string | null): RestReply {
  const target = contentsTarget(forge, repo, ref ?? undefined);
  if (target.tree === null) return notFound();
  const flat = forge.flattenTree(target.tree);
  if (path === '') {
    return ok(200, dirListing(forge, flat, ''));
  }
  const entry = flat.get(path);
  if (entry !== undefined) {
    const data = forge.getObject(entry.oid)?.data ?? Buffer.alloc(0);
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      size: data.length,
    });
  }
  // Directory?
  const prefix = `${path}/`;
  const isDir = [...flat.keys()].some((key) => key.startsWith(prefix));
  if (isDir) return ok(200, dirListing(forge, flat, path));
  return notFound();
}

function dirListing(forge: Forge, flat: Map<string, { mode: string; oid: string }>, dir: string): unknown[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) {
        const subTree = treeOidAt(forge, flat, prefix + name);
        entries.set(name, { type: 'dir', name, path: prefix + name, sha: subTree ?? '' });
      }
    }
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The tree oid of a directory prefix inside a flattened tree (recomputed from the root tree). */
function treeOidAt(forge: Forge, flat: Map<string, { mode: string; oid: string }>, dirPath: string): string | null {
  // Rebuild: find the root tree by rebuilding the flat map is overkill; instead the
  // caller passes listings only for display, and a dir's sha is informational. We
  // recompute the subtree oid by building a tree of just that directory's entries.
  const sub = new Map<string, { mode: string; oid: string }>();
  const prefix = `${dirPath}/`;
  for (const [path, entry] of flat) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), entry);
  }
  if (sub.size === 0) return null;
  return forge.buildTreeFromFlat(sub);
}

function putContents(forge: Forge, repo: RepoRec, path: string, body: Record<string, unknown>): RestReply {
  if (path === '') return err(422, 'Invalid path');
  const message = typeof body.message === 'string' ? body.message : 'update';
  const contentB64 = typeof body.content === 'string' ? body.content : null;
  if (contentB64 === null) return err(422, 'content is required');
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const target = contentsTarget(forge, repo, branch);
  const flat = target.tree !== null ? forge.flattenTree(target.tree) : new Map<string, { mode: string; oid: string }>();
  const existing = flat.get(path);
  const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined) {
    if (providedSha === undefined) return err(422, 'sha must be supplied when updating');
    if (providedSha !== existing.oid) return err(409, 'Conflict: the file sha does not match');
  } else if (providedSha !== undefined) {
    return err(422, 'sha supplied for a file that does not exist');
  }
  const blobOid = forge.putObject('blob', data);
  flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const tree = forge.buildTreeFromFlat(flat);
  const parents = target.commit !== null ? [target.commit] : [];
  const commit = forge.authorCommit({ tree, parents, message });
  repo.refs.set(target.refName, commit);
  const status = existing !== undefined ? 200 : 201;
  return ok(status, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit, message },
  });
}

function deleteContents(forge: Forge, repo: RepoRec, path: string, body: Record<string, unknown>): RestReply {
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const target = contentsTarget(forge, repo, branch);
  if (target.tree === null || target.commit === null) return notFound();
  const flat = forge.flattenTree(target.tree);
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  const providedSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (providedSha !== undefined && providedSha !== existing.oid) return err(409, 'Conflict: the file sha does not match');
  flat.delete(path);
  const tree = forge.buildTreeFromFlat(flat);
  const commit = forge.authorCommit({ tree, parents: [target.commit], message });
  repo.refs.set(target.refName, commit);
  return ok(200, { content: null, commit: { sha: commit, message } });
}

// --------------------------------------------------------------------------- issues routes

function createIssueRoute(forge: Forge, repo: RepoRec, body: Record<string, unknown>): RestReply {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return err(422, 'Invalid issue title');
  const labels: string[] = [];
  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      const name = typeof entry === 'string' ? entry : typeof (entry as { name?: unknown })?.name === 'string' ? (entry as { name: string }).name : '';
      if (name === '' || !repo.labels.has(name)) return err(422, `Label ${name} does not exist`);
      labels.push(name);
    }
  }
  const issue = createIssueRec(repo, title, typeof body.body === 'string' ? body.body : '', labels, forge.nextSeq());
  return ok(201, issueJson(repo, issue));
}

function listIssuesRoute(repo: RepoRec, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => (sort === 'created' ? a.seq - b.seq : a.number - b.number));
  if (direction === 'desc') issues.reverse();
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : 30;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  return ok(200, issues.slice(start, start + perPage).map((issue) => issueJson(repo, issue)));
}
