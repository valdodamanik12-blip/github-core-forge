// Git object model: sha1 ids, tree/commit/tag parse and build, packfile read (with
// ofs-delta and ref-delta resolution) and write (plain objects), and the pkt-line codec.
// Node stdlib only (node:crypto, node:zlib). No git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_BY_CODE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a typed payload: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // "100644", "100755", "120000", "40000" (dir, as stored: no leading zero)
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The commit oid a tag object points at (following nested tags), or null. */
export function parseTagTarget(data: Buffer): { object: string; type: string } | null {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return object === '' ? null : { object, type };
}

// --------------------------------------------------------------------------- packfiles

/**
 * Inflate one zlib stream starting at `pos`, returning the data and the offset just past
 * the stream. inflateSync throws on a truncated stream and ignores trailing bytes, so the
 * consumed length is found by exponential bracketing + binary search for the smallest
 * prefix that inflates. Streams in a pack are small; this is a handful of inflations.
 */
function inflateAt(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; next: number } {
  const remaining = buf.length - pos;
  if (remaining <= 0) throw new Error('pack truncated before object data');
  const tryLen = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(pos, pos + len));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  // A complete stream must inflate; anything shorter throws. Bracket the end.
  let lo = 1;
  let hi = Math.min(remaining, Math.max(64, expectedSize + 64));
  let out = tryLen(hi);
  while (out === null && hi < remaining) {
    lo = hi + 1;
    hi = Math.min(remaining, hi * 2);
    out = tryLen(hi);
  }
  if (out === null) {
    // hi === remaining and it still failed: the stream is corrupt or the size lied.
    const full = tryLen(remaining);
    if (full === null) throw new Error('pack object does not inflate');
    return { data: full, next: buf.length };
  }
  // Binary search the smallest inflating prefix in (lo-1, hi].
  let low = lo - 1; // known bad (or 0)
  let high = hi; // known good
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (tryLen(mid) !== null) high = mid;
    else low = mid;
  }
  const data = tryLen(high);
  if (data === null) throw new Error('pack object does not inflate');
  return { data, next: pos + high };
}

/** Apply a git delta (from a pack ofs/ref delta) to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta truncated');
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= delta[pos] << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= delta[pos] << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a whole packfile into resolved objects. `resolveExternal(oid)` may supply a base
 * object the pack deltas against but does not carry (a thin pack); may be omitted.
 * Throws on any malformation — callers treat a bad pack as a refused push / failed read.
 */
export function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const bodyHash = sha1Hex(pack.subarray(0, pack.length - 20));
  if (Buffer.from(bodyHash, 'hex').compare(trailer) !== 0) throw new Error('pack checksum mismatch');

  const objects = new Map<string, GitObject>();
  const pending: Array<{ start: number; baseOid?: string; baseOffset?: number; delta: Buffer }> = [];
  const byOffset = new Map<number, string>();
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const start = pos;
    let byte = pack[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: negative offset varint to the base object's start
      let b = pack[pos];
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack, pos, size);
      pos = inflated.next;
      pending.push({ start, baseOffset: start - offset, delta: inflated.data });
    } else if (typeCode === 7) {
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const inflated = inflateAt(pack, pos, size);
      pos = inflated.next;
      pending.push({ start, baseOid, delta: inflated.data });
    } else {
      const type = TYPE_BY_CODE[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode}`);
      const inflated = inflateAt(pack, pos, size);
      pos = inflated.next;
      const oid = hashObject(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      byOffset.set(start, oid);
    }
  }

  // Resolve deltas in dependency order (a delta's base may itself be a delta).
  const queue = pending.map((entry) => ({ ...entry }));
  let guard = queue.length * queue.length + 16;
  while (queue.length > 0) {
    if (guard-- <= 0) throw new Error('delta chain too deep');
    const entry = queue.shift()!;
    let baseOid = entry.baseOid;
    if (baseOid === undefined && entry.baseOffset !== undefined) baseOid = byOffset.get(entry.baseOffset);
    if (baseOid === undefined) throw new Error('delta base offset unknown');
    let base = objects.get(baseOid);
    if (base === undefined && resolveExternal !== undefined) base = resolveExternal(baseOid);
    if (base === undefined) {
      queue.push(entry);
      continue;
    }
    const data = applyDelta(base.data, entry.delta);
    const oid = hashObject(base.type, data);
    objects.set(oid, { type: base.type, data });
    // A later ofs-delta may name this object by the offset of the delta entry itself.
    byOffset.set(entry.start, oid);
  }
  return { objects, count };
}

/** Build a packfile of plain (non-delta) objects, with the sha1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = CODE_BY_TYPE[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    let head = (code << 4) | first;
    if (size > 0) head |= 0x80;
    bytes.push(head);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// --------------------------------------------------------------------------- pkt-line

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Parse a complete pkt-line stream; tolerant of a truncated tail (stops there). */
export function parsePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Split a request body into the pkt-line prefix and the raw bytes after the flush. */
export function splitPktBody(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      return { packets, rest: buf.subarray(pos) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, rest: buf.subarray(pos) };
}
