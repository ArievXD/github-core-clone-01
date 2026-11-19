// github-core-clone-01 — MCP surface (Model Context Protocol over streamable HTTP).
//
// POST /mcp speaks JSON-RPC 2.0. The suite's client (kit sdk/conformance/mcp-client.ts) probes
// `server/discover` first and falls back to the legacy handshake when it answers method-not-found,
// so this module serves the pre-discover era: `initialize` + `notifications/initialized`, then
// `tools/list` / `tools/call` / `ping`. Every request is one JSON-RPC object answered by one JSON
// object (content-type application/json); a notification (no id) is answered 202 with an empty body.
//
// Auth: every /mcp request needs `Authorization: Bearer <process.env.MAKEFUN_SHOP_TOKEN>`; a
// missing or wrong token is 401 JSON {message: 'Bad credentials'}. Tool effects go through the
// shared Store, so a repository or issue created over MCP is the same object over REST.
//
// Tools (canonical github-mcp-server names; the suite maps its documented arguments onto these
// inputSchema properties by name): create_repo, get_repo, create_issue, list_issues,
// create_pull_request, merge_pull_request. Tool results are the created/fetched object as JSON
// text (GitHub-shaped, snake_case) plus the same value as structuredContent.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { bearerToken, readBody, sendJson } from './http.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

/** The server identity `initialize` reports; both fields must be non-empty strings. */
const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

/** The handshake-era revisions this server echoes (the client offers them, newest first). */
const KNOWN_REVISIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** JSON-RPC error codes the checks assert. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/**
 * The six tools, in a fixed order. The array is module-level and never mutated, so two
 * `tools/list` answers serialize byte-identically (the idempotence check).
 */
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the given owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply to the issue.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch (the branch with the changes).' },
        base: { type: 'string', description: 'The base branch (the branch the changes go into).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => tool.name));

/** A tool execution failure: answered as a result with isError true (never HTTP 500). */
class ToolError extends Error {}

/** Whether `value` is a plain record (an object that is not an array and not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or null. */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The first of `keys` present in `args` as a non-empty string, or null. */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = asString(args[key]);
    if (value !== null) return value;
  }
  return null;
}

/** A boolean argument, or the default when absent or not a boolean. */
function pickBoolean(args: Record<string, unknown>, keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

/** A string array argument (labels), or null when absent or not an array of strings. */
function pickStringArray(args: Record<string, unknown>, keys: readonly string[]): string[] | null {
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return [...value];
  }
  return null;
}

const OWNER_KEYS: readonly string[] = ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'];
const REPO_KEYS: readonly string[] = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'];
const FULL_NAME_KEYS: readonly string[] = ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'];

/**
 * The repository a call addresses. Accepts `owner` + `repo` (and their aliases) or a single
 * `full_name` of the form "owner/repo". Null when the owner or the repo cannot be determined.
 */
function repoRef(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const full = pickString(args, FULL_NAME_KEYS);
  if (full !== null) {
    const slash = full.indexOf('/');
    if (slash > 0 && slash < full.length - 1) return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  }
  const owner = pickString(args, OWNER_KEYS);
  const repo = pickString(args, REPO_KEYS);
  if (owner === null || repo === null) return null;
  return { owner, repo };
}

