# Submission review and implementation handoff

Reviewed: 2026-09-20. Baseline: `896e8f0` plus existing uncommitted changes in `src/policies/compile.ts` and `test/policy-compile.test.ts`. Review those changes in place; do not reset or overwrite them. This review changes documentation only. Concurrent work updated README and the compiler again during the review; the final status below incorporates those observed changes. File line numbers refer to the inspected snapshot and may move.

## Verdict: BLOCK — promising foundation, not ready to submit

The idea fits Cloudflare's infrastructure-software role. The deterministic/AI boundary, small policy DSL, explicit uncertainty, shared CLI core, and Agent-backed storage are sensible choices. Keep that architecture.

The current application has first-use and navigation defects, incorrect Terraform handling, incomplete confirmation guarantees, and no independently verified end-to-end browser evidence in this review. These are concrete reasons a hiring reviewer could prefer another candidate. Adding more Cloudflare products will not address them.

“Elite” here means a reviewer can run the application, inspect its evidence, reproduce its tests and evaluations, and understand its limits. It does not mean maximum features, perfect benchmark percentages, or a guaranteed offer. Complete the tasks below, then review the actual finished artifact again.

## Evidence and review limits

Inspected all application source areas, browser client, existing tests, configuration, README, limitations/decisions, prompt-history index, current Git status, and relevant prior schema. Two independent read-only reviews covered runtime/session behavior and deterministic/policy correctness.

| Check | Observed result |
| --- | --- |
| `npm test` | Initially 56 tests; rerun after concurrent compiler changes: 8 files, 57 tests passed |
| `npm run typecheck` | Passed |
| `npm run bench` | Failed: `bench/run.ts` does not exist |
| `npm run build` | No script defined; CI uses Wrangler directly, so this alone is not a build failure |
| `npx wrangler deploy --dry-run --outdir /tmp/cloudflare-review-bundle` under installed Node 22.23.2 | Passed; six assets and Worker/Agent/AI bindings bundled |
| Wrangler under default Node 20.20.2 | Rejected unsupported Node version; README specifies Node 22 |
| Client selection probe using actual `ui/app.js` with mocked DOM/fetch | One selection produced 9 workspace fetches; harness deliberately stopped successful responses after 8 |
| Cookie-less parallel requests through actual Worker routing with mocked Agent routing | Different workspaces generated |
| Core probes | Empty object with format version, state-shaped JSON, and errored plan accepted with no warnings; S3 replacement had zero findings and complete coverage; malformed configuration threw `TypeError` |
| Citation probe | Valid indexed and module-qualified resource citations incorrectly flagged |
| Hosted URL added during review | `/api/health` and `/app.js` returned HTTP 200; hosted `app.js` exactly matched the reviewed client, including R1/R2 |
| Live Workers AI / full browser interaction | README now claims live verification by the other implementation session; not independently verified by this review |

The VM probes establish specific control-flow failures; they are not a substitute for browser or Workers-runtime integration tests. A dry-run establishes packaging, not authentication, persistence, WebSocket behavior, or model quality. No cloud deployment or live inference was performed by this review. The subsequently supplied deployment is https://cf-ai-blast-radius.ashrafahmed1232.workers.dev; only its health and static client were fetched read-only. These checks do not close the reproduced browser defects.

## Implementation order and ownership

P0 means an immediate usability blocker; P1 means required correctness, reliability, or submission-evidence work; P2 means final reviewer-facing improvements. These are implementation priorities, not claims that every finding is a security vulnerability.

| Workstream | Owns | Tasks | Dependencies |
| --- | --- | --- | --- |
| Browser owner | `ui/`, browser tests | R1, R2 client half, R3, R12 | Agree bootstrap/message API with runtime owner first |
| Runtime owner | `src/worker.ts`, `src/agent.ts`, runtime tests | R2 server half, R7–R10 | Own all edits to these shared files |
| Core/AI owner | `src/core/`, `src/policies/`, `src/ai/`, unit tests | R4–R6, R11 | Coordinate fact/path changes with runtime/UI owners |
| Evidence owner | `bench/`, CI, README/docs, prompt index | R13–R15 | Define independent labels early; final results wait for fixes |

