# github-core-clone-01 — stage-1 builder report

Entry: a standalone single-process GitHub-compatible forge (TypeScript, Node stdlib only,
no git binary, no install step), built from the kit starter. `main.ts` is the starter's
lifecycle verbatim (bind ephemeral port → POST `$MAKEFUN_ENV_URL/register` → poll
`$MAKEFUN_ENV_URL/done` → exit 0). All surfaces serve one in-memory store.

Entrant: @valdodamanik12-blip · Harness: agent/v1 · Entries close 2026-11-21T06:30:00Z.
Pod limits: `node /bot/main.ts`, Node 22, 2 CPU / 1024 MB / 256 pids, /bot read-only,
trial wall 900 s. A crash / no-register / timeout scores 0 on every column, so the server
is written defensively: every handler is wrapped, malformed input gets an error reply,
never an exception that escapes.

---

## 1. Suite inventory (from the kit: sdk/conformance + program/scorer)

### Scoring (manifest.ts, program/scorer/columns.ts, score.ts)

```
score   = feature + agent + perf                      (0..1000, the rank column)
feature = round(600 * passedChecks / 120)             (all conformance checks)
agent   = round(200 * mcpPassed / 15)                 (the mcp group counted twice: it is
                                                       inside the 120 AND the agent column)
perf    = sum of 4 workload points, each
          round(clamp(25 - 12.5*log2(p50_ms / T_ref_ms), 0, 50))
working = 1 when the export says the store works and >= 1 check passed
tie-break: perf_p50_us ascending (geometric mean of measured workloads' p50), then receipt
```

A prize requires scoring **strictly above the house reference forge** (a statistical tie
does not beat it). The reference forge passes 120/120 (calibration.json), so a paid place
needs essentially a full pass plus competitive perf.

Check groups (120): **git 30 · repos 15 · issues 15 · pulls 20 · graphql 20 · mcp 15 ·
protocol 5**. Each check ≈ 5 feature points; each mcp check ≈ 5 + 13.3 agent points.

Perf T_refs (calibration.json, measured on the production cluster; the reference forge
earns 25/workload at exactly T_ref, ~100/200 total):

| workload | work per round | rounds | T_ref p50 |
|---|---|---|---|
| push | 200 sequential receive-pack pushes, 1 KiB change, one repo | 3 (median) | 1640.82 ms |
| clone | 50 concurrent shallow (depth 1) clones of a 200-commit repo | 3 | 266.941 ms |
| read | 2,000 sequential GET one issue, one keep-alive connection | 3 | 2759.715 ms |
| write | 200 sequential POST issue creations | 3 | 348.965 ms |

Each workload has a 60 s budget (240 s for the phase); a workload that fails or is cut
scores 0 and writes p50 = 1e9. 5 warm-up ops precede timing. Setup (repo creation, the
200-commit history push, the read issue) is inside the budget but untimed.

### Fixed scenario (wire.ts `buildScenario()`, seed 0x6a09e667f3bcc909 — one fixed seed for
every trial, verified by running the kit's own code)

- viewer **adaiversen** (id 1000, "ada iversen" <adaiversen@example.invalid>) — the token
  owner; teammate quinnkeller (1001), stranger olgabauer (1002, the "foreign owner").
- Token: `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the forge's own env var).
- 30 seeded repos (repos[0] = `amber-thistle`, default branch `main`); labels
  [bug, enhancement, documentation, question, good first issue, help wanted].
- Server-generated timestamps must be deterministic: this entry uses a fixed epoch
  (1700000000) + a per-forge counter, never the wall clock.

### git group — 30 checks (kit's in-process GitClient; repos via POST /api/v3/user/repos)

advertise-v2, advertise-receive-pack, advertise-headers, unknown-repo-404, ls-refs,
ls-refs-prefix, clone-empty, push-first-commit, clone-object-hashes, clone-blob-bytes,
clone-tree-entries, clone-commit-bytes, clone-annotated-tag, fetch-incremental,
fetch-nothing-new, fetch-shallow-depth1, fetch-shallow-deepen, fetch-shallow-new-tip,
push-update-ref, push-create-branch, push-delete-branch, push-non-fast-forward,
push-mixed-report, push-delete-tag, push-100-files, pack-integrity, pack-deltas,
sideband-framing, push-sideband-report, repo-survives-errors (+ 1 more in table order).

Wire facts the client enforces:
- Advertisement: v2 answer **only** when the request carries `Git-Protocol: version=2`,
  else v0 (`# service=git-upload-pack` preamble, first ref line carries caps after NUL
  incl. `side-band-64k` and `symref=HEAD:refs/heads/main`; empty repo = zero-oid
  `capabilities^{}` line). Receive-pack always v0. Content types
  `application/x-git-{upload,receive}-pack-advertisement`.