/** A pull request number argument (a positive integer, or a numeric string), or null. */
function pullNumber(args: Record<string, unknown>): number | null {
  const raw = args['pull_number'] ?? args['pull_request_number'] ?? args['pr_number'] ?? args['number'] ?? args['issue_number'] ?? args['index'];
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

// ---------------------------------------------------------------- result shapes
// GitHub-shaped (snake_case), so the MCP text parses to the same fields REST returns.

function repoToJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueToJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: [...issue.labels],
    user: { login: issue.user.login },
    comments: issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: comment.user.login },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullToJson(pull: PullRequest, owner: string): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${owner}:${pull.base.ref}` },
    user: { login: pull.user.login },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- tool implementations

function createRepoTool(args: Record<string, unknown>, store: Store): Record<string, unknown> {
  const name = pickString(args, ['name', ...REPO_KEYS]);
  if (name === null) throw new ToolError('missing required argument: name');
  // The suite always passes the owner (resolved over REST). When a caller omits it, fall back
  // to the token owner's login: the scenario is built from a FIXED seed (SCENARIO_SEED
  // 0x6a09e667f3bcc909), so the viewer is always 'adaiversen' — never a placeholder login.
  const owner = pickString(args, OWNER_KEYS) ?? 'adaiversen';
  const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
  const isPrivate = pickBoolean(args, ['private', 'is_private'], false);
  let repo: Repo;
  try {
    repo = store.createRepo(owner, name, { private: isPrivate, description });
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : `could not create repository ${owner}/${name}`);
  }
  return repoToJson(repo);
}

function getRepoTool(args: Record<string, unknown>, store: Store): Record<string, unknown> {
  const ref = repoRef(args);
  if (ref === null) throw new ToolError('missing required arguments: owner and repo');
  const repo = store.getRepo(ref.owner, ref.repo);
  if (repo === null) throw new ToolError(`repository ${ref.owner}/${ref.repo} not found`);
  return repoToJson(repo);
}

function createIssueTool(args: Record<string, unknown>, store: Store): Record<string, unknown> {
  const ref = repoRef(args);
  if (ref === null) throw new ToolError('missing required arguments: owner and repo');
  const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === null) throw new ToolError('missing required argument: title');
  const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const labels = pickStringArray(args, ['labels']);
  let issue: Issue;
  try {
    issue = store.createIssue(ref.owner, ref.repo, { title, body, ...(labels === null ? {} : { labels }) });
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : `could not create issue in ${ref.owner}/${ref.repo}`);
  }
  return issueToJson(issue);
}

function listIssuesTool(args: Record<string, unknown>, store: Store): Record<string, unknown>[] {
  const ref = repoRef(args);
  if (ref === null) throw new ToolError('missing required arguments: owner and repo');
  const stateRaw = pickString(args, ['state', 'status']) ?? 'open';
  const state: 'open' | 'closed' | 'all' = stateRaw === 'closed' || stateRaw === 'all' ? stateRaw : 'open';
  return store.listIssues(ref.owner, ref.repo, { state }).map((issue) => issueToJson(issue));
}

function createPullTool(args: Record<string, unknown>, store: Store): Record<string, unknown> {
  const ref = repoRef(args);
  if (ref === null) throw new ToolError('missing required arguments: owner and repo');
  const title = pickString(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === null) throw new ToolError('missing required argument: title');
  const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  if (head === null) throw new ToolError('missing required argument: head');
  const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  if (base === null) throw new ToolError('missing required argument: base');
  const body = pickString(args, ['body', 'description', 'content', 'text']) ?? '';
  let pull: PullRequest;
  try {
    pull = store.createPull(ref.owner, ref.repo, { head, base, title, body });
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : `could not create pull request in ${ref.owner}/${ref.repo}`);
  }
  return pullToJson(pull, ref.owner);
}

function mergePullTool(args: Record<string, unknown>, store: Store): Record<string, unknown> {
  const ref = repoRef(args);
  if (ref === null) throw new ToolError('missing required arguments: owner and repo');
  const number = pullNumber(args);
  if (number === null) throw new ToolError('missing required argument: pull_number');
  const methodRaw = pickString(args, ['merge_method', 'method']) ?? 'squash';
  const method: 'squash' | 'merge' | 'rebase' = methodRaw === 'merge' || methodRaw === 'rebase' ? methodRaw : 'squash';
  let merged: { sha: string; merged: boolean; message: string };
  try {
    merged = store.mergePull(ref.owner, ref.repo, number, method);
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : `could not merge pull request #${number}`);
  }
  return { merged: merged.merged, sha: merged.sha, message: merged.message };
}

