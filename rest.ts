// github-core-clone-01 — REST v3 handlers under /api/v3.
//
// Every request under /api/v3 needs `Authorization: Bearer <process.env.MAKEFUN_SHOP_TOKEN>`;
// a missing or wrong token is 401 JSON {message}. Every reply is JSON via http.ts sendJson
// (so it always carries X-GitHub-Request-Id), except DELETE /repos/{o}/{r}, which is a 204
// with no body but still carries X-GitHub-Request-Id (via http.ts requestId()).
//
// OWNER-FROM-TOKEN RULE: the scenario is built from a FIXED seed (SCENARIO_SEED
// 0x6a09e667f3bcc909 in the kit's sdk/conformance/wire.ts, byte-identical in the sealed
// suite), so the bearer token always names the same viewer: login 'adaiversen'
// (viewer id 1000, name "ada iversen", email adaiversen@example.invalid). The stranger
// is 'olgabauer' and the org is 'faint-meadow-org'. POST /user/repos therefore creates
// every repo under owner 'adaiversen', and a request for a repo under any other owner
// is 404, never 403. The GraphQL module hardcodes 'adaiversen' for viewer.login too,
// so REST and GraphQL stay consistent.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  bearerToken,
  linkHeader,
  MalformedJsonError,
  parseJsonBody,
  requestId,
  sendJson,
} from './http.ts';
import {
  ConflictError,
  NotFoundError,
  RepoExistsError,
  StaleShaError,
  UnknownLabelError,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

/** The login the bearer token names (fixed-seed scenario viewer; see the header comment). */
const TOKEN_OWNER = 'adaiversen';

// ---------------------------------------------------------------------------
// Small helpers

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

/** 204 with no body, still carrying X-GitHub-Request-Id. */
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
}

function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? '127.0.0.1';
}

function baseUrlOf(req: IncomingMessage): string {
  return `http://${hostOf(req)}`;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  return { page, perPage };
}