Agents may work in parallel on separate files after agreeing contracts. One integrator should merge changes, rerun checks, and own the final verdict. Preserve existing user changes. Do not mark a task complete solely because code was added: attach the acceptance evidence listed below.

## R1 — P0: Stop the infinite review-selection loop

**Evidence:** `ui/app.js:152–179`. `fetchWorkspaceState()` selects the active review; `selectReview()` fetches workspace state again. Once any active review exists, the cycle never settles.

**Change:** Separate list refresh, initial hydration, and explicit selection. Refreshing summaries must not implicitly trigger another refresh. Guard against stale asynchronous selection responses: if A finishes after the user selects B, A must not overwrite B's report.

**Acceptance:** Initial load, submission, reload, and selecting an existing review each settle with a bounded number of requests. An idle page makes no repeated `/reviews` requests. A delayed A/B selection test leaves B visible. Cover this in browser tests, not just a helper test.

## R2 — P0: Establish one workspace before opening parallel connections

**Evidence:** `ui/app.js:301,312–313` starts policies HTTP, WebSocket, and reviews HTTP independently. `src/worker.ts:35–37` issues a fresh identity for every cookie-less request. Their responses can race to set the browser cookie while the WebSocket remains attached to a different Agent.

**Change:** Add one awaited HTTP bootstrap, then open the socket and load workspace data. Do not rely on a first WebSocket upgrade to establish the cookie. If a cookie-setting upgrade path remains, verify that response wrapping preserves the upgrade. Use exact cookie-name parsing. The existing random bearer cookie can remain for this anonymous demo; a full login system is unnecessary.

**Acceptance:** Repeat first-use from clean cookie jars; sample review, summary, policies and chat always use one workspace. Two separate browser contexts cannot access one another by substituting route/review IDs. Cookie expiry/reconnect must trigger a coherent bootstrap rather than silent workspace splitting.

## R3 — P1: Make chat, selection and policy UI truthful

**Evidence:** `ui/app.js:31–34,54–57,160–179,287–309`.

- Reconnect does not reload persisted messages; the cache remains authoritative indefinitely.
- A user turn is appended optimistically and again on the server broadcast.
- Confirmation displays “Saved” without checking HTTP status.
- Server error frames are ignored, and proposal/delete network errors lack useful recovery.

**Change:** Rehydrate after reconnect, reconcile by stable message IDs, and handle loading/error/pending states explicitly. Check confirmation and deletion responses. Preserve a rejected proposal for correction. Disable or explain chat while disconnected. Show the exact compiled meaning, matching addresses, and selected review in the policy preview; a count alone is weak approval evidence.

**Acceptance:** Disconnect while an answer is pending, reconnect, and see exactly one persisted answer. One user turn appears once before and after refresh. Inject confirmation 409/422/500 and network failure: never show “Saved.” Reverse-order proposal responses cannot replace a newer preview. Switching reviews cannot silently change which review a preview describes.

## R4 — P1: Correct Terraform document and replacement semantics

**Evidence:** `src/core/parse.ts:21–49,134–195`, `src/core/graph.ts:81–96`.

- `action_reason` is read inside `change`; Terraform puts it on the resource-change object.
- A state-shaped document or `{ "format_version": "1.2" }` is accepted as an ordinary zero-change plan.
- `errored`, `complete`, and `applyable` are discarded.
- Arbitrary configuration passes schema validation and can cause `TypeError` during graph traversal.

**Change:** Parse the documented shape, preserve plan status, distinguish state from plan documents, and validate the graph subset. Support legitimate no-op/output-only plans and older versions without modern status flags. Preserve unknown reason strings as unspecified context, not proof of a specific cause. Separate “replacement reason available” from “replacement attribute paths available.” Reject malformed containers and duplicate change identities with controlled errors; keep deposed/current identities distinct.

