// github-core-clone-01 — the forge's HTTP server and router.
//
// One Store per process, shared by every surface. Routing:
//   GET /healthz            -> 200 {ok: true} (no auth; the env's boot probe)
//   /api/graphql           -> graphql.ts (GraphQL v4)
//   /mcp                   -> mcp.ts (Model Context Protocol, streamable HTTP)
//   /api/v3/*              -> rest.ts (REST v3)
//   /{owner}/{repo}.git/*  -> git.ts (git smart HTTP)
//   anything else          -> 404 JSON {message: 'Not Found'}
//
// main.ts owns the lifecycle (bind, register, poll /done); this file only builds the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendJson } from './http.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          if (await handleGraphql(req, res, store)) return;
        }

        // Model Context Protocol, streamable HTTP.
        if (path === '/mcp') {
          if (await handleMcp(req, res, store)) return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store)) return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(req, res, store)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler that throws must not kill the server or hang the request.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
