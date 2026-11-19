// github-core-clone-01 — the central in-memory store.
//
// One Store instance per process. Every surface (git smart HTTP, REST v3, GraphQL v4, MCP) shares
// it, so a pull request merged over GraphQL shows merged over REST and its squash commit is on the
// default branch over git. The store starts empty; the suite creates everything through the API.
//
// Determinism: timestamps are STORE_EPOCH_SEC plus a store-wide monotonic counter, never the wall
// clock, so two runs on the same input leave the same state.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObjectType,
} from './gitobj.ts';

/** 2025-01-01T00:00:00Z: every generated timestamp is this plus a seeded offset (wire.ts). */
export const STORE_EPOCH_SEC = 1_735_689_600;

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  user: { login: string };
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  files: PullFile[];
  user: { login: string };
  createdAt: string;
  updatedAt: string;
}

export class RepoExistsError extends Error {}
export class UnknownLabelError extends Error {
  label: string;
  constructor(label: string) {
    super(`unknown label ${label}`);
    this.label = label;
  }
}
export class StaleShaError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

const HEX40 = /^[0-9a-f]{40}$/;
const ZERO_OID = '0'.repeat(40);

/** Split a buffer into lines (a trailing newline does not make an empty last line). */
function textLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isBinary(data: Buffer): boolean {
  return data.indexOf(0) >= 0;
}

interface LineOp {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** LCS line diff (with a prefix/suffix fast path for long files). */
function diffLines(baseLines: string[], headLines: string[]): LineOp[] {
  let start = 0;
  while (
    start < baseLines.length &&
    start < headLines.length &&
    baseLines[start] === headLines[start]
  ) {
    start += 1;
  }
  let endBase = baseLines.length;
  let endHead = headLines.length;
  while (
    endBase > start &&
    endHead > start &&
    baseLines[endBase - 1] === headLines[endHead - 1]
  ) {
    endBase -= 1;
    endHead -= 1;
  }
  const ops: LineOp[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: 'same', text: baseLines[i] as string });
  const midBase = baseLines.slice(start, endBase);
  const midHead = headLines.slice(start, endHead);
  if (midBase.length * midHead.length <= 4_000_000) {
    // LCS dynamic programming over the changed middle.
    const n = midBase.length;
    const m = midHead.length;
    const dp: number[][] = [];
    for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i]![j] =
          midBase[i] === midHead[j]
            ? (dp[i + 1]![j + 1] as number) + 1
            : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midBase[i] === midHead[j]) {
        ops.push({ kind: 'same', text: midBase[i] as string });
        i += 1;
        j += 1;
      } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
        ops.push({ kind: 'del', text: midBase[i] as string });
        i += 1;
      } else {
        ops.push({ kind: 'add', text: midHead[j] as string });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: 'del', text: midBase[i] as string });
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: 'add', text: midHead[j] as string });
      j += 1;
    }
  } else {
    for (const text of midBase) ops.push({ kind: 'del', text });
    for (const text of midHead) ops.push({ kind: 'add', text });
  }
  for (let i = endBase; i < baseLines.length; i += 1) ops.push({ kind: 'same', text: baseLines[i] as string });
  return ops;
}

/** A minimal unified diff (one hunk per changed region, 3 lines of context) for a text file. */
function unifiedPatch(filename: string, baseLines: string[], headLines: string[]): string {
  const ops = diffLines(baseLines, headLines);
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i += 1) if (ops[i]!.kind !== 'same') changed.push(i);
  if (changed.length === 0) return '';
  // Group changes separated by at most 6 unchanged lines into one hunk.
  const groups: number[][] = [];
  let current: number[] = [changed[0] as number];
  for (let k = 1; k < changed.length; k += 1) {
    if ((changed[k] as number) - (changed[k - 1] as number) <= 7) current.push(changed[k] as number);
    else {
      groups.push(current);
      current = [changed[k] as number];
    }
  }
  groups.push(current);
  const hunks: string[] = [];
  for (const group of groups) {
    const first = group[0] as number;
    const last = group[group.length - 1] as number;
    const hunkStart = Math.max(0, first - 3);
    const hunkEnd = Math.min(ops.length, last + 4);
    let baseStart = 0;
    let headStart = 0;
    for (let k = 0; k < hunkStart; k += 1) {
      if (ops[k]!.kind !== 'add') baseStart += 1;
      if (ops[k]!.kind !== 'del') headStart += 1;
    }
    let baseCount = 0;
    let headCount = 0;
    const body: string[] = [];
    for (let k = hunkStart; k < hunkEnd; k += 1) {
      const op = ops[k] as LineOp;
      if (op.kind === 'same') {
        body.push(` ${op.text}`);
        baseCount += 1;
        headCount += 1;
      } else if (op.kind === 'del') {
        body.push(`-${op.text}`);
        baseCount += 1;
      } else {
        body.push(`+${op.text}`);
        headCount += 1;
      }
    }
    hunks.push(`@@ -${baseStart + 1},${baseCount} +${headStart + 1},${headCount} @@\n${body.join('\n')}`);
  }
  return `--- a/${filename}\n+++ b/${filename}\n${hunks.join('\n')}\n`;
}