- v2 caps advertised here: `version 2`, `ls-refs`, `fetch=shallow` (the client requires
  the `shallow` token in the fetch capability value before it will send depth requests).
- ls-refs v2: lines `<oid> <ref>` with `symref-target:` / `peeled:` attributes, `unborn`
  line for HEAD of an empty repo; `ref-prefix` args filter.
- v2 fetch request: `command=fetch`, capability-argument thin-pack/ofs-delta/no-progress,
  want/have/shallow/deepen lines, delim, `done`, flush. Response sections, delim-separated,
  flush-terminated: `acknowledgments` (NAK / ACK / ready lines), `shallow-info`
  (shallow/unshallow), `packfile` (sideband band 1 = pack, 2 = progress, 3 = error).
- v0 fetch: wants+features, flush, haves+done, flush. Response: shallow/unshallow lines,
  `NAK`, sideband pack, flush. (Do NOT advertise multi_ack*: the client then expects full
  ACK negotiation.)
- Fetch semantics the checks assert: closure(wants) − closure(haves) exactly (no re-sent
  objects); nothing-new ⇒ empty pack; depth N ⇒ commits within N generations of the wants,
  their trees/blobs, shallow-info naming the boundary; `deepen N` behaves as absolute
  depth N from the wants (deepen 2 on a depth-1 clone delivers exactly the parent, moves
  the boundary to it, unshallows the old tip).
- Push: client GETs the v0 receive-pack advertisement, POSTs commands (caps after NUL on
  line 1: report-status, side-band-64k, ofs-delta when advertised), flush, then the pack
  (no pack for delete-only pushes). Report-status must return pkt-line-framed **inside
  sideband band 1**: `unpack ok`, `ok <ref>` / `ng <ref> <reason>` (non-fast-forward).
  Server pack reader must resolve ofs-delta and ref-delta (pack-deltas check pushes a
  delta-encoded pack and clones it back byte-for-byte).
- Malformed POST bodies must not kill the server (repo-survives-errors).

### repos group — 15 checks (REST v3)

pagination (30 seeded repos created, GET /user/repos?per_page=10 walked via absolute
same-origin `Link: rel="next"` URLs, ≥3 pages), root (GET /api/v3/ 200 + `X-OAuth-Scopes`
header), meta (`{"installed_version": non-empty}`), create (201 {name, private};
GET round-trips name/private/default_branch, stable across reads), not-found (JSON 404),
patch (description), delete (204 then GET 404), branches (branch from POST /git/refs
listed with its sha, default branch listed), commits (GET /commits?sha=<branch> lists the
branch commit; the default listing must NOT list an unmerged branch commit),
unauthorized (no token ⇒ 401), foreign-token (same repo name under the stranger's login
⇒ 404, never 403), contents-create / contents-directory / contents-stale-sha (409) /
contents-delete.

Contents contract: PUT on an **unborn** repo creates the first commit on `main` ⇒
201 `{content:{sha, encoding:"base64"}, commit:{sha}}`; update with the current blob sha
⇒ 200/201; stale sha ⇒ 409; GET file ⇒ `{type:"file", encoding:"base64", content, sha,
size}`; GET directory ⇒ array of `{type: file|dir, name, path, sha}`; DELETE {message,
sha} ⇒ 200 `{commit:{sha}}`, then GET 404. PUT accepts `branch` (creates the branch when
the MCP setup falls back to it) and `?ref=` reads another branch.

### issues group — 15 checks

create (201, state open), create-title-body, create-labels (labels POST /labels ⇒ 201
{name}; issue created with an existing label echoes it in `labels:[{name}]`),
numbers-increment (shared issue/PR counter per repo, +1), list-open,
list-open-excludes-closed, list-sort-asc / list-sort-desc (sort=created&direction),
list-shape ({number, title, body, state, labels:[{name}]}), get-one, patch-close,
patch-close-persists, comment-create (201 {id, body}), comments-list, bad-label
(unknown label ⇒ 422 {message}).

### pulls group — 20 checks

