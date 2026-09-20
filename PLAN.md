# Blast Radius — Cloudflare assignment implementation plan

Reviewed 2026-09-20. Status: revised plan, not an implemented or validated submission.

## 1. Objective and verified requirements

Build a small, dependable infrastructure review tool that demonstrates backend engineering, operational judgment, useful AI, and clear limits. The project is **Blast Radius**, a Terraform plan review assistant. Keep the name `cf_ai_blast_radius` if desired; the prefix is a naming choice, not a requirement in the supplied posting.

The supplied job posting requests a GitHub repository URL and these components:

| Requirement | Implementation | Acceptance evidence |
| --- | --- | --- |
| LLM | Workers AI; start with the recommended Llama 3.3 model | Successful live explanation and chat request; documented model/configuration |
| Workflow / coordination | Agents SDK on Durable Objects; add Workflows only at the durability milestone | A persisted review state machine with duplicate-request and recovery tests |
| Chat or voice | Browser chat alongside the review | Follow-up answer grounded in the selected review |
| Memory or state | Agent SQLite: reviews, conversation, confirmed policies | Refresh/reconnect retains results; a saved policy applies to a later review |
| AI prompt history | Root `PROMPTS.md` and chronological session exports | Genuine prompts, corrections, provenance, and disclosed redactions |

The assignment recommends products; it does not require every Cloudflare product, a policy compiler, a benchmark, voice, or a particular repository prefix. Ashraf confirmed there is no fixed deadline (“as long as you need”). Target the full policy-authoring submission, including its evaluation; add Workflows only when a tested recovery benefit justifies it. Use milestones rather than an artificial seven-day schedule, and reserve a dedicated final verification and presentation phase.

The hiring target is infrastructure software and developer tooling, not an ML research role. Prioritize correctness, maintainability, repeatable setup, useful tests, and the ability to explain decisions. A small finished submission beats a large unfinished architecture.

## 2. Product promise and boundaries

**Pitch:** Review Terraform changes with evidence-linked findings, explain the risks in chat, and turn a small set of plain-English review policies into inspectable rules.

The application accepts `terraform show -json` output. It displays planned actions, replacement reasons when available, checks from a small documented rule pack, and potentially related resources. It never runs Terraform or applies infrastructure changes.

Use wording such as “Terraform plans to replace this database; check backups and migration strategy.” Do not claim “this will take production down,” “this is safe to apply,” or “all model claims are verified.” A plan does not establish live traffic, redundancy, backup recoverability, runtime health, or every external dependency.

Useful differentiation is the combination of precise evidence, conversational review, inspectable policy proposals, and measured limits. Do not claim competitors lack these features: the old plan's six-repository comparison was not an exhaustive or verified market study, and cannot establish hiring odds.

OPA already supports policy evaluation over Terraform plan JSON. This project complements that approach with an interactive explanation and constrained policy-authoring interface; it does not invent plan policy checks or replace a production policy engine. Cloudflare's published Terraform workflow motivates the use case, but does not prove that the hiring team needs this exact tool.

## 3. First-minute user experience

The initial page says what the tool does and offers three clearly labeled sample plans: replacement, ordinary update, and incomplete evidence. Samples require no Terraform installation or cloud credentials.

1. Open a sample or upload a sanitized plan.
2. Immediately see deterministic findings, sorted by review priority, while AI enrichment runs.
3. Expand a resource to see action order, evidence paths, known values where allowed, and coverage limits.
4. Ask “Why is this being replaced?” or “What cannot be determined?” Answers cite evidence identifiers and distinguish facts from advice.
5. In the full version, type “Flag deletion of aws_db_instance resources.” Inspect the compiled rule, matching resources and counterexamples, then explicitly save it.
6. Open a second review in the same workspace. The saved policy applies and cites the original sentence. Refresh to show persistence.

The policy demo changes a **policy finding**, not a known Terraform action or an already-maximal risk label. Use a fixture where the policy makes a visible difference, such as requiring review of every matching database update. Do not pretend a replacement becomes more destructive because the policy was saved.

Use a restrained table, readable evidence panel, and chat. Include loading, partial, disconnected, model-unavailable, unsupported-input, and empty states. Render model text safely. Show “No finding under supported checks,” never an unqualified green “SAFE.”

## 4. Data contract and deterministic analysis

Keep the core pure TypeScript with no network dependency. Treat the Terraform JSON as an untrusted external format. Validate its structure and supported format major version; tolerate compatible extra fields. Never silently accept an unknown action sequence as safe.

Separate four concepts in the report:

- **Planned action:** create, update, delete, replacement (including order), no-op, read, or unsupported.
- **Risk findings:** evidence-based warnings from versioned rules. A deletion is an object removal, not proof of permanent data loss.
- **Coverage:** complete for supported checks, partial, or unsupported, with specific missing evidence.
- **Policy findings:** matched, not matched, or indeterminate under the saved rule revision.

Known delete/replace facts survive unknown values, unsupported resource types, missing replacement paths, and model failure. Uncertainty is not a severity that can overwrite known actions. Built-in facts and findings are immutable to the model. Suggestions remain a separate, visibly advisory field.

Read `resource_changes`, including addresses, mode, provider name, before/after, `after_unknown`, sensitivity masks, action order, `replace_paths`, optional `action_reason`, and deposed identifiers where present. Preserve unique change identities if one address appears more than once. Handle drift separately from planned actions. A state JSON file or incomplete/errored plan must not be mistaken for a complete reviewable plan.

Replacement paths may be absent for tainted or explicitly requested replacement. Show the supplied reason when recognized; otherwise say the exact cause is unavailable. Do not manufacture a path. Preserve array indices and nested paths. Unknown null and known null are different. Unknown parent subtrees affect their descendants; unrelated computed IDs must not make every review indeterminate.

Start with **4–6 well-tested resource rules**, selected from pinned Cloudflare and AWS provider versions. Confirm current resource names from those versions. Store source links, tested versions and the precise predicate. Avoid reproducing provider ForceNew semantics: actions are the authority for what Terraform plans. Provider `schema_version` is not the provider release version; record provider versions in fixture manifests or optional input metadata, and show unknown version when unavailable.

Do not hard-code simplistic claims such as “allocated storage update always causes downtime” or “a final snapshot guarantees recovery.” Unsupported semantics should be visible, not guessed.

### Dependency evidence

Build a deterministic **partial reference graph**, not an outage graph. Resolve supported references with module scope, include unchanged resources where available, and traverse reverse edges to identify potential dependents. Preserve the evidence chain for each result.

Nested modules, outputs, variables, locals, `count`, and `for_each` can prevent exact instance resolution. Implement the supported subset and report unresolved references; never join instances by loose string prefixes. Use a visited set and traversal limits. Exclude unresolved or ambiguous edges from confirmed paths.

The model may explain a supplied path, but may not invent edges. “References this resource” does not mean “will fail.” Direct and transitive potential dependents must be labeled separately. Complex topology support is optional; accurate partial coverage is acceptable.

### CLI

Ship a local CLI sharing the core, invoked through a documented npm script after installation. Do not advertise `npx blast-radius` unless that package is actually published and owned.

Offer machine-readable JSON and a readable table. Define exit codes, for example 0 = no blocking finding under supported checks, 1 = configured finding, 2 = invalid/unsupported input or incomplete required assessment. State how partial coverage is treated. Never interpret process success as infrastructure safety. Provide one CI usage example.

## 5. Minimal Cloudflare architecture

Start with one Worker serving browser assets, an Agent class backed by SQLite, and a Workers AI binding. Choose the simplest client supported by the current SDK; a small React client is acceptable if it removes custom synchronization work. No D1, R2, vector database, Kubernetes, or external cloud credentials are required by the initial design.

One Agent instance represents an isolated browser workspace, containing several review IDs and confirmed policies. Persist immutable review inputs in sanitized form, analysis versions, policy snapshots, results, and bounded conversation history. Do not synchronize private raw plans or server-only fields through public Agent state.

Flow:

1. Worker validates session and limits before routing HTTP, RPC or WebSocket requests.
2. Agent accepts an idempotency key, validates/sanitizes input, assigns a review ID, and persists facts and the policy revision used.
3. Deterministic analysis completes and is immediately available.
4. Bounded AI calls enrich the report. Persist status before/after calls. On interruption, retain deterministic results and expose an explicit retry; never leave an endless spinner.
5. Reconnect reads persisted state, not an in-memory event stream. Duplicate submissions with the same key return the existing review.

Keep model calls outside database transactions. Snapshot policies at review creation so concurrent policy changes cannot alter a running review. Persist a versioned final report atomically; repeated completion must not create duplicate findings. Chat and enrichment need concurrency controls so stale results cannot overwrite newer state.

### Add Workflows only after the first complete deployed slice

Add a Workflow if there is time to demonstrate durable multi-call processing. Its purpose is recovery across retries, not counting seven steps. Pass compact workspace/review identifiers; keep payloads out of Workflow parameters and logs. Internal methods supply sanitized input and accept idempotent progress/results.