/** The store. Method bodies are implemented by the Store agent; signatures are the contract. */
export class Store {
  repos = new Map<string, Repo>();
  objects = new Map<string, GitObject>();
  refs = new Map<string, Map<string, string>>();
  issues = new Map<string, Issue[]>();
  labels = new Map<string, Label[]>();
  pulls = new Map<string, PullRequest[]>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  counter = 0;

  // -- timestamps -----------------------------------------------------------
  /** The next store timestamp (epoch seconds), consuming one counter tick. */
  nextTimestamp(): number {
    const sec = STORE_EPOCH_SEC + this.counter;
    this.counter += 1;
    return sec;
  }

  nextTimestampIso(): string {
    return new Date(this.nextTimestamp() * 1000).toISOString();
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  identity(owner: string): string {
    return `${owner} <${owner}@example.invalid>`;
  }

  // -- repositories ---------------------------------------------------------
  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo {
    const key = Store.repoKey(owner, name);
    if (this.repos.has(key)) throw new RepoExistsError(`repository ${owner}/${name} already exists`);
    const now = this.nextTimestampIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    this.refs.set(key, new Map());
    this.issues.set(key, []);
    this.labels.set(key, []);
    this.pulls.set(key, []);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(Store.repoKey(owner, name)) ?? null;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  patchRepo(owner: string, name: string, patch: { description?: string }): Repo | null {
    const repo = this.getRepo(owner, name);
    if (repo === null) return null;
    if (patch.description !== undefined) repo.description = patch.description;
    repo.updatedAt = this.nextTimestampIso();
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = Store.repoKey(owner, name);
    if (!this.repos.has(key)) return false;
    this.repos.delete(key);
    this.refs.delete(key);
    this.issues.delete(key);
    this.labels.delete(key);
    this.pulls.delete(key);
    return true;
  }

  // -- git objects ----------------------------------------------------------
  getObject(oid: string): GitObject | null {
    return this.objects.get(oid) ?? null;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  // -- refs -----------------------------------------------------------------
  getRef(owner: string, repo: string, refname: string): string | null {
    return this.refs.get(Store.repoKey(owner, repo))?.get(refname) ?? null;
  }

  setRef(owner: string, repo: string, refname: string, oid: string): void {
    const key = Store.repoKey(owner, repo);
    let map = this.refs.get(key);
    if (map === undefined) {
      map = new Map();
      this.refs.set(key, map);
    }
    map.set(refname, oid);
  }

  deleteRef(owner: string, repo: string, refname: string): boolean {
    const map = this.refs.get(Store.repoKey(owner, repo));
    if (map === undefined) return false;
    return map.delete(refname);
  }

  listRefs(owner: string, repo: string): { name: string; oid: string }[] {
    const map = this.refs.get(Store.repoKey(owner, repo));
    if (map === undefined) return [];
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of map) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  headRef(owner: string, repo: string): string {
    const found = this.getRepo(owner, repo);
    return `refs/heads/${found?.defaultBranch ?? 'main'}`;
  }

  // -- issues ---------------------------------------------------------------
  createIssue(owner: string, repo: string, input: { title: string; body: string; labels?: string[] }): Issue {
    const key = Store.repoKey(owner, repo);
    if (!this.repos.has(key)) throw new NotFoundError(`repository ${owner}/${repo} not found`);
    const known = new Set((this.labels.get(key) ?? []).map((label) => label.name));
    for (const label of input.labels ?? []) {
      if (!known.has(label)) throw new UnknownLabelError(label);
    }
    const now = this.nextTimestampIso();
    const list = this.issues.get(key) as Issue[];
    const issue: Issue = {
      id: this.nextIssueId,
      number: list.length + 1,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      user: { login: owner },
      createdAt: now,
      updatedAt: now,
    };
    this.nextIssueId += 1;
    list.push(issue);
    return issue;
  }

  getIssue(owner: string, repo: string, number: number): Issue | null {
    const list = this.issues.get(Store.repoKey(owner, repo));
    if (list === undefined) return null;
    return list.find((issue) => issue.number === number) ?? null;
  }

  listIssues(
    owner: string,
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all'; sort?: 'created'; direction?: 'asc' | 'desc' },
  ): Issue[] {
    const list = this.issues.get(Store.repoKey(owner, repo)) ?? [];
    const state = opts.state ?? 'all';
    let out = state === 'all' ? [...list] : list.filter((issue) => issue.state === state);
    if (opts.sort === 'created') {
      if (opts.direction === 'desc') out = [...out].reverse();
    }
    return out;
  }

  patchIssue(
    owner: string,
    repo: string,
    number: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string },
  ): Issue | null {
    const issue = this.getIssue(owner, repo, number);
    if (issue === null) return null;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = this.nextTimestampIso();
    return issue;
  }

  addComment(owner: string, repo: string, number: number, body: string): IssueComment | null {
    const issue = this.getIssue(owner, repo, number);
    if (issue === null) return null;
    const now = this.nextTimestampIso();
    const comment: IssueComment = {
      id: this.nextCommentId,
      body,
      user: { login: owner },
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = now;
    return comment;
  }

  listComments(owner: string, repo: string, number: number): IssueComment[] {
    return [...(this.getIssue(owner, repo, number)?.comments ?? [])];
  }

  // -- labels ---------------------------------------------------------------
  createLabel(owner: string, repo: string, input: { name: string; color?: string; description?: string }): Label {
    const key = Store.repoKey(owner, repo);
    if (!this.repos.has(key)) throw new NotFoundError(`repository ${owner}/${repo} not found`);
    const list = this.labels.get(key) as Label[];
    if (list.some((label) => label.name === input.name)) {
      throw new RepoExistsError(`label ${input.name} already exists`);
    }
    const label: Label = {
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? '',
    };
    list.push(label);
    return label;
  }

  getLabel(owner: string, repo: string, name: string): Label | null {
    const list = this.labels.get(Store.repoKey(owner, repo)) ?? [];
    return list.find((label) => label.name === name) ?? null;
  }

  listLabels(owner: string, repo: string): Label[] {
    return [...(this.labels.get(Store.repoKey(owner, repo)) ?? [])];
  }

  // -- pull requests --------------------------------------------------------
  createPull(owner: string, repo: string, input: { head: string; base: string; title: string; body: string }): PullRequest {
    const key = Store.repoKey(owner, repo);
    if (!this.repos.has(key)) throw new NotFoundError(`repository ${owner}/${repo} not found`);
    const headSha = this.resolveRefToCommit(owner, repo, input.head);
    const baseSha = this.resolveRefToCommit(owner, repo, input.base);
    if (headSha === null || baseSha === null) {
      throw new NotFoundError(`head or base branch not found for pull request (${input.head} -> ${input.base})`);
    }
    const now = this.nextTimestampIso();
    const list = this.pulls.get(key) as PullRequest[];
    const pr: PullRequest = {
      id: this.nextPullId,
      number: list.length + 1,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      head: { ref: input.head, sha: headSha },
      base: { ref: input.base, sha: baseSha },
      files: this.computePullFiles(owner, repo, headSha, baseSha),
      user: { login: owner },
      createdAt: now,
      updatedAt: now,
    };
    this.nextPullId += 1;
    list.push(pr);
    return pr;
  }

  getPull(owner: string, repo: string, number: number): PullRequest | null {
    const list = this.pulls.get(Store.repoKey(owner, repo));
    if (list === undefined) return null;
    return list.find((pr) => pr.number === number) ?? null;
  }

  listPulls(owner: string, repo: string, state: 'open' | 'closed' | 'all'): PullRequest[] {
    const list = this.pulls.get(Store.repoKey(owner, repo)) ?? [];
    if (state === 'all') return [...list];
    return list.filter((pr) => pr.state === state);
  }

  mergePull(
    owner: string,
    repo: string,
    number: number,
    method: 'squash' | 'merge' | 'rebase',
  ): { sha: string; merged: boolean; message: string } {
    void method; // every method squashes to one commit on the base branch (see DESIGN.md).
    const pr = this.getPull(owner, repo, number);
    if (pr === null) throw new NotFoundError(`pull request #${number} not found`);
    if (pr.merged || pr.state === 'closed') throw new ConflictError(`pull request #${number} is already closed`);
    const headSha = this.resolveRefToCommit(owner, repo, pr.head.ref) ?? pr.head.sha;
    const baseSha = this.resolveRefToCommit(owner, repo, pr.base.ref) ?? pr.base.sha;
    const headCommit = this.getObject(headSha);
    const baseCommit = this.getObject(baseSha);
    if (headCommit === null || headCommit.type !== 'commit' || baseCommit === null || baseCommit.type !== 'commit') {
      throw new NotFoundError('head or base commit not found');
    }
    if (this.hasMergeConflict(headSha, baseSha)) {
      throw new ConflictError(`pull request #${number} has merge conflicts`);
    }
    const headTree = parseCommit(headCommit.data).tree;
    const message = pr.body ? `${pr.title}\n\n${pr.body}` : pr.title;
    const timestamp = this.nextTimestamp();
    const commitData = buildCommit({
      tree: headTree,
      parents: [baseSha],
      message,
      author: this.identity(owner),
      committer: this.identity(owner),
      timestamp,
    });
    const commitSha = this.putObject('commit', commitData);
    const baseRef = `refs/heads/${pr.base.ref}`;
    this.setRef(owner, repo, baseRef, commitSha);
    const mergedAt = new Date(timestamp * 1000).toISOString();
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = commitSha;
    pr.mergedAt = mergedAt;
    pr.updatedAt = mergedAt;
    const repoRecord = this.getRepo(owner, repo);
    if (repoRecord !== null) repoRecord.updatedAt = mergedAt;
    return { sha: commitSha, merged: true, message };
  }

  getPullFiles(owner: string, repo: string, number: number): PullFile[] {
    return [...(this.getPull(owner, repo, number)?.files ?? [])];
  }

  // -- contents (git-backed file operations) ---------------------------------
  getFileAtRef(owner: string, repo: string, ref: string, path: string): { blobOid: string; content: Buffer } | null {
    const commitSha = this.resolveRefToCommit(owner, repo, ref);
    if (commitSha === null) return null;
    const commit = this.getObject(commitSha);
    if (commit === null || commit.type !== 'commit') return null;
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) return null;
    let treeOid = parseCommit(commit.data).tree;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = this.getObject(treeOid);
      if (tree === null || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = this.getObject(entry.oid);
        if (blob === null || blob.type !== 'blob') return null;
        return { blobOid: entry.oid, content: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  listDirAtRef(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): { name: string; type: 'file' | 'dir'; path: string; sha: string }[] {
    const commitSha = this.resolveRefToCommit(owner, repo, ref);
    if (commitSha === null) return [];
    const commit = this.getObject(commitSha);
    if (commit === null || commit.type !== 'commit') return [];
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
    let treeOid = parseCommit(commit.data).tree;
    for (const segment of segments) {
      const tree = this.getObject(treeOid);
      if (tree === null || tree.type !== 'tree') return [];
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return [];
      treeOid = entry.oid;
    }
    const tree = this.getObject(treeOid);
    if (tree === null || tree.type !== 'tree') return [];
    const prefix = segments.join('/');
    return parseTree(tree.data).map((entry) => ({
      name: entry.name,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
    }));
  }

  commitFile(
    owner: string,
    repo: string,
    opts: { branch?: string; path: string; content: Buffer; message: string; expectedBlobSha?: string },
  ): { commitSha: string; blobSha: string; treeSha: string } {
    const repoRecord = this.getRepo(owner, repo);
    if (repoRecord === null) throw new NotFoundError(`repository ${owner}/${repo} not found`);
    const branch = opts.branch ?? repoRecord.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const parentSha = this.resolveRefToCommit(owner, repo, branch);
    const current = parentSha === null ? null : this.getFileAtRef(owner, repo, branch, opts.path);
    if (opts.expectedBlobSha !== undefined && (current === null || current.blobOid !== opts.expectedBlobSha)) {
      throw new StaleShaError(`expected blob ${opts.expectedBlobSha} does not match the current file`);
    }
    const blobSha = this.putObject('blob', opts.content);
    const files = parentSha === null ? new Map<string, string>() : this.flattenTree(this.commitTreeOf(parentSha));
    files.set(opts.path, blobSha);
    const treeSha = this.buildTreeFromFiles(files);
    const timestamp = this.nextTimestamp();
    const commitData = buildCommit({
      tree: treeSha,
      parents: parentSha === null ? [] : [parentSha],
      message: opts.message,
      author: this.identity(owner),
      committer: this.identity(owner),
      timestamp,
    });
    const commitSha = this.putObject('commit', commitData);
    this.setRef(owner, repo, branchRef, commitSha);
    repoRecord.updatedAt = new Date(timestamp * 1000).toISOString();
    return { commitSha, blobSha, treeSha };
  }

  deleteFile(
    owner: string,
    repo: string,
    opts: { branch?: string; path: string; message: string; expectedBlobSha?: string },
  ): { commitSha: string } {
    const repoRecord = this.getRepo(owner, repo);
    if (repoRecord === null) throw new NotFoundError(`repository ${owner}/${repo} not found`);
    const branch = opts.branch ?? repoRecord.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const parentSha = this.resolveRefToCommit(owner, repo, branch);
    if (parentSha === null) throw new NotFoundError(`branch ${branch} has no commits`);
    const current = this.getFileAtRef(owner, repo, branch, opts.path);
    if (current === null) throw new NotFoundError(`file ${opts.path} not found`);
    if (opts.expectedBlobSha !== undefined && current.blobOid !== opts.expectedBlobSha) {
      throw new StaleShaError(`expected blob ${opts.expectedBlobSha} does not match the current file`);
    }
    const files = this.flattenTree(this.commitTreeOf(parentSha));
    files.delete(opts.path);
    const treeSha = this.buildTreeFromFiles(files);
    const timestamp = this.nextTimestamp();
    const commitData = buildCommit({
      tree: treeSha,
      parents: [parentSha],
      message: opts.message,
      author: this.identity(owner),
      committer: this.identity(owner),
      timestamp,
    });
    const commitSha = this.putObject('commit', commitData);
    this.setRef(owner, repo, branchRef, commitSha);
    repoRecord.updatedAt = new Date(timestamp * 1000).toISOString();
    return { commitSha };
  }

  // -- git queries ----------------------------------------------------------
  resolveRefToCommit(owner: string, repo: string, ref: string): string | null {
    const trimmed = ref.trim();
    if (trimmed === '' || trimmed === 'HEAD') {
      const head = this.getRef(owner, repo, this.headRef(owner, repo));
      return head === null ? null : this.peelToCommit(head);
    }
    if (HEX40.test(trimmed)) return this.peelToCommit(trimmed);
    if (trimmed.startsWith('refs/')) {
      const oid = this.getRef(owner, repo, trimmed);
      return oid === null ? null : this.peelToCommit(oid);
    }
    const branch = this.getRef(owner, repo, `refs/heads/${trimmed}`);
    if (branch !== null) return this.peelToCommit(branch);
    const tag = this.getRef(owner, repo, `refs/tags/${trimmed}`);
    if (tag !== null) return this.peelToCommit(tag);
    return null;
  }

  listCommits(owner: string, repo: string, ref: string, limit?: number): CommitInfo[] {
    const tip = this.resolveRefToCommit(owner, repo, ref);
    if (tip === null) return [];
    const out: CommitInfo[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      if (limit !== undefined && out.length >= limit) break;
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = this.getObject(sha);
      if (object === null || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      out.push({ sha, message: parsed.message, author: parsed.author, committer: parsed.committer, timestamp: parsed.timestamp });
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) {
        stack.push(parsed.parents[i] as string);
      }
    }
    return out;
  }

  computePullFiles(owner: string, repo: string, headSha: string, baseSha: string): PullFile[] {
    void owner;
    void repo;
    const headTree = this.treeOfCommit(headSha);
    const baseTree = this.treeOfCommit(baseSha);
    const headFiles = headTree === null ? new Map<string, string>() : this.flattenTree(headTree);
    const baseFiles = baseTree === null ? new Map<string, string>() : this.flattenTree(baseTree);
    const out: PullFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const sorted = [...paths].sort();
    for (const filename of sorted) {
      const headOid = headFiles.get(filename);
      const baseOid = baseFiles.get(filename);
      if (headOid === baseOid) continue;
      if (baseOid === undefined) {
        const content = this.getObject(headOid as string)?.data ?? Buffer.alloc(0);
        const lines = isBinary(content) ? [] : textLines(content);
        const patch = isBinary(content) ? undefined : unifiedPatch(filename, [], lines);
        out.push({
          filename,
          status: 'added',
          additions: lines.length,
          deletions: 0,
          changes: lines.length,
          ...(patch ? { patch } : {}),
        });
      } else if (headOid === undefined) {
        const content = this.getObject(baseOid)?.data ?? Buffer.alloc(0);
        const lines = isBinary(content) ? [] : textLines(content);
        const patch = isBinary(content) ? undefined : unifiedPatch(filename, lines, []);
        out.push({
          filename,
          status: 'removed',
          additions: 0,
          deletions: lines.length,
          changes: lines.length,
          ...(patch ? { patch } : {}),
        });
      } else {
        const baseContent = this.getObject(baseOid)?.data ?? Buffer.alloc(0);
        const headContent = this.getObject(headOid)?.data ?? Buffer.alloc(0);
        if (isBinary(baseContent) || isBinary(headContent)) {
          out.push({ filename, status: 'modified', additions: 0, deletions: 0, changes: 0 });
        } else {
          const baseLines = textLines(baseContent);
          const headLines = textLines(headContent);
          const ops = diffLines(baseLines, headLines);
          const additions = ops.filter((op) => op.kind === 'add').length;
          const deletions = ops.filter((op) => op.kind === 'del').length;
          const patch = unifiedPatch(filename, baseLines, headLines);
          out.push({
            filename,
            status: 'modified',
            additions,
            deletions,
            changes: additions + deletions,
            ...(patch ? { patch } : {}),
          });
        }
      }
    }
    return out;
  }

  // -- internal git helpers ---------------------------------------------------
  /** Follow annotated tags until a commit (or null when the object is not a commit/tag). */
  peelToCommit(oid: string): string | null {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (!HEX40.test(current) || current === ZERO_OID || seen.has(current)) return null;
      seen.add(current);
      const object = this.getObject(current);
      if (object === null) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
  }

  commitTreeOf(commitSha: string): string {
    const object = this.getObject(commitSha);
    if (object === null || object.type !== 'commit') throw new NotFoundError(`commit ${commitSha} not found`);
    return parseCommit(object.data).tree;
  }

  treeOfCommit(sha: string): string | null {
    if (!HEX40.test(sha) || sha === ZERO_OID) return null;
    const peeled = this.peelToCommit(sha);
    if (peeled === null) return null;
    return this.commitTreeOf(peeled);
  }

  /** Flatten a tree (recursively) to path -> blob oid. */
  flattenTree(treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.getObject(oid);
      if (object === null || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the nested trees for a path -> blob map; returns the root tree oid. */
  buildTreeFromFiles(files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Ancestor distances from a tip (BFS, first-parent order does not matter for the set). */
  ancestorDepths(tip: string): Map<string, number> {
    const depths = new Map<string, number>();
    const queue: { oid: string; depth: number }[] = [{ oid: tip, depth: 0 }];
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (depths.has(oid)) continue;
      const object = this.getObject(oid);
      if (object === null || object.type !== 'commit') continue;
      depths.set(oid, depth);
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, depth: depth + 1 });
      }
    }
    return depths;
  }

  /** The best common ancestor of two commits (closest to the head), or null. */
  mergeBase(headSha: string, baseSha: string): string | null {
    const baseAncestors = this.ancestorDepths(baseSha);
    const queue: string[] = [headSha];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (baseAncestors.has(oid)) return oid;
      const object = this.getObject(oid);
      if (object === null || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** True when head and base both changed the same path differently vs their merge-base. */
  hasMergeConflict(headSha: string, baseSha: string): boolean {
    const base = this.mergeBase(headSha, baseSha);
    const baseFiles = base === null ? new Map<string, string>() : this.flattenTree(this.commitTreeOf(base));
    const headFiles = this.flattenTree(this.commitTreeOf(headSha));
    const baseTipFiles = this.flattenTree(this.commitTreeOf(baseSha));
    const paths = new Set([...headFiles.keys(), ...baseTipFiles.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path);
      const head = headFiles.get(path);
      const tip = baseTipFiles.get(path);
      if (head === tip) continue;
      const headChanged = head !== ancestor;
      const baseChanged = tip !== ancestor;
      if (headChanged && baseChanged) return true;
    }
    return false;
  }
}
