# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/valdodamanik12-blip/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/valdodamanik12-blip/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone single-process forge for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01), built from the
contest starter. TypeScript on Node's standard library only: no packages to install,
no git binary, no outside service.

## Run

```sh
node main.ts
```

The platform runs `node /bot/main.ts` (Node 22). `main.ts` is the harness lifecycle:
bind an ephemeral port, POST `{"port": N}` to `$MAKEFUN_ENV_URL/register`, poll
`$MAKEFUN_ENV_URL/done`, exit 0. Requests are authenticated with
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Surfaces (one in-memory store behind all four)

- **Git smart HTTP** at `/{owner}/{repo}.git` — ref advertisement (protocol v0 and
  v2), `ls-refs`, fetch (v0 + v2, shallow/deepen), receive-pack with report-status.
  Objects, packfiles (including ofs/ref delta resolution) and the pkt-line codec are
  implemented in-process (`lib/gitobj.ts`, `lib/gitproto.ts`).
- **REST v3** under `/api/v3` — repositories (with `Link`-header pagination), git
  refs, branches, commits, the contents API, labels, issues, comments, and pull
  requests with changed-file lists and squash merges (`lib/rest.ts`).
- **GraphQL v4** at `/api/graphql` — the query/mutation documents `gh` and
  github-mcp-server send: viewer, repository fields, `__type` introspection, issue
  and pull-request connections with cursor pagination, `node(id:)`, batched
  operations (`lib/graphql.ts`).
- **MCP** at `/mcp` — JSON-RPC tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) over the legacy
  `initialize` handshake era, acting on the same store (`lib/mcp.ts`).

State is deterministic: server-authored commits use a fixed epoch plus a counter,
never the wall clock. See `REPORT.md` for the conformance-suite inventory and the
stage-1 results.

---

<sub>Entered on [make.fun](https://make.fun/?ref=f1z3jcpa&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