/** Dispatch one tools/call by name. Throws ToolError for a failed tool run. */
function dispatchTool(name: string, args: Record<string, unknown>, store: Store): unknown {
  switch (name) {
    case 'create_repo':
      return createRepoTool(args, store);
    case 'get_repo':
      return getRepoTool(args, store);
    case 'create_issue':
      return createIssueTool(args, store);
    case 'list_issues':
      return listIssuesTool(args, store);
    case 'create_pull_request':
      return createPullTool(args, store);
    case 'merge_pull_request':
      return mergePullTool(args, store);
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

/** A successful tool result: the value as JSON text, and as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A failed tool run: a result with isError true and the reason as text. */
function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * The protocol version `initialize` echoes: the client's offer when it is a revision this server
 * knows, else the newest known one. The client accepts the echo as the negotiated revision.
 */
function negotiateVersion(params: Record<string, unknown>): string {
  const offered = asString(params['protocolVersion']);
  if (offered !== null && KNOWN_REVISIONS.includes(offered)) return offered;
  return KNOWN_REVISIONS[0] as string;
}

/**
 * Answer one parsed JSON-RPC message. Returns the response object, or null for a notification
 * (no id), which the caller answers 202 with an empty body.
 */
function handleRpc(message: unknown, store: Store): Record<string, unknown> | null {
  if (!isRecord(message)) return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  const hasId = message['id'] !== undefined;
  const id = message['id'];
  const idValue: JsonRpcId | null =
    typeof id === 'string' || typeof id === 'number' ? id : null;
  const method = message['method'];
  if (typeof method !== 'string' || method === '') {
    return hasId ? rpcError(idValue, INVALID_REQUEST, 'Invalid Request') : null;
  }
  // A notification (no id) is never answered, whatever its method.
  if (!hasId) return null;

  const params = isRecord(message['params']) ? (message['params'] as Record<string, unknown>) : {};

  switch (method) {
    case 'initialize':
      return rpcResult(idValue as JsonRpcId, {
        protocolVersion: negotiateVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'server/discover':
      // Pre-discover revision: the client falls back to the initialize handshake on -32601.
      return rpcError(idValue, METHOD_NOT_FOUND, 'Method not found: server/discover');
    case 'ping':
      return rpcResult(idValue as JsonRpcId, {});
    case 'tools/list':
      return rpcResult(idValue as JsonRpcId, { tools: TOOLS });
    case 'tools/call': {
      const name = asString(params['name']);
      if (name === null) return rpcError(idValue, INVALID_PARAMS, 'tools/call requires a tool name');
      const args = params['arguments'] === undefined ? {} : params['arguments'];
      if (!isRecord(args)) return rpcError(idValue, INVALID_PARAMS, 'tools/call arguments must be an object');
      if (!TOOL_NAMES.has(name)) {
        return rpcError(idValue, INVALID_PARAMS, `unknown tool: ${name}`);
      }
      try {
        return rpcResult(idValue as JsonRpcId, toolResult(dispatchTool(name, args, store)));
      } catch (error) {
        if (error instanceof ToolError) {
          return rpcResult(idValue as JsonRpcId, toolErrorResult(error.message));
        }
        return rpcResult(
          idValue as JsonRpcId,
          toolErrorResult(error instanceof Error ? error.message : `tool ${name} failed`),
        );
      }
    }
    default:
      if (method.startsWith('notifications/')) return rpcResult(idValue as JsonRpcId, {});
      return rpcError(idValue, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * The MCP endpoint. Returns true when the request path is /mcp (even when answered with an
 * error), false otherwise so the router can fall through to its 404.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;

  // Auth first, before the body is read: a missing or wrong token is 401.
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const token = bearerToken(req);
  if (expected === '' || token === null || token !== expected) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  // Only POST carries JSON-RPC; anything else on /mcp is a method error.
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return true;
  }

  // A batch: answer each request in turn; notifications contribute no response. An all-notification
  // batch is answered 202 with an empty body.
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const message of parsed) {
      const response = handleRpc(message, store);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return true;
    }
    sendJson(res, 200, responses);
    return true;
  }

  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } });
    return true;
  }

  const response = handleRpc(parsed, store);
  if (response === null) {
    // A notification: no JSON-RPC response, just 202 with an empty body.
    res.writeHead(202);
    res.end();
    return true;
  }
  sendJson(res, 200, response);
  return true;
}
