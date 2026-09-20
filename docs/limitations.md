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

A concurrent review session (see `SUBMISSION_REVIEW.md` — kept in the repo
root as the raw record; not a submission artifact itself) inspected this
codebase, ran real probes against the actual source, and found 15 numbered
issues (R1–R15). Given the size of that list against remaining build time,
this pass triaged rather than implementing all of it. What follows is the
honest disposition of each.

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

**Confirmed real, not fixed this pass — tracked, not hidden:**

- **R7 (policy confirmation binding):** `POST /policy/confirm` accepts a
  client-supplied `(sentence, rule, proposalHash)` triple and checks that
  the hash matches what it recomputes server-side. That correctly stops an
  *edited* proposal from reusing an old approval (tested), but it does not
  stop someone from skipping `/policy/propose` entirely and calling
  `/policy/confirm` directly with a hash they compute themselves, since the
  hash function is public and stateless rather than a server-issued opaque
  token. A correct fix stores the proposal server-side (with an id, TTL,
  and the review/revision it was previewed against) and confirms by that id
  — a real design change, not a one-line fix, so it's deferred rather than
  rushed.
- **R2 (workspace bootstrap race):** the UI opens its WebSocket, the
  `/reviews` fetch, and the `/policies` fetch independently rather than
  sequencing one awaited bootstrap first; in principle their responses
  could race on a cookie-less first visit. Not reproduced with a failing
  test in this pass — flagged as plausible, not confirmed, unlike the items
  above which were each verified failing before being fixed.
- **R3, R8, R9, R10, R12, R13:** UI truthfulness details (stale cache on
  reconnect, optimistic-append double-counting, unchecked confirm/delete
  responses), input-validation hardening (size/origin/state-write
  protection), AI-call cost/status persistence, a SQLite migration path for
  already-deployed workspaces with the pre-policy schema, UI evidence-panel
  polish, and a real `bench/` harness with Workers-runtime integration
  tests. Each is a real, legitimate gap the review correctly identified;
  none were reproduced with a failing test or fixed in this pass given
  remaining time. Treat `SUBMISSION_REVIEW.md` as the authoritative task
  list if this project continues.

This section exists because publishing "everything works" after finding 15
real issues and fixing 5 of them would be dishonest. The 5 fixed here were
chosen because they were cheap to verify, cheap to fix, and either directly
undermined this project's own thesis (S3 rule gap, chat-grounding regex) or
were an outright functional bug (the UI loop). The rest are real work, not
excuses.

## Input limits (may reject a legitimate large plan)

1 MiB request body, 200 changed resources per review, 20 retained reviews per
workspace, 2000 characters per chat message. These are conservative starting
points (`src/agent.ts`), not load-tested — a legitimately large plan (a big
module apply) could hit the resource-count limit and get rejected outright
rather than degraded gracefully. Documented rather than silently enforced.