Use stable workflow IDs and deterministic step names, bounded retries, explicit per-call timeouts, and terminal failed/degraded states. Persist a pending job before creation; reconcile a crash between persistence and workflow creation by retrying the same ID and querying its status. A retried model call may spend twice; do not promise exactly-once inference. A retried report write must be idempotent.

Acceptance: simulate a failure after one completed step, resume without duplicating the report, and reconnect while the job runs. If this is not implemented and tested, document request-level retry rather than claiming durable execution. Agent/Durable Object coordination already meets the stated assignment requirement.

At implementation, pin dependencies, verify current APIs and bindings, and derive Wrangler configuration from a working starter. Verify model access early with a real request. Do not add experimental APIs merely because they appear in current marketing material.

## 6. AI contract and policy compiler

Use the recommended Workers AI model if accessible. Verify its current schema, limits and structured-output support in a small spike; fall back to schema-validated JSON prompting if necessary. Bound input by serialized size/token budget, not just number of resources. Never truncate silently: expose omitted context and partial AI coverage.

Give the model only sanitized facts, evidence IDs, supplied reference paths, and relevant rule documentation. Require structured evidence references. The verifier checks reference existence, entity ownership, allowed categories, graph-path validity, and immutable deterministic findings. It **cannot prove arbitrary natural-language truth**; prose is explicitly advisory.

Use one bounded correction attempt for malformed output, then show deterministic results with “AI explanation unavailable.” Timeouts, 429s and service errors must not remove findings. Ground follow-up chat in the selected review and saved policy revision, with a bounded context window. Treat plan strings and user-provided descriptions as data, not system instructions.

### Constrained policy authoring (full submission target)

Compile natural language into a small typed DSL with finite resource-type selectors, action selectors, and a small allowlist of attribute predicates. No generated code, `eval`, unrestricted regex, shell, arbitrary URLs, or arbitrary SQL. Set explicit limits on clauses and string lengths.

The interpreter uses three-valued logic: true, false, unknown. Missing, redacted, or unknown evidence must not silently satisfy a negative predicate. Unit-test both matching and nonmatching examples for every supported predicate.

Process: propose → validate → explain meaning → preview on current plan and fixed examples → explicitly confirm → persist. Bind confirmation to proposal ID/hash and policy revision, so an edited proposal cannot reuse earlier approval. Repeated confirmation is idempotent. Persist the original sentence and compiled rule; allow inspection and deletion.

A successful dry-run proves execution, not that the compiler understood the sentence. Refuse unsupported requests such as “ensure backups are recoverable,” “make everything safe,” or “never replace without a snapshot step” when the evidence does not establish that condition. Offer a narrower supported rule rather than inventing operational evidence.

Do not cut the policy evaluation while keeping the compiler. If time is short, cut both and retain grounded chat; the assignment does not demand autonomous action.

## 7. Privacy, isolation and bounded operation

Terraform plan JSON can contain sensitive values in cleartext. The default hosted demo accepts bundled sanitized fixtures. Enable arbitrary uploads only after the following protections work:

- Issue an unguessable workspace identity tied to a signed, HttpOnly, Secure same-site session cookie. Derive the Agent identity server-side; never authorize by a user-supplied review ID alone.
- Check ownership on HTTP, WebSocket handshake, RPC, report and policy operations; validate Origin on browser mutations. Disable client writes to authoritative findings and policies, including generic state mutation APIs.
- Apply sensitivity masks recursively before model calls, persistence, telemetry or UI previews. Minimize further: omit variables, unrelated state and unnecessary values; send only allowlisted fields. Sensitivity flags are not a complete secret detector. Warn users to sanitize locally and use samples for confidential plans.
- Enforce body size, nesting, resource count, chat length, stored-review count, and model budgets. Initial proposed limits: 1 MiB input, 200 changed resources, 20 retained reviews per workspace, one active review per workspace. Validate these experimentally and lower them if necessary.
- Rate-limit session creation and model requests; enforce a deployment-wide inference budget as well as per-session quotas. New sessions must not bypass the only spending control. A reached budget produces a clear deterministic-only mode.
- Escape resource strings and sanitize rendered Markdown. Do not fetch URLs from uploaded content or permit the model to execute infrastructure actions.
- Provide delete-workspace and a documented retention policy, with tested cleanup for application-controlled data. Explain any Workflow/provider retention outside immediate application deletion.

If upload isolation is not ready, ship the public sample-only demo plus the local CLI. Do not deploy an unprotected shared policy database.

Record structured metadata: request/review IDs, durations, input counts, outcome, retry counts and model usage when available. Exclude raw prompts, plans and values from operational logs. Benchmark replay artifacts require the same redaction review as fixtures.

## 8. Evaluation that supports honest claims

