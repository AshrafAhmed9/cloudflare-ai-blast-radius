# Limitations

What this tool cannot tell you, stated plainly rather than discovered later.

## It never establishes runtime safety

A Terraform plan describes what Terraform will change in your infrastructure
provider's API. It says nothing about live traffic, redundancy, backup
recoverability, runtime health, or dependencies outside Terraform's view
(a hand-run script, a manually created resource, another team's Terraform
state). "No finding under supported checks" means exactly that — not "safe."
The UI and CLI deliberately never print the word "safe" unqualified.

## Rule pack coverage: 6 resource types

`src/core/rules.ts` currently covers `aws_db_instance`, `aws_rds_cluster`,
`aws_s3_bucket`, `aws_ebs_volume`, `cloudflare_d1_database`, and
`cloudflare_dns_record`. Every other resource type gets `coverage: unsupported`
— its planned action (create/update/delete/replace) is still reported, but no
severity judgment is made. This is intentional: a rule pack that claims broad
coverage by reproducing guessed provider `ForceNew` semantics would be worse
than one that's honest about being narrow. See `docs/decisions.md` for the
"do not hard-code simplistic claims" reasoning behind keeping this small.

## Replacement cause is only shown when Terraform's plan JSON provides it

Terraform's `replace_paths` field is populated for known-value replacements
but is often absent for tainted resources or explicit `-replace` requests.
When that happens, this tool reports `coverage: partial` with an explicit
"replacement cause unavailable" note — it does not guess which attribute
caused the replacement. See the `incomplete-evidence` sample plan for exactly
this case.

## The reference graph is partial by design

`src/core/graph.ts` resolves references only between single-instance,
root-module resources. It explicitly does **not** attempt to resolve:

