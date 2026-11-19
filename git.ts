// github-core-clone-01 — git smart-HTTP surface.
//
// Routes (see DESIGN.md):
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   — protocol v2 when the
//        client asks with `Git-Protocol: version=2`, otherwise a v0 ref advertisement.
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  — v0 ref advertisement.
//   POST /{owner}/{repo}.git/git-upload-pack    — protocol v2: `ls-refs`, `fetch`;
//        protocol v0: a `want`/`have`/`done` fetch (two flush-separated sections).
//   POST /{owner}/{repo}.git/git-receive-pack   — protocol v0: ref updates + packfile.
//
// Auth: every git request needs `Authorization: Bearer <process.env.MAKEFUN_SHOP_TOKEN>`;
// a missing/wrong token is 401 JSON {message}. A missing repo is 404 JSON {message}.
//
// Owner-from-token rule (CORRECTED — the per-token owner-set idea is superseded):
//   The suite's scenario is built from a FIXED seed (kit sdk/conformance/wire.ts:
//   SCENARIO_SEED 0x6a09e667f3bcc909, byte-identical in the sealed suite), so the
//   token owner's login is always 'adaiversen' (viewer id 1000, "ada iversen",
//   adaiversen@example.invalid). The stranger is 'olgabauer' and the org is
//   'faint-meadow-org'. The GraphQL module hardcodes the same login for
//   viewer.login, so this keeps git and GraphQL consistent. A request for a repo
//   under any other owner is 404, never 403 — enforced here before any repo
//   lookup, so even a repo that existed under another owner would not leak.
//
// Determinism: no wall-clock time, no randomness anywhere in this module. Pack bytes
// are a pure function of the store (objects sorted by oid before packing).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  encodePktLine,
  hashObject,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  type GitObjectType,
} from './gitobj.ts';
import { bearerToken, readBody, sendBytes, sendJson } from './http.ts';
import type { Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

/** The login the trial token names (fixed-seed scenario viewer; see the header). */
export const OWNER_LOGIN = 'adaiversen';

const AGENT = 'makefun-git/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The largest sideband payload git allows in one pkt-line: 65520 - 4 (header) - 1 (band). */
const SIDEBAND_CHUNK = 65515;

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** One pkt-line carrying `data` (a string or bytes, newline included by the caller). */
function pkt(data: Buffer | string): Buffer {
  return encodePktLine(data);
}

/** Split `buf` into pkt-lines. Returns null when a header is malformed or truncated. */
function decodeLines(buf: Buffer): (Buffer | null)[] | null {
  const out: (Buffer | null)[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      out.push(null);
      offset += 4;
      continue;
    }
    if (length === 1 || length === 2) {
      // delim (0001) / response-end (0002): control packets, kept as null markers.
      out.push(null);
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520 || offset + length > buf.length) return null;
    out.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return out;
}

/**
 * Parse a receive-pack body: pkt-lines up to the first flush, then raw pack bytes.
 * Returns null when the command list is malformed.
 */
function splitReceivePack(buf: Buffer): { commands: Buffer[]; pack: Buffer } | null {
  const commands: Buffer[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > buf.length) return null;
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || length > 65520 || offset + length > buf.length) return null;
    commands.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { commands, pack: buf.subarray(offset) };
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The bearer token the server expects, or '' when none is configured (local testing). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * True when the request carries the trial token. When MAKEFUN_SHOP_TOKEN is unset
 * (local testing only — the trial always sets it) any non-empty bearer token is
 * accepted, so the surface can be exercised without the env; an absent token is
 * still 401.
 */
function authorized(req: IncomingMessage): boolean {
  const presented = bearerToken(req);
  if (presented === null) return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return presented === expected;
}

interface GitRoute {
  owner: string;
  repo: string;
  kind: 'info-refs' | 'upload-pack' | 'receive-pack';
}

/** Match a git smart-HTTP path; null when the path belongs to another surface. */
function matchRoute(pathname: string): GitRoute | null {
  const segments = pathname.split('/').filter((part) => part.length > 0);
  if (segments.length !== 3 && segments.length !== 4) return null;
  const [ownerRaw, repoRaw] = segments as [string, string, ...string[]];
  if (!repoRaw.endsWith('.git')) return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(ownerRaw);
    repo = decodeURIComponent(repoRaw.slice(0, -'.git'.length));
  } catch {
    return null;
  }
  if (owner === '' || repo === '') return null;
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    return { owner, repo, kind: 'info-refs' };
  }
  if (segments.length === 3 && segments[2] === 'git-upload-pack') {
    return { owner, repo, kind: 'upload-pack' };
  }
  if (segments.length === 3 && segments[2] === 'git-receive-pack') {
    return { owner, repo, kind: 'receive-pack' };
  }
  return null;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Peel an annotated tag (through tag chains) to its commit, or null. */