Separate parser correctness, rule quality, model contribution, and operational reliability. A classifier graded against its own output is not an independent accuracy benchmark. Parsing every delete token correctly is useful coverage, not evidence of predicting production outages.

### Corpus

Start with 6–8 compact scenarios; expand only to cover missing behaviors. Include both replacement orders, delete, benign update, unknown deciding values, unrelated unknown values, absent replacement paths, unknown provider/type, nested module references, multiple instances, sensitive subtrees, malformed/oversized input, and injection-like strings.

Label fixtures as:

- **Terraform-generated:** include HCL, tool/provider locks, exact commands, and sanitization/provenance notes. Use local resources or existing authorized development resources. Cloud plans may require real API access; dummy AWS credentials do not make arbitrary modules plannable.
- **Synthetic:** hand-built edge cases, explicitly labeled. These are valid tests but not “real production plans.”

Never apply cloud infrastructure to manufacture benchmark data. Local disposable fixture generation may create local state/files only within a documented temporary directory. For cloud examples, prefer existing sanitized plans or accurately labeled synthetic examples if credentials/state are unavailable.

Create expected labels manually from documented semantics before running the analyzer; include reasons. Freeze a held-out set before tuning prompts/rules. Do not inflate counts by duplicating easy changes. Disclose small sample size and supported scope.

### Metrics

1. **Deterministic correctness:** action extraction, replacement-cause availability, unknown handling, sensitivity removal, supported reference edges, rule matches. Report numerator/denominator and failures.
2. **Policy compiler:** held-out sentences with expected DSL semantics or exact match sets across positive/negative plans; first-attempt validity, post-retry validity, semantic matches, false matches and correct refusals. Target roughly 20 varied examples including unsupported requests, if this feature ships.
3. **Explanation quality:** a small frozen question set scored against an explicit rubric for factual support, correct uncertainty and useful advice. Label human judgment as such; disclose who graded it. Do not use the producing model as the only judge.
4. **Reliability:** reconnect, concurrent confirmations, duplicate submission, timeout, malformed response, denied cross-session access, and recovery tests.
5. **Live performance:** measured latency and model usage on a declared environment, with sample size. Replay time is not inference latency. Missing token accounting is “unavailable,” not zero.

Compare a complete deterministic baseline (including graph traversal, replacement paths and template explanations) with AI enrichment. Do not disable the graph or cause extraction in the baseline to manufacture an AI advantage. Both must preserve the same deterministic findings. The model's expected contribution is flexible questions and policy authoring, not extracting `delete`.

Replay captures may reproduce recorded model outputs offline, but cannot prove future model behavior. Version the cache by model, prompt, schema, input and analysis/rule versions. Missing/stale entries fail explicitly. Keep live capture metadata distinct from replay timings and expose record mode as an opt-in cost-bearing command.

Publish actual results and limitations. Never prefill “100%,” “zero misses,” a performance percentile, or a model-correction count. A forced malformed-output test is a test, not a naturally observed model failure.

## 9. Build milestones and stop rules

There is no fixed user-imposed time limit. Estimate effort after the first vertical slice, not by assuming seven calendar days. Every milestone must leave a runnable system. Complete M0–M2 and all applicable reliability gates, then stop adding features when remaining additions offer little benefit. Reserve a dedicated final phase for tests, README, demo and review.

**M0 — feasibility and provenance:** begin genuine prompt capture now, scaffold, pin versions, verify a live model request, deploy a minimal chat, and prove Agent state survives reload. Write README requirements and limitations. Stop to resolve access/runtime issues before expanding scope.

**M1 — useful vertical slice:** parser, a few rules, evidence table, three sample buttons, grounded chat, persistent isolated workspace, offline tests and local CLI. Deploy. This is the minimum complete assignment; do not postpone all integration to the end.

**M2 — distinctive capability:** constrained policy proposal/preview/confirmation, next-review enforcement, held-out policy evaluation, and persistence/concurrency tests. Add only supported predicates that demonstrably help the demo.

**M3 — reliability depth:** optional Workflow recovery, versioned result commits, live failure tests and expanded edge-case corpus. Finish upload protection before enabling hosted uploads.

**M4 — submission freeze:** clean-clone setup, green CI, honest results, short README, final prompt export, demo recording and adversarial review of the actual application.

Cut order: extra resource types, advanced graph resolution, extra GIFs, Workflows if not yet needed, then compiler and its evaluation together. Preserve all mandatory assignment components, isolation, honest limitations, useful tests, prompt history and a working demo. Never cut correctness checks to keep a flashy feature.

## 10. Repository and documentation

Suggested layout (create only files that serve the implementation):

