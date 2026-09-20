# Decisions

A handful of actual tradeoffs, not a full design log. See `PLAN.md` for the
requirements and constraints these decisions serve.

## Why Agent (Durable Object) storage instead of D1

Memory here is per-workspace: one browser's review history and chat, isolated
from every other workspace. That's a one-to-one mapping onto a single Durable
Object instance with its own embedded SQLite, which the Agents SDK gives for
free (`this.sql`, synced `this.state`, survives hibernation). D1 is a good fit
for data that's shared *across* instances — a global rule pack version, or
cross-workspace analytics — neither of which this project needs yet. Adding D1
now would mean two storage systems doing overlapping jobs for no present
benefit. If a "policy learned in one workspace should apply everywhere" feature
gets built later, that's the point D1 (or a shared KV) earns its place.

## Why Workflows were not added in this pass

The plan calls for adding Workflows only after a durability benefit is
demonstrated and tested (simulate a failure mid-run, resume without
duplicating output). The current pipeline is: parse → rules → graph (all
synchronous, deterministic, in-process) → one Workers AI call for the opening
summary, fired-and-forgotten after the HTTP response already carries the
complete deterministic result. There's no multi-step sequence here that
benefits from `step.do`-style resumption yet — a dropped AI call already
degrades gracefully (see `askAboutReview`'s catch block) without needing
Workflow-level retry semantics. The Agent/Durable Object coordination already
satisfies the stated "workflow / coordination" requirement on its own. If chat
grows into a multi-call chain (e.g., the policy compiler's compile → dry-run →
confirm sequence), that's the point a Workflow would earn its keep.

## The policy compiler (English → executable rule)

Built, unit-tested (22 tests across `test/policy-interpret.test.ts`,
`test/policy-compile.test.ts`, `test/policy-hash.test.ts`), and wired into
`agent.ts` and the UI. Not live-verified against the real Workers AI API for
the same credential reason as chat — see the section below.

Design: `src/policies/types.ts` defines a fixed, small DSL (a resourceType
allowlist, an action allowlist, one optional attribute predicate, a
severity) — never generated code or `eval`. `interpret.ts` is a pure,
three-valued evaluator (match/no-match/**unknown**, tested explicitly for
the case where a replacement's cause is itself unavailable — see the "is
UNKNOWN — not no-match" test). `compile.ts` turns one English sentence into
that DSL via Workers AI, Zod-validates the output, retries once on
malformed JSON (a real bug was caught and fixed here: a JSON parse failure
was initially treated as a fatal error rather than a retryable one — see
`test/policy-compile.test.ts`'s "retries once" case), and refuses cleanly
when the sentence can't be expressed in the DSL.

Lifecycle, per PLAN.md §6 (propose → validate → preview → confirm →
persist): `POST /policy/propose` compiles and dry-runs against the selected
review **without persisting anything**; the client gets back a
`proposalHash` — a SHA-256 of the exact (sentence, rule) pair
(`hash.ts`, tested for determinism and for changing when either input
changes). `POST /policy/confirm` recomputes that hash server-side from what
the client sends back; a mismatch (the proposal was edited after preview)
is rejected with 409, not silently accepted. Confirming the same proposal
twice is idempotent (returns the existing stored policy rather than
duplicating).

**Snapshot, not live recomputation.** A review's policy findings are
computed once, against the policies that existed at review-creation time,
and stored alongside the review (`policy_findings_json`,
`policy_revision_json` columns). Re-opening an old review later shows the
same findings even if new policies were added since — otherwise adding a
policy would retroactively rewrite history, which contradicts PLAN.md §5's
"snapshot policies at review creation" requirement and the reproducibility
requirement in §11. Demo: submit a review, add a policy, submit the *same*
plan again as a new review — the new one shows the policy finding citing
your sentence; the first one doesn't change.

## Why graph resolution is intentionally partial

Terraform's `count`/`for_each` and nested modules make instance-level
reference resolution genuinely hard to get right, and getting it *wrong* is
worse than not attempting it — a false edge could make an unrelated resource
look load-bearing to a change it has nothing to do with. `graph.ts` resolves
only single-instance, root-module-to-root-module references and reports
everything else as an explicit `unresolvedReferences` entry with a reason.
That's a real limitation, tested in `test/graph.test.ts`, and stated in the
README rather than glossed over.

## Why the model can never override a finding

`analyze.ts` produces `findings` from `rules.ts` before any AI call happens.
The AI layer (`src/ai/`) only ever reads that result to build chat answers —
it has no write path back into `AnalysisResult`. `context.ts`'s system prompt
also explicitly instructs the model to refuse a request to change a finding's
severity. This is a design constraint, not just a prompt instruction: even if
the model ignored the system prompt, there's no code path that would let its
output mutate `result.findings`.

## Why workspace isolation is a large random cookie, not HMAC-signed sessions

`worker.ts` derives the Durable Object instance name from a 256-bit random
value in an HttpOnly, Secure, SameSite=Lax cookie, generated server-side on
first visit. This is a capability-URL-style protection: knowing the workspace
id (which a client can't read via JS and can't guess — 2^256 space) is what
grants access, the same trust model most session cookies use. It is **not**
HMAC-signed against tampering, and there's no expiry/rotation beyond the
cookie's 30-day Max-Age. For a take-home demo this is a reasonable stopping
point; a production version would add signing, rotation, and explicit
workspace deletion (the plan's §7 calls for a delete-workspace endpoint, which
is not yet built — see README limitations).

## A packaging issue in `agents@0.24.0`, routed around

The `agents` package's main entry (`agents`) unconditionally bundles its MCP
client support, which imports `@modelcontextprotocol/client` and
`@modelcontextprotocol/sdk` as if they were direct dependencies — they aren't
declared in `agents`' own `package.json`, so `wrangler dev`'s esbuild step
failed to resolve them even though this project never uses MCP client
features. Routed around by adding both packages as direct dependencies here
(both are real, published packages, not a stub) rather than patching or
forking `agents`. Worth reporting upstream; not done as part of this
submission.

## Deployed and verified live — and what that caught

Workers AI has no local emulation — every `env.AI.run()` call proxies to the
real Cloudflare API, which requires an authenticated `wrangler` session or a
`CLOUDFLARE_API_TOKEN`. Neither was available for most of this build; Ashraf
created a scoped API token (`Workers Scripts:Edit`, `Workers AI:Edit`,
`Account Settings:Read`) partway through, which unblocked the rest. The
token was only ever held in a shell environment variable for this session —
never written to a repo file (`.dev.vars` doesn't exist in this repo; check
for yourself).

`wrangler deploy` succeeded on the first attempt (Node 22 required — this
machine defaults to 20.20.2, switched via `nvm install 22`). Deployed URL:
`https://cf-ai-blast-radius.ashrafahmed1232.workers.dev`.

**Live verification immediately found two real bugs mocked tests couldn't
catch**, both fixed and redeployed before submission:

1. **The `agents` package packaging issue** (covered above) — caught by
   `wrangler dev` failing to bundle, before any AI call was even involved.

2. **Workers AI pre-parses JSON completions.** When a model's output is
   valid JSON, `env.AI.run()`'s response comes back with `raw.response` as
   an **already-parsed object**, not the JSON string the documented example
   implies. `src/policies/compile.ts`'s extraction only handled the string
   case, so every live policy-compile request silently got an empty string
   and failed after two retries — mocked tests all passed because the mock
   correctly returned a string, matching the documented shape, not the real
   one. Found via `wrangler tail` against the live deployment, fixed by
   handling both shapes explicitly in `callModel`, and covered by a new
   test (`test/policy-compile.test.ts`, "accepts a pre-parsed object
   response") using the exact shape observed live. This is exactly the kind
   of gap a dry-run build or a mocked test cannot surface — only calling the
   real API did.

After both fixes, the full lifecycle was verified against the live app, not
just re-deployed and assumed working: a real plan submitted → correct
deterministic findings → a live Llama 3.3 summary appended a few seconds
later, correctly citing the resource id and forcing attribute; a live
WebSocket chat question → grounded, correct, cited the right evidence path;
a policy proposed and confirmed live → a review submitted *after* showed the
policy finding, a review submitted *before* did not — confirming the
snapshot-not-live-recompute design holds against the real infrastructure,
not just mocked tests.