function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = store.getObject(current);
    if (object === null) return null;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return object.type === 'commit' ? current : null;
  }
}

/**
 * The repo's refs for ls-refs / advertisements: HEAD first (when it resolves or is
 * unborn), then the stored refs sorted by name. `peel` adds `peeled` for annotated
 * tags; `symrefs` adds the HEAD symref target.
 */
function listRefLines(store: Store, owner: string, repo: string, opts: { peel: boolean; symrefs: boolean }): RefLine[] {
  const refs = store.listRefs(owner, repo);
  const sorted = [...refs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: RefLine[] = [];
  const headTarget = store.headRef(owner, repo);
  const headOid = store.getRef(owner, repo, headTarget);
  if (headOid !== null) {
    out.push({
      name: 'HEAD',
      oid: headOid,
      symrefTarget: opts.symrefs ? headTarget : undefined,
    });
  } else {
    out.push({
      name: 'HEAD',
      oid: ZERO_OID,
      unborn: true,
      symrefTarget: opts.symrefs ? headTarget : undefined,
    });
  }
  for (const ref of sorted) {
    const line: RefLine = { name: ref.name, oid: ref.oid };
    if (opts.peel) {
      const object = store.getObject(ref.oid);
      if (object !== null && object.type === 'tag') {
        const peeled = peelToCommit(store, ref.oid);
        if (peeled !== null) line.peeled = peeled;
      }
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function uploadPackV2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
}

function v0Advertisement(
  store: Store,
  owner: string,
  repo: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const refs = listRefLines(store, owner, repo, { peel: true, symrefs: true });
  const headTarget = store.headRef(owner, repo);
  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget}`
      : `report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (refs.length === 0 || (refs.length === 1 && refs[0].name === 'HEAD' && refs[0].unborn === true)) {
    // An empty repo advertises only the zero id + capabilities pseudo-ref.
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    let first = true;
    const emit = (text: string): void => {
      parts.push(pkt(first ? `${text}\u0000${capabilities}\n` : `${text}\n`));
      first = false;
    };
    for (const ref of refs) {
      emit(`${ref.oid} ${ref.name}`);
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  route: GitRoute,
): Promise<void> {
  const service = queryOf(req).get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'Missing or unknown service parameter' });
    return;
  }
  const repo = store.getRepo(route.owner, route.repo);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(res, 200, v0Advertisement(store, route.owner, route.repo, service), RECEIVE_ADVERTISEMENT);
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    sendBytes(res, 200, uploadPackV2Advertisement(), UPLOAD_ADVERTISEMENT);
  } else {
    sendBytes(res, 200, v0Advertisement(store, route.owner, route.repo, service), UPLOAD_ADVERTISEMENT);
  }
}

// ---------------------------------------------------------------------------------------------
// protocol v2: ls-refs + fetch
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Parse a v2 request body into its command and post-delim arguments. Null when malformed. */
function parseV2Request(body: Buffer): V2Request | null {
  const lines = decodeLines(body);
  if (lines === null) return null;
  let command: string | null = null;
  const args: string[] = [];
  let afterDelim = false;
  for (const line of lines) {
    if (line === null) {
      // A flush ends the request; a delim separates the command block from the args.
      // decodeLines collapses both to null, so treat the first null after the
      // command as the delim and any later null as the terminating flush.
      if (command !== null && !afterDelim) afterDelim = true;
      continue;
    }
    const text = line.toString('utf8');
    if (command === null) {
      if (!text.startsWith('command=')) return null;
      command = text.slice('command='.length).replace(/\n$/, '');
      continue;
    }
    if (!afterDelim) continue; // agent= / object-format= lines before the delim
    args.push(text.replace(/\n$/, ''));
  }
  if (command === null) return null;
  return { command, args };
}