```text
README.md
PROMPTS.md
PLAN.md
wrangler.jsonc
src/worker.ts
src/agent.ts
src/core/             # parse, sanitize, rules, graph, types
src/ai/               # prompts, schemas, evidence validation
src/policies/         # optional DSL, interpreter, proposal lifecycle
src/cli.ts
src/workflow.ts       # only if milestone M3 includes it
ui/
test/
bench/fixtures/
bench/labels/
bench/RESULTS.md
prompts/
docs/decisions.md
.github/workflows/ci.yml
```

README first screen: one-sentence purpose, screenshot, deployed URL, sample flow and five-row requirement mapping. Then quick start, exact tested commands, architecture, measured results with denominators, limits and prompt-history link. Separate credential-free offline tests from live AI/deployment setup. A local smoke test must not secretly call paid services.

CI: lockfile installation, typecheck, unit/integration tests, production build and deterministic/replay evaluation. Do not expose credentials to untrusted pull requests. Publish a short recording as an optional fallback if the hosted model is unavailable; label recorded and live modes clearly.

Prompt history must reflect the tools actually used, including Codex and delegated reviews. Include this planning/review session. Export original available history chronologically and redact personal data/secrets with explicit markers. If a session cannot be exported, disclose the gap and label any recollection as a summary. Do not fabricate “two mistakes,” reconstruct ideal prompts, or claim a hand-written summary is complete raw history. Avoid building a custom exporter unless native exports are insufficient.

Use `docs/decisions.md` for a few actual tradeoffs: why Agent storage, why no initial D1, what Workflows buys if used, graph limitations, and why AI cannot override deterministic findings. Do not publish unsupported commentary about other candidates.

## 11. Submission acceptance gates

The finished submission is ready only when these checks have observed results:

- Every supplied requirement has a working path and a README pointer.
- A fresh clone builds and runs documented offline checks; live setup identifies its credentials and costs.
- All three samples work; the payoff is visible in under a minute.
- Chat answers from the selected persisted review, including after reload.
- Known deletion/replacement survives unknown values and model failure.
- Unsupported input and partial graph/rule coverage cannot produce an unqualified safe verdict.
- Sensitive fixtures do not leak into requests, storage, logs, UI or replay captures.
- Cross-session access and client mutation of authoritative state are rejected.
- Duplicate requests, confirmations and any Workflow completion are safe.
- A stored policy changes findings on a subsequent review; policy revisions are reproducible, if the compiler ships.
- Offline results reproduce; live metrics are labeled and never inferred from cache replay.
- Model timeout, invalid output and spending limits produce a usable degraded state.
- README, screenshots and demo show only measured behavior; prompt history is genuine and reviewed for redaction.
- Ashraf can explain the parser, state transitions, isolation, AI boundary and one failed evaluation case without relying on generated talking points.

Final hostile questions: Why use this alongside OPA? What useful behavior disappears without AI? What can the plan never tell you? What happens during a retry or a second browser session? Why did you omit D1? What would need to change before production use?

No plan establishes that a job offer will follow. The credible target is a complete, well-tested submission whose decisions survive those questions.

## 12. Sources and review corrections

Primary references checked during this review:

- [Cloudflare Agents](https://developers.cloudflare.com/agents/): stateful runtime and coordination options; verify concrete APIs again when pinning the implementation.
- [Workers AI recommended model](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/): model configuration and current capability reference.
- [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/): check before choosing payload, step and batch sizes.
- [Terraform JSON format](https://developer.hashicorp.com/terraform/internals/json-format): actions, unknown/sensitive fields, optional replacement causes and configuration structure.
- [Terraform show](https://developer.hashicorp.com/terraform/cli/commands/show): JSON export and sensitive-data warning.
- [OPA Terraform integration](https://www.openpolicyagent.org/docs/terraform): plan-level policies already exist, with plan-time evidence limits.
- [Cloudflare's Terraform workflow](https://blog.cloudflare.com/terraforming-cloudflare-at-cloudflare/) and [shift-left article](https://blog.cloudflare.com/shift-left-enterprise-scale/): motivation, not proof of team-specific hiring preferences.

Material corrections to the previous plan: removed outage guarantees and unverified competitive rankings; separated facts from uncertainty; replaced self-grading accuracy claims; corrected OPA positioning; narrowed rules and policy semantics; removed unnecessary initial D1/Workflow coupling; added privacy/isolation and retry contracts; replaced arbitrary day counts with runnable milestones; made authentic prompt capture tool-neutral. Original pre-review plan retained locally at `/tmp/cloudflare-PLAN-before-review-20260920.md` for this review only, not as a submission artifact.
