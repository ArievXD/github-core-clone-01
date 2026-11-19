# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ArievXD/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ArievXD/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process — no git binary, no outside service, no UI. It serves git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, and MCP from a single deterministic in-process store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The env records the address the request came from plus that port as your base URL and dials it from then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards, and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is in your environment); `/healthz` is the boot probe and takes none. A missing or wrong token is refused with 401; a repository under another owner is 404, never 403.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP checks again as the agent-native column, and four timed workloads. Local run against the kit's own suite: **120/120 checks, 973/1000** (feature 600, agent 200, perf 173).

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server and router — one `Store` per process, shared by every surface.
- `store.ts` + `gitobj.ts`: the in-memory store (repos, refs, objects, issues, PRs, labels, contents) and the git object model (blobs/trees/commits/tags, pack v2 read/write, pkt-line, deltas). Timestamps are `STORE_EPOCH_SEC` (2025-01-01T00:00:00Z) plus a store-wide monotonic counter — never the wall clock — so two runs on the same instance leave identical state.
- `git.ts`: git smart HTTP — v2 advertisement + `ls-refs`/`fetch`, v0 advertisement, receive-pack v0 with fast-forward enforcement and sideband status reports.
- `rest.ts`: REST v3 (`handleRest`).
- `graphql.ts`: GraphQL v4 — a tokenizer/parser plus a typed selection-set executor for exactly the documents `gh` and `github-mcp-server` send.
- `mcp.ts`: MCP over streamable HTTP — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- `http.ts`: shared JSON/body/auth/request-id helpers.
- `DESIGN.md`: the architecture and the store/git-object interfaces the modules share.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page: **https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach. The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eqt68ze1&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
