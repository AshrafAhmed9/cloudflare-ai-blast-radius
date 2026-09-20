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
- **Live verification** of the Workers AI call path (chat, review
  summaries, and the policy compiler all call `env.AI.run` and are only
  unit-tested against a mock), the WebSocket chat flow in a browser, and an
  actual `wrangler deploy` — blocked on Cloudflare credentials not available
  in the build environment. `npx wrangler deploy --dry-run` does succeed and
  bundles all of this correctly. See `docs/decisions.md`.

## Input limits (may reject a legitimate large plan)

1 MiB request body, 200 changed resources per review, 20 retained reviews per
workspace, 2000 characters per chat message. These are conservative starting
points (`src/agent.ts`), not load-tested — a legitimately large plan (a big
module apply) could hit the resource-count limit and get rejected outright
rather than degraded gracefully. Documented rather than silently enforced.