- resources using `count` or `for_each` (reported as unresolved — an
  instance can't be safely joined to a config address by string prefix)
- resources inside nested modules
- references that pass through `var.`, `local.`, module outputs, or
  `for_each`/`count.index` expressions as intermediate hops

Every skipped reference is listed in `unresolvedReferences` with a reason,
rather than silently dropped. A resource with no listed dependents may still
have real dependents this tool couldn't resolve — the report says how many
references were unresolved, so this isn't hidden.

## The model cannot change a finding, and can decline to answer

Chat answers are grounded in the deterministic report and checked afterward
for resource ids that don't exist in the plan (`src/ai/verify.ts`) — this
catches invented resource addresses, not arbitrary false statements in
prose. If asked to reclassify a finding's severity, the system prompt
instructs the model to refuse and explain why; there is also no code path
that lets AI output write back into `AnalysisResult.findings`.

## The policy compiler's own limits

It only ever produces a rule from a fixed, small allowlist of resource types
and actions (`src/policies/types.ts`) — a sentence about anything outside
that (a resource type this tool has no rule for, an attribute not in the
predicate allowlist, something the plan genuinely can't establish like
"ensure backups are recoverable") is refused, not guessed into the nearest
fit. A refusal is the correct behavior here, not a bug, but it does mean the
compiler will decline plenty of reasonable-sounding policies. There is no
held-out accuracy benchmark for the compiler yet — it's unit-tested against
mocked model responses (including a malformed-JSON retry path), not measured
against a labeled set of real English sentences the way `bench/` was planned
to for the deterministic core. See "Not built in this pass" below.

## Not built in this pass

- **`bench/` accuracy measurement** against a larger real-plan corpus, and a
  held-out evaluation set for the policy compiler specifically. The CLI has
  been run against all three bundled sample plans with correct output
  (shown in the README), but that's 3 plans, not a benchmark.
- **Delete-workspace endpoint** and documented retention policy beyond the
  cookie's 30-day expiry, the 20-review retention cap, and the 30-policy
  retention cap.

## Adversarial-review findings

A structured adversarial review ran against this codebase partway through
the build: real probes against the actual source and, later, the deployed
app, not a read-through. It found 15 numbered issues (R1–R15). Given the
size of that list against remaining build time, this pass triaged rather
than implementing all of it. What follows is the honest disposition of
each.

**Fixed this pass, each with a regression test:**

- **R1 (infinite loop, confirmed and fixed):** `fetchWorkspaceState()` called
  `selectReview()` whenever an active review existed, and `selectReview()`
  called `fetchWorkspaceState()` again at the end — unbounded mutual
  recursion. Fixed by splitting into `refreshReviewList()` (list-only,
  never selects) and `hydrateWorkspace()` (runs once, on page load).
  `test/ui-loop.test.ts` loads the real `ui/app.js` against stubbed
  fetch/DOM and fails against the pre-fix code, passes against the fix —
  verified both directions, not just asserted.
- **R5 partial (S3 bucket rule, confirmed and fixed):** the rule only
  matched plain `delete`, not a replacement (which also deletes the old
  bucket). One-line fix in `src/core/rules.ts`; `test/rules.test.ts` covers
  both replace orders for every stateful-resource rule, not just S3.
- **R4 partial (`action_reason` location, confirmed and fixed):** verified
  against the actual HashiCorp JSON format spec — the field is a sibling of
  `change` on the resource_changes[] entry, not nested inside it. Was
  reading the wrong location, so it was always silently `undefined`.
- **R11 partial (chat verifier address matching, confirmed and fixed):** the
  regex used to check whether a chat answer's cited resource ids are real
  dropped bracket suffixes (`aws_instance.web[0]` → `aws_instance.web`, no
  longer matching the real address) and truncated module-qualified
  addresses to their last two segments. Verified both failures with a
  standalone `node -e` regex test before fixing, then added regression
  tests for indexed, module-qualified, and data-source addresses.
- **R6 (policy predicate path matching, confirmed and fixed):** the path
  predicate interpreter used `.includes()` — a substring check — so a
  predicate value like `"id"` matched paths like `identifier` or
  `availability_zone_id`, and `"engine"` matched `engine_version`. A user's
  English policy sentence compiled correctly but then matched resources it
  shouldn't have. Fixed with exact whole-path or whole-segment matching in
  `src/policies/interpret.ts`; `test/policy-interpret.test.ts` covers both
  the false-positive cases and that a legitimate nested-leaf match (e.g.
  `tags[0].value` matching predicate `"value"`) still works. Also removed
  `redactValue` from `src/core/sanitize.ts` — it was dead code (unused in
  production) that implied an active-redaction step that doesn't exist;
  `ResourceChangeFact` never carries raw resource values to begin with, so
  there's nothing to redact. README and `src/ai/context.ts` updated to
  describe the real guarantee (omission by construction, not redaction).
- **R15 partial (misleading CI example):** the README's one-line CLI usage
  example (`cmd || test $? -eq 1 && echo ...`) always exits 0 regardless of
  the underlying finding, due to shell operator grouping — meaning it would
  silently never fail a CI step even on a real high-severity finding.
  Replaced with a correct example plus an explanation of why the compound
  form was wrong.

- **R7 (policy confirmation binding, confirmed and fixed):** `POST
  /policy/confirm` used to accept a client-supplied `(sentence, rule,
  proposalHash)` triple, checking only that the hash matched what it
  recomputed server-side. That stopped an *edited* proposal from reusing an
  old approval, but nothing stopped someone from skipping `/policy/propose`
  entirely and calling `/policy/confirm` directly with a hash they computed
  themselves — the hash function is public and stateless, not a
  server-issued secret. Fixed by adding a `policy_proposals` SQLite table:
  `/policy/propose` now stores the compiled (sentence, rule) server-side
  under an opaque UUID with a 10-minute TTL, and `/policy/confirm` takes
  only that id — the sentence and rule it persists are read from the stored
  row, never from the client's request body, and the row is deleted on use
  so it can't be confirmed twice. `ui/app.js` updated to send `proposalId`
  instead of the old triple, and to check the confirm response's HTTP
  status before showing "Saved" (previously ignored). **Not yet covered by
  an automated test** — exercising this needs the real Durable Object
  request lifecycle (`this.sql`, TTL expiry), which the current test suite
  doesn't reach; see R13 below for the missing Workers-runtime integration
  test harness this and other agent.ts logic needs.
- **R2 (workspace bootstrap race, confirmed and fixed):** the UI used to
  open its WebSocket, the `/reviews` fetch, and the `/policies` fetch
  independently rather than sequencing one awaited bootstrap first, so
  their responses could race on a cookie-less first visit and split one
  browser session across two Durable Object instances. Fixed with a single
  `/api/bootstrap` endpoint in `worker.ts` that the client awaits before
  anything else connects (`ui/app.js`'s `bootstrapAndStart()`).
  `test/worker-bootstrap.test.ts` exercises the real exported `fetch`
  handler directly: exact cookie-name parsing (a cookie merely ending in
  `br_workspace` must not be adopted) and idempotent Set-Cookie behavior.

**Confirmed real, not fixed this pass — tracked, not hidden:**

- **R8 (mostly fixed):** two crashes were reproduced and fixed — `POST
  .../review` with a JSON body that parses to `null` (or any non-object)
  threw instead of returning 400, and a plan whose
  `configuration.root_module.resources` is an object instead of an array
  threw `TypeError: resources is not iterable` in the graph builder instead
  of degrading to "no resources." Both are guarded now (`src/agent.ts`,
  `src/core/graph.ts`); the graph fix has a regression test, the
  request-body fix doesn't yet, since exercising it needs the real Durable
  Object request path (same gap as R7 — see above). Also added: an Origin
  check on every state-changing (`POST`/`DELETE`/`PUT`) request to
  `/agents/*` in `worker.ts`, rejecting a mismatched cross-origin request
  with 403 (tested in `test/worker-bootstrap.test.ts`) — the workspace
  cookie's `SameSite=Lax` already blocks this in modern browsers, but that
  was a browser default this server wasn't itself enforcing; and a
  hard size cap on every WebSocket frame (`MAX_WS_FRAME_BYTES` in
  `src/agent.ts`), rejected before it's even parsed. Rejecting generic
  client-state writes through the Agents SDK's `validateStateChange` hook
  is still open — the only state this app writes through `setState` is
  `{ reviews, activeReviewId }`, both server-computed, but that guard
  hasn't been added explicitly yet.
- **R3 (confirmed and fixed):** the chat client optimistically rendered the
  user's own message locally, then rendered it again when the server
  broadcast the persisted copy back — every question appeared twice.
  Reconnect also only updated the status text; any assistant reply that
  landed while the socket was down (the fire-and-forget opening summary,
  most often) was never fetched, so the chat looked stuck. Fixed in
  `ui/app.js`: the optimistic append is gone (the server's broadcast is now
  the only render path for a sent message), and `rehydrateActiveReview()`
  re-pulls the canonical message list from `GET /review/:id` on every
  connect, replacing rather than appending so a reconnect can't
  double-render either. Chat input is now also disabled while
  disconnected instead of silently swallowing a submit.
- **R9 (confirmed and fixed):** the current chat question was included in
  its own history twice, once via the SQL read (which ran *after* the
  question was already inserted) and once as the explicit final message,
  doubling every request's token cost and risking a confused answer. Fixed
  by reading history before inserting the question. Also: every Workers AI
  call (the opening summary and every chat turn) previously had no timeout
  and could hang indefinitely on a stalled request, and a failed summary
  was silently swallowed with `.catch(() => {})` with no trace anywhere.
  Both calls are now bounded to 20s (`withTimeout` in `src/agent.ts`), a
  timed-out or failed chat turn now always leaves an honest assistant
  message in the transcript instead of leaving the user staring at
  nothing, and a `summary_status` column (`pending`/`completed`/`failed`,
  returned from `GET /review/:id`) makes the opening-summary outcome
  inspectable instead of invisible. Also added a running budget: a
  per-workspace `usage` counter (`chargeAiCall()` in `src/agent.ts`) caps
  total Workers AI calls at `MAX_AI_CALLS_PER_WORKSPACE` (500), so a stuck
  client or a chat loop can't run up an unbounded inference bill against
  one workspace — once hit, chat says so plainly instead of pretending to
  keep working.
- **R10 (partial, confirmed and fixed):** `CREATE TABLE IF NOT EXISTS`
  only runs once, on a Durable Object's first ever request — a workspace
  already provisioned before a column was added would keep the old schema
  forever (this had already silently happened once, for
  `policy_findings_json`/`policy_revision_json`). Fixed with idempotent
  `ALTER TABLE ADD COLUMN` migrations wrapped in try/catch (SQLite has no
  `ADD COLUMN IF NOT EXISTS`, so "column already exists" is how you detect
  "already migrated"). Also added `DELETE /workspace`, which wipes every
  review, message, policy, and pending policy proposal for that
  workspace — there was previously no way to actually ask for your data
  gone, only the 20-review retention cap eventually rolling it off. AI
  call budgets beyond the per-call timeout (a running total, a
  concurrency cap) are still not built.
- **R12 (mostly fixed):** the report used to render resources in plan
  order, so the one high-severity finding in a large plan could be well
  below the fold. `ui/app.js` now sorts resources by worst finding first
  (high, then notable, then none), stable otherwise. Also added: `aria-live`
  regions on status text, the report, the chat log, and the policy preview
  so a screen reader announces updates instead of silence; labels on every
  form input; `aria-pressed` on review-selector buttons; and a visible
  `:focus-visible` outline for keyboard navigation. An expandable
  per-resource evidence panel (currently everything is always shown, which
  is more honest than hiding it behind a click but gets long on a big
  plan) is still open.
- **R13:** a real `bench/` harness with a larger held-out plan corpus and
  Workers-runtime integration tests is still open. This project ships 3
  sample plans, and a "benchmark" script over the same 3 plans the CLI and
  CI already exercise wouldn't measure anything the existing test suite
  doesn't already cover — it would just be a number for its own sake, so
  it wasn't built rather than faked.

This section exists because publishing "everything works" after finding 15
real issues and fixing only some of them would be dishonest. R1, R2, R3,
R4 (partial), R5 (partial), R6, R7, R8 (mostly), R9, R10 (partial), R11
(partial), R12 (mostly), and R15 (partial) are fixed, most with a
regression test — a couple couldn't get one without a Durable Object test
runtime this project doesn't have yet (noted inline above). They were
chosen because they either directly undermined this project's own thesis
(the S3 rule gap, the chat-grounding regex bugs, the policy false
positives) or were an outright functional or security gap (the UI loop,
the workspace race, a policy confirmable without ever being previewed,
two crashes on malformed input, an unenforced-in-code Origin check, an
unbounded AI-call budget). The rest is real
work, not an excuse.

## Input limits (may reject a legitimate large plan)

1 MiB request body, 200 changed resources per review, 20 retained reviews per
workspace, 2000 characters per chat message. These are conservative starting
points (`src/agent.ts`), not load-tested — a legitimately large plan (a big
module apply) could hit the resource-count limit and get rejected outright
rather than degraded gracefully. Documented rather than silently enforced.