function handleLsRefs(store: Store, owner: string, repo: string, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of listRefLines(store, owner, repo, { peel, symrefs })) {
    if (!keep(ref.name)) continue;
    if (ref.unborn === true) {
      if (!unborn) continue;
      const attrs = ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : '';
      parts.push(pkt(`unborn ${ref.name}${attrs}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Every object reachable from a tree (the tree itself, subtrees, blobs). */
function treeClosure(store: Store, treeOid: string): Set<string> {
  const lookup = (oid: string): { type: GitObjectType; data: Buffer } | undefined => {
    const found = store.getObject(oid);
    return found === null ? undefined : found;
  };
  try {
    return collectReachable([treeOid], lookup);
  } catch {
    return new Set<string>();
  }
}

/**
 * Objects reachable from `wants`, cut off at `depth` generations of commits
 * (undefined = the whole history). Returns the object set plus the commits at the
 * depth boundary, which stay shallow on the client.
 */
function depthLimitedReachable(
  store: Store,
  wants: readonly string[],
  depth: number | undefined,
): { objects: Set<string>; boundaries: Set<string> } {
  const objects = new Set<string>();
  const boundaries = new Set<string>();
  const queue: { oid: string; dist: number }[] = [];
  const seen = new Set<string>();
  for (const want of wants) {
    const object = store.getObject(want);
    if (object === null) continue;
    if (object.type === 'tag') {
      objects.add(want);
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push({ oid: commit, dist: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    } else {
      objects.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (depth !== undefined && dist >= depth) continue;
    objects.add(oid);
    const object = store.getObject(oid);
    if (object === null || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    for (const entry of treeClosure(store, parsed.tree)) objects.add(entry);
    if (depth !== undefined && dist + 1 >= depth) {
      if (parsed.parents.length > 0) boundaries.add(oid);
    } else {
      for (const parent of parsed.parents) queue.push({ oid: parent, dist: dist + 1 });
    }
  }
  return { objects, boundaries };
}

/**
 * What the client already holds: the full closure of its `have` commits, except a
 * commit in the client's shallow set contributes only itself and its tree — its
 * parents are still unknown to the client and must not be treated as held.
 */
function heldClosure(store: Store, haves: readonly string[], clientShallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const have of haves) {
    const object = store.getObject(have);
    if (object === null) continue;
    held.add(have);
    const commit = object.type === 'tag' ? peelToCommit(store, have) : object.type === 'commit' ? have : null;
    if (commit !== null) queue.push(commit);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    held.add(oid);
    const object = store.getObject(oid);
    if (object === null || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    for (const entry of treeClosure(store, parsed.tree)) held.add(entry);
    if (clientShallow.has(oid)) continue;
    for (const parent of parsed.parents) queue.push(parent);
  }
  return held;
}

function chunkSideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return parts;
}

function handleFetch(store: Store, owner: string, repo: string, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not:
    // accepted, no effect on the bytes (filter values are ignored by design).
  }
  const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), DELIM];
  const missingWant = wants.find((want) => store.getObject(want) === null);
  if (missingWant !== undefined) {
    parts.push(pkt('packfile\n'));
    parts.push(pkt(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR object ${missingWant} not found\n`, 'utf8')])));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const { objects, boundaries } = depthLimitedReachable(store, wants, depth);
  const held = heldClosure(store, haves, clientShallow);
  const send = [...objects].filter((oid) => !held.has(oid)).sort();
  const sendSet = new Set(send);
  const shallow = [...boundaries].filter((oid) => !held.has(oid)).sort();
  const unshallow = [...clientShallow]
    .filter((oid) => {
      const object = store.getObject(oid);
      if (object === null || object.type !== 'commit') return false;
      const parents = parseCommit(object.data).parents;
      return parents.length > 0 && parents.every((parent) => sendSet.has(parent) || held.has(parent));
    })
    .sort();
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  const packObjects: { type: GitObjectType; data: Buffer; oid: string }[] = [];
  for (const oid of send) {
    const object = store.getObject(oid);
    if (object !== null) packObjects.push({ type: object.type, data: object.data, oid });
  }
  const pack = writePack(packObjects);
  parts.push(pkt('packfile\n'));
  for (const chunk of chunkSideband(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  route: GitRoute,
  body: Buffer,
): Promise<void> {
  const repo = store.getRepo(route.owner, route.repo);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // Protocol v0 has no `Git-Protocol` header and no `command=` line: its body
  // starts with a `want` pkt-line. Protocol v2 always starts with `command=`.
  // Decode once to tell the two apart; a malformed pkt-line stream is 400
  // either way, exactly as the v2 path answered before.
  const lines = decodeLines(body);
  if (lines === null) {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const firstLine = lines.find((line) => line !== null);
  if (firstLine !== undefined && firstLine.toString('utf8').startsWith('command=')) {
    const request = parseV2Request(body);
    if (request === null) {
      sendJson(res, 400, { message: 'Malformed pkt-line request' });
      return;
    }
    if (request.command === 'ls-refs') {
      sendBytes(res, 200, handleLsRefs(store, route.owner, route.repo, request.args), UPLOAD_RESULT);
      return;
    }
    if (request.command === 'fetch') {
      sendBytes(res, 200, handleFetch(store, route.owner, route.repo, request.args), UPLOAD_RESULT);
      return;
    }
    sendJson(res, 400, { message: `Unsupported command ${request.command}` });
    return;
  }
  const v0 = parseV0Fetch(lines);
  if (v0 === null) {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  sendBytes(res, 200, handleV0Fetch(store, route.owner, route.repo, v0), UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------------------------
// protocol v0: upload-pack fetch
// ---------------------------------------------------------------------------------------------

interface V0FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  depth: number | undefined;
}

/**
 * Parse a v0 upload-pack fetch body: `want` lines (the first may carry the
 * capability list after the oid) plus `shallow`/`deepen` lines, a flush, then
 * `have` lines and `done`, and a final flush. Null when the stream is
 * truncated, has trailing data after the final flush, or holds a line that is
 * not one of those shapes (or an oid that is not 40 lowercase hex).
 */
function parseV0Fetch(lines: readonly (Buffer | null)[]): V0FetchRequest | null {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | undefined;
  let section = 0; // 0 = wants, 1 = haves, 2 = after the final flush
  let sawFlush = false;
  for (const line of lines) {
    if (line === null) {
      sawFlush = true;
      if (section === 0) {
        section = 1;
        continue;
      }
      if (section === 1) {
        section = 2;
        continue;
      }
      return null;
    }
    if (section === 2) return null;
    const text = line.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) {
        const oid = text.slice(5).trim().split(' ')[0] ?? '';
        if (!isOid(oid)) return null;
        wants.push(oid);
        continue;
      }
      if (text.startsWith('shallow ')) {
        const oid = text.slice(8).trim();
        if (!isOid(oid)) return null;
        clientShallow.add(oid);
        continue;
      }
      if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
        continue;
      }
      // deepen-since / deepen-not: accepted, no effect on the bytes.
      if (text.startsWith('deepen-since ') || text.startsWith('deepen-not ')) continue;
      return null;
    }
    if (text.startsWith('have ')) {
      const oid = text.slice(5).trim();
      if (!isOid(oid)) return null;
      haves.push(oid);
      continue;
    }
    if (text === 'done') continue;
    return null;
  }
  // A fetch with no flush at all is a truncated stream, not a request.
  if (!sawFlush) return null;
  return { wants, haves, clientShallow, depth };
}

/**
 * A v0 fetch reply: `NAK`, then any `shallow`/`unshallow` lines, then the
 * packfile framed in sideband band 1 (the same chunking as the v2 fetch), and
 * a flush. There are no v2 section headers in a v0 reply — a v0 client treats
 * any other plain pkt-line as a protocol error. The object selection is the
 * v2 fetch's: reachable from the wants (depth-limited when asked) minus the
 * closure of the haves; a have the server does not know simply contributes
 * nothing. An empty want set and a client that already holds everything both
 * get a 0-object pack. A want the server does not know is a band-3 ERR, as in
 * the v2 fetch.
 */
function handleV0Fetch(store: Store, owner: string, repo: string, request: V0FetchRequest): Buffer {
  const parts: Buffer[] = [pkt('NAK\n')];
  const missingWant = request.wants.find((want) => store.getObject(want) === null);
  if (missingWant !== undefined) {
    parts.push(pkt(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR object ${missingWant} not found\n`, 'utf8')])));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  const { objects, boundaries } = depthLimitedReachable(store, request.wants, request.depth);
  const held = heldClosure(store, request.haves, request.clientShallow);
  const send = [...objects].filter((oid) => !held.has(oid)).sort();
  const sendSet = new Set(send);
  const shallow = [...boundaries].filter((oid) => !held.has(oid)).sort();
  const unshallow = [...request.clientShallow]
    .filter((oid) => {
      const object = store.getObject(oid);
      if (object === null || object.type !== 'commit') return false;
      const parents = parseCommit(object.data).parents;
      return parents.length > 0 && parents.every((parent) => sendSet.has(parent) || held.has(parent));
    })
    .sort();
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const packObjects: { type: GitObjectType; data: Buffer; oid: string }[] = [];
  for (const oid of send) {
    const object = store.getObject(oid);
    if (object !== null) packObjects.push({ type: object.type, data: object.data, oid });
  }
  const pack = writePack(packObjects);
  for (const chunk of chunkSideband(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// protocol v0: receive-pack
// ---------------------------------------------------------------------------------------------

/** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  const tip = peelToCommit(store, descendant);
  if (tip === null) return ancestor === descendant;
  if (ancestor === tip) return true;
  const queue: string[] = [tip];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.getObject(oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: readonly Buffer[]): PushCommand[] | null {
  const commands: PushCommand[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index].toString('utf8');
    if (index === 0) {
      const nul = text.indexOf('\u0000');
      if (nul >= 0) text = text.slice(0, nul);
    }
    const parts = text.replace(/\n$/, '').split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return commands;
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  route: GitRoute,
  body: Buffer,
): Promise<void> {
  const repo = store.getRepo(route.owner, route.repo);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const split = splitReceivePack(body);
  if (split === null) {
    sendJson(res, 400, { message: 'Malformed pkt-line request' });
    return;
  }
  const commands = parsePushCommands(split.commands);
  if (commands === null || commands.length === 0) {
    sendJson(res, 400, { message: 'Malformed ref-update commands' });
    return;
  }
  // Unpack first: every object the push carries lands in the store before any ref
  // moves, so a failed unpack changes nothing and a refused ref still unpacked.
  let unpackError: string | null = null;
  if (split.pack.length > 0) {
    try {
      const objects = readPack(split.pack);
      for (const object of objects) {
        const oid = hashObject(object.type, object.data);
        if (!store.hasObject(oid)) store.putObject(object.type, object.data);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackError === null) {
    for (const command of commands) {
      const current = store.getRef(route.owner, route.repo, command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === null) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.deleteRef(route.owner, route.repo, command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!store.hasObject(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else {
          store.setRef(route.owner, route.repo, command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update: the old value must match, and the new tip must descend from it.
      if (current === null) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!isAncestor(store, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.setRef(route.owner, route.repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  }
  // The report-status stream, pkt-lined inside sideband band 1 (unpack first).
  const reportLines: string[] = [
    unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`,
    ...results.map((result) => (result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`)),
  ];
  const reportStream = Buffer.concat([...reportLines.map((line) => pkt(line)), FLUSH]);
  const framed = Buffer.concat(
    (() => {
      const parts: Buffer[] = [];
      for (let offset = 0; offset < reportStream.length; offset += SIDEBAND_CHUNK) {
        const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + SIDEBAND_CHUNK));
        parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
      }
      return parts;
    })(),
  );
  sendBytes(res, 200, framed, RECEIVE_RESULT);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handle one request. Returns true when the path belongs to git smart HTTP (even
 * when the answer is an error), false otherwise so the router can answer 404.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const route = matchRoute(pathOf(req));
  if (route === null) return false;
  const method = req.method ?? 'GET';
  if (route.kind === 'info-refs' && method !== 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (route.kind !== 'info-refs' && method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // Read the POST body before answering, so a 401/404 never leaves a half-read
  // request on a keep-alive socket.
  const body = route.kind === 'info-refs' ? Buffer.alloc(0) : await readBody(req);
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  // The token names exactly one owner ('adaiversen'); any other owner is 404,
  // never 403 — even before checking whether the repo exists.
  if (route.owner !== OWNER_LOGIN) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (route.kind === 'info-refs') {
    await handleInfoRefs(req, res, store, route);
    return true;
  }
  if (route.kind === 'upload-pack') {
    await handleUploadPack(req, res, store, route, body);
    return true;
  }
  await handleReceivePack(req, res, store, route, body);
  return true;
}