**Acceptance:** Fixtures cover real-shape tainted/requested replacement, missing paths, unsupported reason, no-op/output-only plan, state JSON, incomplete/errored plan, malformed configuration and duplicate IDs. Failed/partial plans have visible qualifications. Malformed user input returns structured 4xx/parse errors, never an uncaught 500.

Primary reference: [HashiCorp Terraform JSON format](https://developer.hashicorp.com/terraform/internals/json-format). Its resource-change schema puts the reason beside the change; its plan schema describes status flags and separate state/plan representations. Verify fixtures against that contract rather than mirroring current implementation.

## R5 — P1: Make rule and graph coverage mean what the UI claims

**Evidence:** `src/core/rules.ts:50–60`, `src/core/analyze.ts:30–44`, `src/core/graph.ts:81–131`.

- `aws_s3_bucket` replacement includes deletion but triggers no finding; coverage still reads “complete.”
- Coverage is based on resource type membership rather than the specific checks performed.
- Module/local/data references are silently skipped; `module_calls` is ignored despite documentation promising unresolved coverage.
- Missing configuration and traversal limits do not explain missing graph evidence.

**Change:** Include both replacement orders in applicable destructive-object rules. Scope rules by provider identity and state version uncertainty honestly. Describe evaluated checks rather than implying every update of a recognized type was assessed. Emit explicit partial graph coverage for unsupported intermediates, missing configuration, nested modules and traversal truncation. Retain partial graph support; full Terraform expression evaluation is not required. Do not mistake ordinary no-op resources included in real plan JSON for absent resources.

**Acceptance:** S3 delete and both replacement orders yield the intended warning; ordinary update does not. Unknown provider/type/version cannot silently inherit broad coverage. Module/local/data/missing-configuration fixtures produce inspectable limitations. Supported direct/transitive/no-op dependencies still work; ambiguous instance joins remain unresolved.

## R6 — P1: Fix path semantics and avoid misleading redaction machinery

**Evidence:** `src/policies/interpret.ts:24–35`, `src/core/parse.ts:71–105`, `src/core/sanitize.ts:14–63`.

`after_unknown: true` becomes `(root)`, so a predicate asking whether `id` is unknown returns `no-match`. Unknown parent subtrees and depth-limit markers have similar ambiguity. Substring tests can match similarly named siblings. A generic replacement reason does not establish whether a particular attribute forced replacement.

The unused `redactValue` helper also fails for root masks and dotted map keys, while `sanitizeFact` claims to strip extra fields but only clones them. **This is not evidence that current raw plan values leak:** the active parser omits before/after values, and the redaction helper has no production callers.

**Change:** Define precise segment/subtree semantics for predicates and preserve structured paths. Return indeterminate when required evidence is unavailable. Keep value omission as the simplest privacy boundary. Remove unused misleading helpers or implement them correctly before introducing any value-bearing feature; update documentation to describe actual omission rather than fictitious active redaction.

**Acceptance:** Whole-resource unknown, parent unknown, exact leaf, sibling with a similar name, array index, literal dotted map key, depth limit, absent replacement paths and known generic reason are independently tested. Model context and persisted analysis contain no raw-value sentinel. Preserve literal keys rather than reparsing ambiguous display strings.

## R7 — P1: Bind policy confirmation to a real server proposal

**Evidence:** `src/agent.ts:268–340`, `src/policies/hash.ts:7–13`. Propose stores nothing. Confirm trusts a client-supplied sentence/rule/hash and checks an unkeyed hash of those same fields. Anyone can calculate a fresh matching hash and skip preview entirely. This is a broken approval contract, not evidence of cross-workspace privilege escalation.

**Change:** Store an expiring proposal server-side with an opaque ID, exact rule/sentence, workspace, preview review/revision and confirmation state. Confirm by ID, rechecking relevant revisions; do not accept a replacement rule body as authority. A hash can remain an integrity field, not proof that the server proposed anything. Preserve immutable policy content/revision with reviews so later deletion does not remove the evidence needed to reproduce a finding.

**Acceptance:** A fabricated rule plus its correct public hash is rejected without an issued proposal. Cross-workspace, expired, edited and stale proposals fail clearly. Repeated and concurrent confirmation creates one policy. Re-review uses the confirmed revision; an older report remains unchanged after policy deletion.

## R8 — P1: Validate all public inputs and protect server-owned state

**Evidence:** `src/agent.ts:171–188,271–310,390–427`, `src/worker.ts:34–58`. JSON `null` can reach property access; policy bodies and WebSocket frames are not size-bounded; review length measures characters after buffering. Origin checks are absent. No `validateStateChange` override rejects SDK client state writes. The installed SDK's default validation hook is empty.

**Change:** Use runtime schemas for every request/frame, bounded byte reads before expensive work, field/key/label/depth limits, and cheap resource-count checks before full analysis. Validate browser mutation and WebSocket origins. Reject generic client writes to server-owned Agent state using the installed SDK hook, and validate `set_active` against an existing workspace review. Do not broaden API surface unnecessarily.

**Acceptance:** Null/scalar/array payloads, oversized chunked/multibyte input and oversized frames receive controlled failures without model calls. Cross-origin mutation/upgrade is denied according to a documented policy. A direct SDK state frame cannot replace reviews or corrupt state to null; valid chat still works. Two-workspace integration tests cover HTTP and WebSockets.

Reference: [Cloudflare state validation](https://developers.cloudflare.com/agents/runtime/lifecycle/state/); also inspect `node_modules/agents/docs/state.md` for the pinned package contract. The validation hook runs before persistence and distinguishes server from client writes.

## R9 — P1: Persist honest AI status, bound costs and recover cleanly

**Evidence:** `src/agent.ts:235–252,406–414`, `src/ai/chat.ts:35–66`, `src/policies/compile.ts:70–100`. Summary work is an untracked promise with swallowed exceptions. There are no application model timeouts/quotas, chat history storage is unbounded, and every chat turn loads all message rows before slicing. The current question is included in history and then appended again to model input.

**Change:** Persist pending/completed/failed summary status, manage task lifetime through a supported mechanism, and expose idempotent retry. A simple persisted status plus explicit retry is sufficient; add Workflows only for a demonstrated recovery need. Bound model duration, concurrent work, retained messages and SQL reads. Enforce both workspace limits and an atomic deployment-wide inference budget or equivalent enforced cap; fresh cookies must not bypass the only budget. Protect deterministic-only operation when AI is unavailable. Exclude the current question from prior history.

**Acceptance:** Hanging/failing/malformed AI responses produce a bounded, visible terminal state. Retry completes once. A late answer cannot recreate messages after its review/workspace was deleted. One question appears once in model input. Quota tests across fresh workspaces show the global cap holds. Long conversations stay within configured storage and prompt budgets.

## R10 — P1: Make persistence upgrades and deletion real

**Evidence:** `src/agent.ts:75–98` uses only `CREATE TABLE IF NOT EXISTS`. Commit `9f3584c` created `reviews` without the two policy columns; current inserts require them. Existing local/deployed Agent storage from that revision will not be upgraded by the new CREATE statement. Cookie expiration also does not delete stored workspace data.

**Change:** Add a small versioned, idempotent SQLite migration for existing workspaces. Implement delete-workspace, message retention and a stated cleanup schedule. Use a generation/tombstone check or equivalent guard against late writes. Do not silently delete older policies to make room without explaining the consequence to the user. Bind review idempotency keys to input fingerprints so reuse with different data cannot return an unrelated report.

**Acceptance:** Initialize the old schema, upgrade, preserve old reviews and submit a policy-bearing review. Restart/reapply migration safely. Workspace deletion clears all application data and survives delayed model completion. A changed payload with an existing idempotency key returns a conflict; identical retries return the same review.

## R11 — P1: Make AI grounding and failure handling defensible

**Evidence:** `src/ai/verify.ts:13–45` incorrectly tokenizes indexed and module-qualified addresses. Real citations such as `aws_db_instance.main[0]` and `module.prod.aws_db_instance.main` are flagged as unknown suffixes. `src/ai/context.ts` always uses the first bounded subset, yet tells users to ask about omitted IDs without actually selecting their context. Policies are absent from chat context. The initial compiler snapshot logged raw/repaired/parsed model output. Concurrent edits removed those raw logs and added support for object-shaped model responses; the latest tests cover this and pass. Do not reintroduce those logs; validate the remaining schema-warning metadata with the sentinel test below.

**Change:** Prefer explicit structured citation IDs validated against the supplied context, or implement and test full address matching. Explain that citation validation does not prove prose truth. Select relevant resource context for specific questions, prioritize notable findings, and state omissions. Include the selected review's policy snapshot if chat answers policy questions; otherwise state this limitation explicitly. Validate response/refusal shapes. Remove raw model-output debug logs in favor of bounded error metadata. Keep malformed-output recovery strict and semantics-preserving; the current regex repair should not be defended merely because one example passes.

**Acceptance:** Exact indexed/module/deposed IDs validate; fabricated IDs fail; a known ID omitted from model context is not falsely treated as supplied evidence. A question about a resource beyond the initial context receives that resource's facts or an explicit inability to retrieve them. Adversarial strings cannot alter deterministic findings. Failure logs never contain a unique sensitive sentinel. Add malformed/refusal-response tests beyond normal `{response: string}` mocks.

## R12 — P2: Show the evidence reviewers came to inspect

**Evidence:** `ui/app.js:93–118` omits coverage reasons, rule source links, finding evidence and detailed unresolved paths. It renders input order rather than prioritizing important findings. Known/unknown details are much less visible than the product description suggests.

**Change:** Sort by review priority and add an expandable evidence panel with exact paths, documented rule source, coverage reasons, known replacement reason, graph path and unresolved explanations. Distinguish policy matches from infrastructure facts. Keep the interface small; do not replace it with a decorative dashboard. Check keyboard navigation, labels, visible focus, readable status/error text and mobile layout in a real browser.

**Acceptance:** A reviewer identifies the important resource and its evidence within one minute, using samples and without opening source. Unknown versus unsupported coverage is understandable. A saved policy is inspectable, and its effect on the next review is visible. Preserve HTML escaping/text rendering of untrusted content.

## R13 — P1: Build independent evaluation and integration evidence

**Evidence:** `package.json` exposes a broken benchmark command. Current tests are Node unit tests; none cover actual Worker/Agent routing, SQLite, browser lifecycle or end-to-end policy confirmation. Provider metadata says `providerVersionTested`, but no generated fixture corpus/lockfiles establish those versions were tested.

**Change:** Implement the compact benchmark already planned: independently labeled action/cause/coverage cases; a held-out policy set with positive, negative and refusal cases; and a small explanation rubric. Keep synthetic edge cases, explicitly labeled. Add several regenerable Terraform-generated fixtures with HCL, pinned provider/tool versions, commands and provenance. Use local disposable resources where possible; no production infrastructure apply is needed. Do not present the illustrative RDS instance-class replacement sample as provider-generated behavior without proving its provenance.

Add Workers-runtime integration tests using a fake AI binding, plus browser tests for R1–R3 and the full policy lifecycle. Run CI from a clean install with the committed lockfile: `npm ci --legacy-peer-deps` if the documented workaround remains necessary. `.github/workflows/ci.yml` currently falsely says no lockfile is committed. Pin Node through a version file/engines and expose a documented build command or consistently document Wrangler's command.

**Acceptance:** All offline checks run without credentials or hidden inference. `npm run bench` actually works and prints denominators/failures, including unknown outcomes. Expected labels are not generated by the analyzer being evaluated. Replay and live results are clearly separated; cache misses cannot silently spend money. The deterministic baseline includes its real graph/cause capabilities. Live compiler success is measured rather than inferred from mocks.

## R14 — P1: Verify the hosted submission after the blockers are fixed

The optional assignment requires an AI-powered application, not merely code that bundles. A public URL is a submission-strengthening recommendation rather than an explicit requirement in the supplied posting; working LLM, coordination, chat and memory are explicit components.

**Change:** After protection and lifecycle fixes, deploy and record an actual smoke test. If uploads are not adequately protected, restrict the public server to bundled sample IDs and keep arbitrary input local; hiding an upload button alone does not restrict the endpoint. Keep a short recording as a fallback, clearly labeled as recorded.

**Acceptance:** A fresh browser loads a sample, receives a real model answer, reloads persisted history, proposes a supported policy, confirms it, observes its effect on a later review and receives a sensible refusal for an unsupported request. Test two independent browser contexts, disconnect/reconnect, model failure and budget exhaustion. Record deployed commit, verification date, actual commands and limitations. Do not interpret health-check success as proof of the flow.

## R15 — P1/P2: Reconcile documentation and prompt provenance

**Evidence:** README says the policy compiler is both built and unbuilt; retains stale 33/55 counts in some sections despite a new 57-test status claim; implies active value redaction and stronger recovery than implemented. Its CI shell example can swallow the finding exit code and prints “review required” even on success because of shell operator grouping. `PROMPTS.md` indexes only one Claude session and attributes the corrected planning history to that session; this conversation establishes additional Codex planning/review contributions.

**Change:** Rewrite around verified final behavior, not the build conversation. Put purpose, screenshot, demo, requirements mapping and setup first; provide measured results and limitations below. Correct the CLI example so success, review-required and invalid input are deliberately handled. Resolve contradictory status/test counts and `providerVersionTested` claims using evidence or narrower wording.

Append genuine available Codex/delegated review history to the prompt index; include this review. Do not relabel a summary as raw history or fabricate missing exports. If only prompts are exported, say exactly that. Identify redactions and gaps honestly. Preserve original session content rather than rewriting it to support a better story. Keep the benchmark failures and at least one actual corrected engineering mistake, without inventing model failures.

**Acceptance:** A fresh reader can follow the exact README commands, match every major claim to code/test/evaluation evidence, and distinguish live verification from mocks. Prompt coverage accurately names the tools/sessions used. A final stale-claim search finds no contradictory “not built” statements for shipped features and no unsupported accuracy/outage guarantees.

## Definition of done for the implementing agents

- [ ] R1 and R2 reproduced, fixed and covered by browser tests.
- [ ] R3–R11 correctness/reliability contracts tested at the appropriate unit/runtime/browser layer.
- [ ] Old SQLite storage upgrades without data loss.
- [ ] Public runtime enforces isolation, input/model/storage limits and truthful failure states.
- [ ] R12 evidence inspection works in the actual interface.
- [ ] Independent deterministic and held-out policy evaluation runs; failures/denominators are published.
- [ ] CI passes from a clean lockfile install under the supported Node version.
- [ ] Hosted browser/model/chat/policy/memory flow is rechecked after these fixes and dated; recording is optional supporting evidence.
- [ ] README and prompt history accurately describe the final artifact and all known gaps.
- [ ] Final reviewer repeats the failure cases in this file and records results at the final commit.

Do not spend the improvement budget on voice, MCP integrations, extra cloud services, a large rule catalog or a new frontend framework. The highest-value distinction is a small useful tool whose first use works, whose evidence is inspectable, and whose claims survive adversarial tests. Stop adding features when these gates pass and further work has low expected benefit.