create / create-body / create-head-sha / create-base-sha (201 {number, state:"open",
title, body, head:{ref,sha}, base:{ref,sha}}; shas are the branch tips), get-one,
files-list / files-shape / files-multiple (GET /pulls/{n}/files ⇒ [{filename, status
(added|modified), additions ≥1, deletions, changes}]; diff of merge-base tree → head
tree, line counts), merge-status / merge-body (PUT /pulls/{n}/merge {merge_method:
"squash"} ⇒ 200 {sha, merged:true, message}), merge-closes (state closed, merged true,
merged_at non-empty), merge-commit-on-default, merge-content-on-default (squash commit +
content land on the base branch), merge-commit-sha (== the merge reply's sha),
merge-unknown (404), merge-conflict (**405** — two branches change the same file from a
common base, first merges, second conflicts), list-state-all, list-default-open
(default = open only), list-shape, get-unknown (404).

### graphql group — 20 checks (POST /api/graphql, the gh / github-mcp-server documents)

viewer-login, repository-fields (id, databaseId, name, owner{login}, defaultBranchRef
{name}, viewerPermission ∈ ADMIN..READ, hasIssuesEnabled true), introspection-issue
(__type Issue fields ⊇ id, number, title, state, body), introspection-types (PullRequest
fields ⊇ id, number, headRefName, baseRefName, mergeable, state, merged, files;
Repository fields ⊇ the 12 listed; SearchType enumValues ∋ ISSUE), issues-open-order
(states:[OPEN] + orderBy CREATED_AT DESC, ties by number DESC), issue-by-number,
create-issue / close-issue (mutations visible over REST), pull-requests-list,
pull-request-files (files {path}), create-pull-request (repositoryId + pushed head
branch; REST reads back the same head/base), merge-pull-request (SQUASH; REST shows
merged:true, state closed), add-comment (commentEdge.node; REST comment list shows it),
invalid-field (HTTP 200 + `errors` array **naming** the unknown field), unauthenticated
(exactly 401), node-repository (`node(id:)` + `... on Repository`), unknown-repository
(`data.repository` = null, **no** errors), batched-operations (a JSON array body of two
operation documents answers two results in order), global-id-stability (ids opaque —
≠ the plain databaseId/number — and stable across reads), issues-pagination
(first/after cursor + pageInfo{hasNextPage, endCursor}; fixture pages 7 issues 5+2).

Global ids: base64 of `Repository:<dbId>` / `Issue:<repoDbId>:<number>` /
`PullRequest:<repoDbId>:<number>` / `IssueComment:<id>` — opaque, stable, decodable by
node(id:) and the mutation inputs. Fixtures are seeded through REST + real git pushes
(the env installs a git adapter), repo name `<scenario repo0>-graphql`.

### mcp group — 15 checks (JSON-RPC at /mcp, streamable HTTP) — also the agent column

initialize, server-discover, tools-list, tool-schemas, create-issue, list-issues,
create-pull-request, merge-pull-request, unknown-tool, parse-error,
missing-arguments, concurrent-calls, tools-list-idempotent, rest-parity, auth-required.

- Two eras accepted: modern `server/discover` (2026-07-28) or legacy `initialize`
  handshake (≤2025-11-25). A server that refuses discover (404 / -32601) but answers
  initialize passes server-discover as "pre-discover revision" — this entry takes the
  legacy path on purpose.
- tools/list: ≥6 tools incl. create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request (suffix/case-insensitive alias matching);
  every tool needs a non-empty description and an `inputSchema` of type object; two
  tools/list calls must be byte-identical.
- Tool arguments follow github-mcp-server names (the suite maps them onto the schema's
  own property names by synonym): create_repo {name, description?, private?};
  get_repo {owner, repo}; create_issue {owner, repo, title, body?};
  list_issues {owner, repo, state?}; create_pull_request {owner, repo, title, head,
  base}; merge_pull_request {owner, repo, pull_number}. Tools act on the SAME store as
  REST (rest-parity: ids stable across surfaces and repeated reads).
- Errors: unknown tool ⇒ JSON-RPC -32602/-32601, never HTTP 500; missing required
  argument ⇒ isError:true or -32602; non-JSON body ⇒ HTTP 400 with -32700; no
  Authorization ⇒ HTTP 401; each request < 3 s; concurrent calls keep their own ids.

### protocol group — 5 checks

content-type-json (every REST reply application/json, never HTML), unknown-route-json-404,
malformed-body-400 (malformed JSON ⇒ 400 {message}), request-id (every reply carries a
non-empty `X-GitHub-Request-Id`), error-message (401/404/422 bodies carry a string
`message`). Global wire rules: missing/wrong bearer token ⇒ 401; another owner's repo
⇒ 404.

### Benchmark setup shapes worth noting

- push workload: 200 sequential pushes to `bench-push`, each a 3-object pack (blob,
  tree, commit) chained on refs/heads/main — receive-pack must be fast and must not
  re-validate the whole history per push (ancestry walk is short-circuited by the
  parent chain).
- clone workload: setup pushes ONE pack with the whole 200-commit history (600 objects)
  to `bench-clone`; each timed clone is a depth-1 fetch of the tip.
- read/write workloads hit REST only; read reuses one keep-alive connection (Node's
  http server does this natively).

### Running a practice trial locally (the kit's own runner — the sealed checks)

```sh
# 1. start the entry standalone (any free port; token of your choice):
MAKEFUN_SHOP_TOKEN=devtoken node --experimental-strip-types /tmp/run-entry.ts
#    (a 5-line harness outside the repo: import { createApp } from
#     '<repo>/app.ts', listen on 127.0.0.1:8791 — main.ts itself needs the env)

# 2. run the suite against it:
cd ~/workspace/makefun/github-kit/github-core-clone-01-kit
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8791 --token devtoken [--perf] [--json]
```

`sdk/run.ts` runs healthz, then all 120 checks in env order
(git, repos, issues, pulls, protocol, graphql, mcp), then optionally the benchmark,
and prints feature/agent/perf/score. The full env trial (register/done lifecycle) is
`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver docker` per RULES.txt
("Grade locally"); the sdk runner above exercises the identical check code without
docker. A fresh server process per run: fixtures are stateful and names are fixed.

---

## 2. Implementation map

| file | contents |
|---|---|
| `main.ts` | starter lifecycle, verbatim |
| `app.ts` | HTTP server: routing, auth, request-id, JSON discipline, error containment |
| `lib/store.ts` | the forge store: object map, repos, issues, pulls, labels, id counters |
| `lib/gitobj.ts` | sha1 object ids, tree/commit/tag parse+build, pack read (incl. ofs/ref deltas) + write, pkt-line codec |
| `lib/gitproto.ts` | smart HTTP: advertisements (v0/v2), ls-refs, fetch (v0/v2, shallow/deepen), receive-pack + report-status |
| `lib/rest.ts` | REST v3: root/meta/user, repos CRUD + pagination, git refs, branches, commits, contents, labels, issues, comments, pulls + files + squash merge |
| `lib/graphql.ts` | GraphQL lexer/parser + executor for the suite's schema surface, introspection, batching |
| `lib/mcp.ts` | MCP legacy-era endpoint: initialize, tools/list, tools/call over the same store |

Shared logic (tree flatten/rebuild, merge-base, 3-way tree merge, PR file diff) lives in
`lib/gitobj.ts` / `lib/rest.ts` and is used by REST, GraphQL and MCP alike, so the three
surfaces can never disagree about the store.

## 3. Results (local, 2026-11-17, this machine — a quiet 1.5-CPU VM, Node v24)

### Run A — sdk/run.ts, first full pass
119/120. Only failure: `git.fetch-shallow-deepen` ("deepen 2 did not deliver the parent
commit"). Root cause: the have-closure walked the full ancestry of the haves, so the
parent was subtracted as already-held; a shallow client's `shallow` lines cut its held
history at the boundary. Fixed by cutting the have-closure at the client's shallow
commits (`cutCommits` in `Forge.closure`).

### Run B — sdk/run.ts --perf, after the fix
**120/120** — git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql 20/20,
mcp 15/15, protocol 5/5. feature 600, agent 200.

| workload | local p50 | T_ref | points |
|---|---|---|---|
| push | 595.1 ms | 1640.82 ms | 43 |
| clone | 100.5 ms | 266.941 ms | 43 |
| read | 684.9 ms | 2759.715 ms | 50 |
| write | 81.6 ms | 348.965 ms | 50 |
| **perf total** | | | **186** |

Local score: **986 / 1000**, working 1.

### Run C — the sealed env itself (program/env/server.mjs) driving `node main.ts`
Full lifecycle exactly as a trial runs it: env listened, the entry registered its
ephemeral port, the env ran the suite + benchmark, answered done, the entry exited 0.
The env's own export (`export/state.json`, `export/perf.json`):

- counts: **passed 120 / total 120**, working **1**, no failed checks.
- perf: points_total **181** (push 591.7 ms → 43, clone 86.1 ms → 45, read 760.8 ms → 48,
  write 115.8 ms → 45), perf_p50_us **258852**.

Local score via the sealed env: **981 / 1000**.

### Production caveat (read before trusting the perf column)
Local numbers are on a quiet VM. calibration.json records that the reference forge
measured **2.5–4.7× slower** on the production cluster (beside live sandbox pods) than
on a quiet rig, and the T_refs are the production medians — at exactly T_ref a workload
earns 25 points, so the reference itself earns ~100/200 perf on a median production
trial (score ≈ 900, tie-break perf_p50_us ≈ 806k µs). Our local margins under T_ref are
2.7× (push), 2.7× (clone), 3.6–4.0× (read), 3.0–4.3× (write), and our local tie-break
is 259k µs vs the reference's 806k µs. If the production slowdown hits this entry
proportionally, expect perf to land somewhere around the reference's band or better;
conformance (800 of the 1000) does not depend on the venue. Treat 981–986 as a local
ceiling, not a production prediction.

## 4. Known gaps, ranked by expected score impact

1. **Perf on the production venue is unmeasured** (impact: up to ±100 of the perf
   column). Nothing to fix in code at stage 1: the implementation is already
   allocation-light in-memory Maps with no per-request history revalidation (push
   ancestry checks walk only until the ancestor is found; the bench push chain is
   parent-linked). If stage 2 wants more margin, profile the push path first
   (pack inflate bracketing is the only superlinear piece; bench packs are 3 objects,
   so it is already fast).
2. **Protocol corners the suite does not exercise** (impact: 0 on this suite; listed
   so nobody mistakes them for bugs later): no `want-ref` fetch section (wants are
   oid-only in every client path), no multi_ack negotiation (deliberately not
   advertised), no pack deltas on the write side (legal — clients must accept plain
   packs), GraphQL fields beyond the suite's schema list resolve only where listed in
   `TYPE_FIELDS`/`RESOLVERS`, MCP is the legacy initialize era only (the modern
   `server/discover` is refused with -32601, which the suite explicitly passes).
3. **Single-user forge**: the only login is the scenario viewer; any other owner is
   404 by design (that is what the checks require). Repository rename via PATCH is
   supported; issue/PR ids are `repo.id * 1e6 + number` (stable, unique per forge).
4. **State is process-memory only** — correct for the harness (a fresh entry process
   per trial, /bot read-only), and the reason boot is instant.

## 5. Stage-2 notes for the main agent (submit path — not done here, per brief)

- Submission is the **GitHub repository** route (RULES "Enter" step 4) or the source
  bundle route (step 5). For the GitHub route the repo needs, at the submitted commit:
  the competition README badges (`https://make.fun/badge/github-core-clone-01.svg`,
  `.../github-core-clone-01/<owner>/<repo>/rank.svg`, `.../reward.svg`, linking to a
  make.fun page, no `{owner}` placeholders left) and a GitHub About with a make.fun
  website + the `makefun` topic; plus `.makefun/owner.json` with
  `{"wallet": "GAKBqYBbvV2oN8nMwbho7wo2YnrsChtpYzeZd5xV6kss"}` in the first commit
  unless the repo owner is the account's GitHub login (valdodamanik12-blip — it is
  Rivaldo's own login, so the claim file may be unnecessary; keep it anyway for
  safety, it is harmless). The current README.md has no badges yet — rewrite it from
  the requirements' `how_to_submit.readme_template` at push time.
- Before submitting, re-run the two local proofs above against the exact pushed
  commit (sdk runner + sealed env), then `node cli/makefun.mjs check --kit . --repo
  <repo> --transcripts transcripts.tar.gz` from the kit directory, then submit.
- Transcript gate reminders for this competition: min 5 assistant turns, ≥2 file
  revisions of a counted file (this build's session has them: gitobj/graphql/rest
  were each edited after first write), Muse usage rows via `--muse-usage`, run
  record with the user's own opening prompt — the main agent bundles after all
  builder subagents finish.
- Deadline: entries close **2026-11-21T06:30:00Z** (13:30 WIB). The entry is ready
  to push as-is; no code change is needed before stage 2.
