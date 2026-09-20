# Blast Radius

Reads `terraform show -json` output and reports what each planned change
actually does, with the exact evidence for each claim — not a guess, and
never "safe to apply."

**Deployed URL:** https://cf-ai-blast-radius.ashrafahmed1232.workers.dev —
live, verified end-to-end (deterministic analysis, live Workers AI chat, and
the policy compiler all tested against the real running app — see
[Status](#status)).

```
$ npm run cli -- ui/samples/replace-db.json
aws_db_instance.main  [replace-delete-first]  coverage=complete
  replace_path: instance_class
  [HIGH] Terraform plans to delete or replace this database instance. Confirm a
  recent backup or final snapshot exists before applying. (rule=aws-db-instance-loss)
  referenced by: aws_security_group_rule.db_ingress(direct)
1 finding(s), 1 high severity.
```

## What this is, and isn't

Terraform's plan output is a wall of JSON. Engineers approving a change skim
it; the line that deletes a database looks the same as the line that renames
a tag. This tool separates four things Terraform's plan JSON actually
contains — planned action, rule-based findings, evidence coverage, and
resource references — and shows them per-resource, with the exact field that
triggered each finding.

It does **not** run Terraform, apply anything, or claim a plan is safe. A
plan does not establish live traffic, redundancy, backup recoverability, or
runtime health — see [Limitations](#limitations).

Cloudflare has [publicly written about](https://blog.cloudflare.com/terraforming-cloudflare-at-cloudflare/)
managing their own infrastructure with Terraform, Atlantis, and ~50 OPA/Rego
policies. This tool complements that kind of workflow — it doesn't replace a
production policy engine, and OPA already does plan-level policy evaluation.
What this adds is an evidence-linked explanation and conversational review on
top of the same plan JSON.

## The distinctive part: teach it a policy in English

Beyond reviewing a plan against the built-in rule pack, you can type a
sentence like *"Flag deletion or replacement of database instances"* into
the Policies panel. It's compiled into a small typed rule (never generated
code — see `src/policies/types.ts`), previewed against the currently
selected plan so you see exactly which resources it would flag before it's
saved, and only persisted after you confirm. From then on, every review
submitted in that workspace is checked against it too, citing your own
sentence in the finding. A review's policy findings are snapshotted at
creation time — adding a policy later doesn't retroactively change an
earlier review's findings. See `docs/decisions.md` for the full lifecycle
(propose → dry-run → hash-bound confirm → persist) and why that matters.

## Requirements mapping

| Requirement | Implementation | Where |
| --- | --- | --- |
| LLM | Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | [`src/ai/chat.ts`](src/ai/chat.ts) |
| Workflow / coordination | Cloudflare Agents SDK on Durable Objects — a persisted review state machine with idempotent submission and reconnect-safe state | [`src/agent.ts`](src/agent.ts) |
| Chat or voice | Browser chat over WebSocket, grounded in the selected review | [`ui/app.js`](ui/app.js), [`src/agent.ts`](src/agent.ts) |
| Memory or state | Agent SQLite: reviews and conversation persist per workspace, survive reload | [`src/agent.ts`](src/agent.ts) |
| AI prompt history | Root `PROMPTS.md`, exported from the real session transcript | [`PROMPTS.md`](PROMPTS.md) |

See [`docs/decisions.md`](docs/decisions.md) for why Workflows (plural, the
product) weren't added on top of the Agent/Durable Object coordination, and
why D1 wasn't added — both are real tradeoffs, not omissions.

## Quick start (offline — no credentials needed)

```bash
nvm install 22 && nvm use 22   # wrangler 4.x requires Node >= 22
npm install --legacy-peer-deps # see docs/decisions.md for the one dependency conflict this bypasses
npm run typecheck
npm test                       # 75 tests, all offline, no network
npm run cli -- ui/samples/replace-db.json
npm run cli -- ui/samples/ordinary-update.json
npm run cli -- ui/samples/incomplete-evidence.json
```

CLI exit codes: `0` = no high-severity finding under supported checks, `1` =
at least one high-severity finding, `2` = invalid/unsupported input. Exit `0`
is not a safety guarantee — it means the checks this tool runs found nothing.

Example CI usage — the exit code alone is the gate; most CI systems fail the
step automatically on a non-zero exit, so no extra shell logic is needed:

```bash
npm run cli -- plan.json
```

If you want a custom message on top of that (rather than just failing the
step), capture and re-propagate the exit code explicitly — do **not** chain
it with `||`/`&&` on one line, which silently swallows the real exit code
(a mistake an earlier draft of this README made — the compound line reported
success even when a high-severity finding was present):

```bash
npm run cli -- plan.json
code=$?
if [ "$code" -eq 1 ]; then echo "review required"; fi
exit "$code"
```

## Running the full app locally (needs Cloudflare credentials)

```bash
wrangler login          # or: export CLOUDFLARE_API_TOKEN=...
npm run dev              # wrangler dev — proxies Workers AI to the real API, so this is not free
npm run deploy
```

Workers AI has no local emulation; every `env.AI.run()` call in `npm run dev`
hits the real API. The deployed app above is already live and doesn't
require this — this is only for local development.

## Architecture

```
Browser (ui/, vanilla JS + WebSocket)
  │ POST /agents/review-agent/workspace/review   { plan, idempotencyKey }
  │ WS   /agents/review-agent/workspace          { type: "chat", reviewId, text }
  ▼
worker.ts — derives workspace identity from an HttpOnly cookie server-side,
            routes to that workspace's Durable Object, serves static assets
  ▼
agent.ts — ReviewAgent (Agents SDK, one instance per workspace)
  1. validate + limit (1 MiB, 200 resources, 20 retained reviews)
  2. core/analyze.ts — parse → sanitize → rules → graph   (deterministic, no AI)
  3. persist to SQLite, respond immediately with the complete result
  4. fire-and-forget: ai/chat.ts summarizes via Workers AI, appended to chat
  5. chat over WebSocket: every answer grounded in the stored review,
     checked by ai/verify.ts against the plan's real resource ids
```

`src/core/` has zero network dependency — it's the same code the CLI runs.
The model never sees raw plan values (sanitize.ts redacts sensitive paths
first) and can never change a finding — see `docs/decisions.md`.

## Results

Offline, deterministic, reproduced by `npm test`:

- **75 unit tests, 0 failures** — parser (10), analyze orchestrator (7),
  reference graph (6), rule pack (12), sanitize/redaction (6), AI
  context/verify (9), policy interpreter's three-valued logic (11), policy
  compiler including two real bugs it caught (9), proposal-hash binding (4),
  and a browser-client regression test that loads the actual `ui/app.js`
  against stubbed fetch/DOM to prove a real infinite-request-loop bug (found
  by adversarial review) stays fixed (1).
- All three sample plans (`ui/samples/*.json`) produce the exact output shown
  at the top of this README and in [`docs/limitations.md`](docs/limitations.md).

Live, verified against the deployed app (not mocked):

- Submitted a real plan → correct deterministic findings, then a live Llama
  3.3 summary appended a few seconds later, correctly citing the resource id
  and the exact attribute that forced the replacement.
- Asked the live chat "why is this being replaced?" over a real WebSocket
  connection → grounded, correct answer citing `replace_paths: instance_class`.
- Proposed a live policy ("Flag deletion or replacement of database
  instances") → compiled, dry-run showed the correct match, confirmed, then
  a **new** review submitted afterward showed the policy finding citing the
  sentence, while the **original** review (submitted before the policy
  existed) stayed unchanged at zero policy findings — the snapshot guarantee
  from `docs/decisions.md` holds against the real infrastructure, not just
  in mocked tests.
- This surfaced and fixed a real bug: Workers AI returns `raw.response`
  **pre-parsed as an object**, not a JSON string, when the completion is
  valid JSON — undocumented behavior found via `wrangler tail`, not in the
  docs. The policy compiler was silently getting an empty string and failing
  every live request until this was fixed. See `docs/decisions.md`.

**Not yet measured:** a held-out accuracy benchmark against a larger
real-plan corpus (`bench/` — see [Status](#status)); publishing a fabricated
number here would be worse than publishing none.

## Limitations

See [`docs/limitations.md`](docs/limitations.md) for the full list, including
an itemized adversarial-review backlog (`docs/limitations.md#adversarial-review-findings`)
covering what was fixed versus deliberately deferred. In short: the reference
graph only resolves single-instance, root-module resources (count/for_each
and nested modules are reported as unresolved, not guessed); the rule pack
covers 6 resource types; replacement causes are only shown when Terraform's
plan JSON itself provides them; the policy-confirm step trusts a
client-recomputable hash rather than a server-issued opaque proposal token,
so it binds an *edited* proposal to its preview but doesn't stop someone from
skipping the preview step entirely (see R7 in the linked backlog).

## Status

Honest, as of this commit:

- **Built, deployed, and verified live:** deterministic core, rule pack,
  reference graph, policy compiler, chat — all confirmed against the real
  running app at the URL above, not just mocked tests. 75 passing offline
  tests, clean typecheck, CI green. `wrangler deploy` succeeded; a real
  packaging bug in the `agents@0.24.0` dependency and a real Workers AI
  response-shape bug in the policy compiler were both found and fixed by
  actually running this live, not assumed away — see `docs/decisions.md`
  and the Results section above.
- **Adversarial review found and this pass fixed 5 real bugs**, each with a
  regression test proving it: a genuine infinite-request loop in the browser
  client that never settled once any review existed (caught with a test
  that loads the real `ui/app.js` and fails against the old code, passes
  against the fix); an S3 bucket rule that only matched plain deletion, not
  replacement, silently missing the exact "silent failure" shape this
  project is built to catch; `action_reason` read from the wrong location
  in Terraform's JSON schema (always silently `undefined`); and two
  resource-address-matching bugs in the chat grounding verifier (indexed
  addresses like `aws_instance.web[0]` losing their bracket, module-qualified
  addresses like `module.prod.aws_db_instance.main` truncated to their last
  two segments) — both confirmed with `node -e` against the live regex
  before fixing.
- **Not fixed, deliberately deferred, tracked honestly:** a real design gap
  where policy confirmation trusts a client-recomputable hash rather than a
  server-issued proposal token; several input-validation and
  observability hardening items; a SQLite schema-migration path for
  existing deployed workspaces; `bench/` accuracy measurement against a
  larger real-plan corpus; a held-out policy-compiler evaluation set; a
  delete-workspace endpoint. Full itemized list with severity and reasoning
  in `docs/limitations.md`.

## Repository layout

```
README.md            this file
PROMPTS.md            prompt history index
PLAN.md               the implementation plan this was built from
wrangler.jsonc
src/worker.ts          Worker entry: routing, workspace identity, static assets
src/agent.ts           ReviewAgent: state, HTTP, WebSocket chat
src/cli.ts             local CLI over the same core
src/core/               parse, sanitize, rules, graph, analyze — pure TS, no network
src/ai/                 context building, Workers AI call, grounding verifier
src/policies/           policy DSL, three-valued interpreter, English-to-rule compiler, proposal hashing
ui/                     browser client (plain HTML/CSS/JS) + sample plans
test/                   33 offline unit tests (vitest)
docs/decisions.md       the actual tradeoffs and why
docs/limitations.md     what this tool cannot tell you
prompts/                raw exported prompt history
scripts/export-prompts.py   the exporter that produced prompts/
```
