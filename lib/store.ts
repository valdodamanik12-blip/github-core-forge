// The forge's single in-memory store: git objects, repositories, and per-repo
// issues / pull requests / labels. REST, GraphQL and MCP all read and write through
// this module, so the surfaces can never disagree. Deterministic: timestamps come
// from a fixed epoch plus a counter, never the wall clock.

import {
  buildCommit,
  buildTree,
  hashObject,
  isTreeMode,
  parseCommit,
  parseTagTarget,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
const EPOCH_SEC = 1_700_000_000;

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headShaFallback: string;
  baseShaFallback: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  priv: boolean;
  description: string;
  refs: Map<string, string>; // full refname -> commit/tag oid
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number; // shared issue/PR counter (GitHub semantics)
}

export class Forge {
  objects = new Map<string, GitObject>();
  repos = new Map<string, RepoRec>(); // "owner/name" (names are case-sensitive here)
  private nextRepoId = 1;
  private nextCommentId = 1;
  private seq = 0;

  /** A deterministic, strictly increasing timestamp (seconds) for authored commits. */
  nextTimestamp(): number {
    this.seq += 1;
    return EPOCH_SEC + this.seq;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  isoNow(): string {
    return new Date(this.nextTimestamp() * 1000).toISOString();
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  // ------------------------------------------------------------- objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Follow a tag chain to the commit it ultimately names, or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      const target = parseTagTarget(object.data);
      if (target === null) return null;
      current = target.object;
    }
    return null;
  }

  commitInfo(oid: string) {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** All commits reachable from `tip` (inclusive), breadth-first, newest first. */
  commitHistory(tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const info = this.commitInfo(oid);
      if (info === null) continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of info.parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commitInfo(oid);
      if (info === null) continue;
      for (const parent of info.parents) queue.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits (first BFS hit), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set(this.commitHistory(a));
    for (const candidate of this.commitHistory(b)) {
      if (ancestorsOfA.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Every object (commits, trees, blobs, tags) reachable from the given tips,
   * optionally stopping at commits in `stopCommits` (their whole closure excluded),
   * and optionally limited to commits within `maxDepth` generations of a tip.
   * Returns the object id set plus the boundary commits (included commits with a
   * parent that was cut by the depth limit).
   */
  closure(
    tips: readonly string[],
    options: { stopCommits?: ReadonlySet<string>; cutCommits?: ReadonlySet<string>; maxDepth?: number } = {},
  ): { objects: Set<string>; boundary: Set<string> } {
    const objects = new Set<string>();
    const boundary = new Set<string>();
    const stop = options.stopCommits ?? new Set<string>();
    const cut = options.cutCommits ?? new Set<string>();
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    // Commit BFS with depths.
    const depthOf = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(tip);
      if (commit !== null) queue.push({ oid: commit, depth: 1 });
      if (this.objects.get(tip)?.type === 'tag') objects.add(tip);
    }
    const includedCommits: string[] = [];
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (stop.has(oid)) continue;
      const known = depthOf.get(oid);
      if (known !== undefined && known <= depth) continue;
      depthOf.set(oid, depth);
      const info = this.commitInfo(oid);
      if (info === null) continue;
      includedCommits.push(oid);
      if (cut.has(oid)) continue; // a shallow boundary: the commit counts, its history does not
      for (const parent of info.parents) {
        if (depth < maxDepth) queue.push({ oid: parent, depth: depth + 1 });
        else if (!stop.has(parent) && this.commitInfo(parent) !== null) boundary.add(oid);
      }
    }
    // Trees and blobs of included commits.
    const addTree = (treeOid: string): void => {
      if (objects.has(treeOid) || stop.has(treeOid)) return;
      const object = this.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return;
      objects.add(treeOid);
      for (const entry of parseTree(object.data)) {
        if (isTreeMode(entry.mode)) addTree(entry.oid);
        else objects.add(entry.oid);
      }
    };
    for (const oid of includedCommits) {
      objects.add(oid);
      const info = this.commitInfo(oid);
      if (info !== null) addTree(info.tree);
    }
    // Tags pointing at included commits are not auto-included; callers add tip tags
    // above. Remove anything that belongs to the stop closure's trees is unnecessary:
    // stop trees are only excluded when named in stopCommits' own closure — handled by
    // the caller passing object-level exclusions separately (see gitproto fetch).
    return { objects, boundary };
  }

  /** Flatten a tree (recursively) into path -> {mode, oid}. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Rebuild nested trees from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Dir {
      files: TreeEntry[];
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let next = dir.dirs.get(parts[i]);
        if (next === undefined) {
          next = { files: [], dirs: new Map() };
          dir.dirs.set(parts[i], next);
        }
        dir = next;
      }
      dir.files.push({ mode: entry.mode, name: parts[parts.length - 1], oid: entry.oid });
    }
    const emit = (dir: Dir): string => {
      const entries: TreeEntry[] = [...dir.files];
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
      return this.putObject('tree', buildTree(entries));
    };
    return emit(root);
  }

  /** Author a commit on top of `parent` (or a root commit) with a full flat tree. */
  authorCommit(options: {
    tree: string;
    parents: string[];
    message: string;
  }): string {
    const ts = this.nextTimestamp();
    const identity = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    const data = buildCommit({
      tree: options.tree,
      parents: options.parents,
      author: identity,
      committer: identity,
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
    });
    return this.putObject('commit', data);
  }

  // ------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, priv: boolean, description: string): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      priv,
      description,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }

  /** The default branch tip commit oid, or null when the repo is unborn. */
  defaultTip(repo: RepoRec): string | null {
    return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
  }

  /** The tree oid at a ref (branch name or full ref or commit oid), or null. */
  treeAtRef(repo: RepoRec, ref: string): { commit: string; tree: string } | null {
    let oid: string | undefined;
    if (repo.refs.has(ref)) oid = repo.refs.get(ref);
    else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
    else if (this.objects.has(ref)) oid = ref;
    if (oid === undefined) return null;
    const commit = this.peelToCommit(oid);
    if (commit === null) return null;
    const info = this.commitInfo(commit);
    if (info === null) return null;
    return { commit, tree: info.tree };
  }
}