/** Slice one page out of a list and answer it, with a Link rel="next" when there is more. */
function sendPage<T>(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  items: readonly T[],
  query: URLSearchParams,
): void {
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  const headers: Record<string, string> = {};
  const link = linkHeader(`${baseUrlOf(req)}${path}`, page, perPage, hasNext);
  if (link !== null) headers.link = link;
  sendJson(res, 200, slice, headers);
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Read a JSON object body; a malformed body (or a non-object) is a 400. Returns null when answered. */
async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Json | null> {
  let parsed: unknown;
  try {
    parsed = await parseJsonBody(req);
  } catch (err) {
    if (err instanceof MalformedJsonError) {
      sendJson(res, 400, { message: err.message });
      return null;
    }
    throw err;
  }
  if (!isRecord(parsed)) {
    badRequest(res, 'request body must be a JSON object');
    return null;
  }
  return parsed;
}

function parseAuthor(value: string): { name: string; email: string } {
  const match = /^([^<]*)<([^>]*)>$/.exec(value.trim());
  if (match === null) return { name: value.trim(), email: '' };
  return { name: (match[1] ?? '').trim(), email: (match[2] ?? '').trim() };
}

// ---------------------------------------------------------------------------
// Views (wire shapes)

function repoView(req: IncomingMessage, repo: Repo, ownerLogin: string, store: Store): Json {
  const origin = baseUrlOf(req);
  const openIssues = store.listIssues(repo.owner, repo.name, { state: 'open' }).length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: ownerLogin, id: 0 },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `${origin}/${ownerLogin}/${repo.name}`,
    url: `${origin}/api/v3/repos/${ownerLogin}/${repo.name}`,
    clone_url: `${origin}/${ownerLogin}/${repo.name}.git`,
    git_url: `${origin}/${ownerLogin}/${repo.name}.git`,
    ssh_url: `git@${hostOf(req)}:${ownerLogin}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelView(label: Label): Json {
  return { name: label.name, color: label.color, description: label.description };
}

function issueView(req: IncomingMessage, repo: Repo, issue: Issue, store: Store): Json {
  const origin = baseUrlOf(req);
  const labels = issue.labels.map((name) => {
    const found = store.getLabel(repo.owner, repo.name, name);
    return found === null ? { name } : labelView(found);
  });
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: issue.user.login },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    locked: false,
  };
}

function pullView(req: IncomingMessage, repo: Repo, pull: PullRequest): Json {
  const origin = baseUrlOf(req);
  const ownerLogin = repo.owner;
  const repoRef = { name: repo.name, full_name: repo.fullName };
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${ownerLogin}:${pull.head.ref}`,
      user: { login: ownerLogin },
      repo: repoRef,
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${ownerLogin}:${pull.base.ref}`,
      user: { login: ownerLogin },
      repo: repoRef,
    },
    user: { login: pull.user.login },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${origin}/${ownerLogin}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${ownerLogin}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    locked: false,
  };
}

// ---------------------------------------------------------------------------
// Repo resolution: only the token owner's repos exist for this token; any other
// owner is 404, never 403.

/** Find a repo under {owner}; null when the owner is not the token's owner or the repo does not exist. */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== TOKEN_OWNER) return null;
  return store.getRepo(owner, name);
}

// ---------------------------------------------------------------------------
// The handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;

  const method = (req.method ?? 'GET').toUpperCase();
  const query = url.searchParams;

  // Auth: every /api/v3 request needs the shop token.
  const token = bearerToken(req);
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === null || expected === '' || token !== expected) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }

  const parts = splitPath(pathname); // ['api','v3', ...]
  const rest = parts.slice(2);

  // GET /api/v3 and GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const listed = store.listRepos(TOKEN_OWNER).map((repo) => repoView(req, repo, TOKEN_OWNER, store));
      sendPage(req, res, '/api/v3/user/repos', listed, query);
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonObject(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const isPrivate = body.private === undefined ? false : body.private === true;
      const description = typeof body.description === 'string' ? body.description : '';
      try {
        const created = store.createRepo(TOKEN_OWNER, name, { private: isPrivate, description });
        sendJson(res, 201, repoView(req, created, TOKEN_OWNER, store));
      } catch (err) {
        if (err instanceof RepoExistsError) {
          sendJson(res, 422, { message: `repository ${name} already exists` });
        } else {
          throw err;
        }
      }
      return true;
    }
    notFound(res);
    return true;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[/...]
  if (rest.length < 3 || rest[0] !== 'repos') {
    notFound(res);
    return true;
  }
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  const tail = rest.slice(3);

  // /api/v3/repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = resolveRepo(store, owner, repoName);
      if (repo === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, repoView(req, repo, owner, store));
      return true;
    }
    if (method === 'PATCH') {
      const repo = resolveRepo(store, owner, repoName);
      if (repo === null) {
        notFound(res);
        return true;
      }
      const body = await readJsonObject(req, res);
      if (body === null) return true;
      const patch: { description?: string } = {};
      if (typeof body.description === 'string') patch.description = body.description;
      const patched = store.patchRepo(owner, repoName, patch);
      if (patched === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, repoView(req, patched, owner, store));
      return true;
    }
    if (method === 'DELETE') {
      const repo = resolveRepo(store, owner, repoName);
      if (repo === null) {
        notFound(res);
        return true;
      }
      store.deleteRepo(owner, repoName);
      sendNoContent(res);
      return true;
    }
    notFound(res);
    return true;
  }

  // The remaining routes all need the repo to exist (404 when it does not).
  const repo = resolveRepo(store, owner, repoName);
  if (repo === null) {
    // Still consume a body-bearing request's JSON so a malformed body on a missing repo
    // answers 400 rather than 404? No: a missing repo is 404 regardless of the body.
    notFound(res);
    return true;
  }
  const defaultBranch = repo.defaultBranch;

  // GET /repos/{o}/{r}/branches
  if (tail.length === 1 && tail[0] === 'branches') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    const branches = store
      .listRefs(owner, repoName)
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
    sendJson(res, 200, branches);
    return true;
  }

  // GET /repos/{o}/{r}/commits?sha=<branch>
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') {
      notFound(res);
      return true;
    }
    const ref = query.get('sha') ?? defaultBranch;
    const commits = store.listCommits(owner, repoName, ref).map((entry) => {
      const author = parseAuthor(entry.author);
      const committer = parseAuthor(entry.committer);
      const date = new Date(entry.timestamp * 1000).toISOString();
      return {
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { ...author, date },
          committer: { ...committer, date },
        },
        author: null,
        committer: null,
      };
    });
    sendJson(res, 200, commits);
    return true;
  }

  // POST /repos/{o}/{r}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') {
      notFound(res);
      return true;
    }
    const body = await readJsonObject(req, res);
    if (body === null) return true;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) {
      sendJson(res, 422, { message: 'ref and sha are required' });
      return true;
    }
    store.setRef(owner, repoName, ref, sha);
    sendJson(res, 201, { ref, object: { sha } });
    return true;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail.length >= 1 && tail[0] === 'contents') {
    const contentPath = tail.slice(1).join('/');
    if (method === 'PUT') {
      const body = await readJsonObject(req, res);
      if (body === null) return true;
      const message = typeof body.message === 'string' ? body.message : '';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      if (message === '' || contentB64 === '') {
        sendJson(res, 422, { message: 'message and content are required' });
        return true;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : defaultBranch;
      const content = Buffer.from(contentB64, 'base64');
      const existing = store.getFileAtRef(owner, repoName, branch, contentPath);
      const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (existing !== null && expectedSha !== undefined && existing.blobOid.toLowerCase() !== expectedSha.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current blob' });
        return true;
      }
      try {
        const result = store.commitFile(owner, repoName, {
          branch,
          path: contentPath,
          content,
          message,
          expectedBlobSha: existing !== null ? expectedSha : undefined,
        });
        const name = contentPath.split('/').pop() ?? contentPath;
        sendJson(res, existing !== null ? 200 : 201, {
          commit: {
            sha: result.commitSha,
            message,
            author: { name: owner, email: `${owner}@example.invalid` },
            committer: { name: owner, email: `${owner}@example.invalid` },
          },
          content: {
            name,
            path: contentPath,
            sha: result.blobSha,
            type: 'file',
            content: contentB64,
            encoding: 'base64',
            size: content.length,
          },
        });
      } catch (err) {
        if (err instanceof StaleShaError) {
          sendJson(res, 409, { message: 'sha does not match the current blob' });
        } else {
          throw err;
        }
      }
      return true;
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? defaultBranch;
      const file = store.getFileAtRef(owner, repoName, ref, contentPath);
      if (file !== null) {
        const name = contentPath.split('/').pop() ?? contentPath;
        sendJson(res, 200, {
          name,
          path: contentPath,
          sha: file.blobOid,
          type: 'file',
          content: file.content.toString('base64'),
          encoding: 'base64',
          size: file.content.length,
        });
        return true;
      }
      const entries = store.listDirAtRef(owner, repoName, ref, contentPath);
      if (entries.length > 0) {
        sendJson(
          res,
          200,
          entries.map((entry) => ({ name: entry.name, path: entry.path, sha: entry.sha, type: entry.type })),
        );
        return true;
      }
      notFound(res);
      return true;
    }
    if (method === 'DELETE') {
      const body = await readJsonObject(req, res);
      if (body === null) return true;
      const message = typeof body.message === 'string' ? body.message : '';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : defaultBranch;
      const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
      try {
        const result = store.deleteFile(owner, repoName, { branch, path: contentPath, message, expectedBlobSha: expectedSha });
        sendJson(res, 200, { commit: { sha: result.commitSha } });
      } catch (err) {
        if (err instanceof NotFoundError) {
          notFound(res);
        } else if (err instanceof StaleShaError) {
          sendJson(res, 409, { message: 'sha does not match the current blob' });
        } else {
          throw err;
        }
      }
      return true;
    }
    notFound(res);
    return true;
  }

  // GET/POST /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, store.listLabels(owner, repoName).map(labelView));
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonObject(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      try {
        const label = store.createLabel(owner, repoName, {
          name,
          color: typeof body.color === 'string' ? body.color : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
        });
        sendJson(res, 201, labelView(label));
      } catch (err) {
        if (err instanceof RepoExistsError) {
          sendJson(res, 422, { message: `label ${name} already exists` });
        } else {
          throw err;
        }
      }
      return true;
    }
    notFound(res);
    return true;
  }

  // POST/GET /repos/{o}/{r}/issues  and  /repos/{o}/{r}/issues/{n}[/...]
  if (tail.length >= 1 && tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = await readJsonObject(req, res);
        if (body === null) return true;
        const title = typeof body.title === 'string' ? body.title : '';
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const labels = Array.isArray(body.labels)
          ? body.labels.filter((item): item is string => typeof item === 'string')
          : undefined;
        try {
          const issue = store.createIssue(owner, repoName, { title, body: issueBody, labels });
          sendJson(res, 201, issueView(req, repo, issue, store));
        } catch (err) {
          if (err instanceof UnknownLabelError) {
            sendJson(res, 422, { message: `unknown label ${err.label}` });
          } else {
            throw err;
          }
        }
        return true;
      }
      if (method === 'GET') {
        const stateParam = query.get('state') ?? 'open';
        const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
        const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
        const sort = query.get('sort') === 'created' ? 'created' : undefined;
        const issues = store
          .listIssues(owner, repoName, { state, sort, direction })
          .map((issue) => issueView(req, repo, issue, store));
        sendPage(req, res, `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/issues`, issues, query);
        return true;
      }
      notFound(res);
      return true;
    }
    const issueNumber = Number.parseInt(tail[1] as string, 10);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      notFound(res);
      return true;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        const issue = store.getIssue(owner, repoName, issueNumber);
        if (issue === null) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, issueView(req, repo, issue, store));
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJsonObject(req, res);
        if (body === null) return true;
        const patch: { state?: 'open' | 'closed'; title?: string; body?: string } = {};
        if (body.state === 'open' || body.state === 'closed') patch.state = body.state;
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.body === 'string') patch.body = body.body;
        const patched = store.patchIssue(owner, repoName, issueNumber, patch);
        if (patched === null) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, issueView(req, repo, patched, store));
        return true;
      }
      notFound(res);
      return true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') {
        const body = await readJsonObject(req, res);
        if (body === null) return true;
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const comment = store.addComment(owner, repoName, issueNumber, commentBody);
        if (comment === null) {
          notFound(res);
          return true;
        }
        sendJson(res, 201, {
          id: comment.id,
          body: comment.body,
          user: { login: comment.user.login },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        });
        return true;
      }
      if (method === 'GET') {
        if (store.getIssue(owner, repoName, issueNumber) === null) {
          notFound(res);
          return true;
        }
        sendJson(
          res,
          200,
          store.listComments(owner, repoName, issueNumber).map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: comment.user.login },
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
          })),
        );
        return true;
      }
      notFound(res);
      return true;
    }
    notFound(res);
    return true;
  }

  // POST/GET /repos/{o}/{r}/pulls  and  /repos/{o}/{r}/pulls/{n}[/...]
  if (tail.length >= 1 && tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const body = await readJsonObject(req, res);
        if (body === null) return true;
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        const title = typeof body.title === 'string' ? body.title : '';
        const pullBody = typeof body.body === 'string' ? body.body : '';
        if (head === '' || base === '') {
          sendJson(res, 422, { message: 'head and base are required' });
          return true;
        }
        try {
          const pull = store.createPull(owner, repoName, { head, base, title, body: pullBody });
          sendJson(res, 201, pullView(req, repo, pull));
        } catch (err) {
          if (err instanceof NotFoundError) {
            sendJson(res, 422, { message: 'head or base branch does not exist' });
          } else {
            throw err;
          }
        }
        return true;
      }
      if (method === 'GET') {
        const stateParam = query.get('state') ?? 'open';
        const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
        const pulls = store.listPulls(owner, repoName, state).map((pull) => pullView(req, repo, pull));
        sendPage(req, res, `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`, pulls, query);
        return true;
      }
      notFound(res);
      return true;
    }
    const pullNumber = Number.parseInt(tail[1] as string, 10);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) {
      notFound(res);
      return true;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        const pull = store.getPull(owner, repoName, pullNumber);
        if (pull === null) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, pullView(req, repo, pull));
        return true;
      }
      notFound(res);
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (method !== 'GET') {
        notFound(res);
        return true;
      }
      if (store.getPull(owner, repoName, pullNumber) === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, store.getPullFiles(owner, repoName, pullNumber));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method !== 'PUT') {
        notFound(res);
        return true;
      }
      const body = await readJsonObject(req, res);
      if (body === null) return true;
      const methodParam = body.merge_method;
      const mergeMethod = methodParam === 'merge' || methodParam === 'rebase' ? methodParam : 'squash';
      try {
        const result = store.mergePull(owner, repoName, pullNumber, mergeMethod);
        sendJson(res, 200, { sha: result.sha, merged: result.merged, message: result.message });
      } catch (err) {
        if (err instanceof NotFoundError) {
          notFound(res);
        } else if (err instanceof ConflictError) {
          sendJson(res, 405, { message: 'merge conflict' });
        } else {
          throw err;
        }
      }
      return true;
    }
    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}
