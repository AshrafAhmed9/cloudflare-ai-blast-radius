# Blast Radius

A `terraform plan` reviewer. It reads `terraform show -json` output and tells
you, per resource, what's actually going to happen, with the exact field
that forced it, instead of a wall of "3 to add, 5 to change, 1 to destroy"
that everyone skims past.

**Live:** https://cf-ai-blast-radius.ashrafahmed1232.workers.dev

```
$ npm run cli -- ui/samples/replace-db.json
aws_db_instance.main  [replace-delete-first]  coverage=complete
  replace_path: instance_class
  [HIGH] Terraform plans to delete or replace this database instance. Confirm a
  recent backup or final snapshot exists before applying. (rule=aws-db-instance-loss)
  referenced by: aws_security_group_rule.db_ingress(direct)
1 finding(s), 1 high severity.
```

## Why

`terraform plan` treats a database replacement and a tag rename as the same
kind of line. An engineer approving a PR skims the summary count, sees
nothing alarming, and applies it. The database is what's gone.

This tool pulls apart what a Terraform plan actually contains: action,
rule-based finding, evidence coverage, and resource references, and shows
all four per resource, citing the exact JSON field behind each claim. It
doesn't run Terraform or apply anything, and it never says "safe." A plan
can't establish live traffic, backup recoverability, or runtime health, and
claiming otherwise would be worse than saying nothing. See
[Limitations](#limitations).

Cloudflare has [written publicly](https://blog.cloudflare.com/terraforming-cloudflare-at-cloudflare/)
about running Terraform against Atlantis with around 50 OPA/Rego policies
gating every merge. This sits next to that, not instead of it. OPA answers
"is this configuration allowed," this answers "what does this specific plan
actually do, and what's the evidence."

## Teaching it a policy in plain English

Type a sentence like *"Flag deletion or replacement of database instances"*
into the Policies panel. It gets compiled into a small typed rule (never
generated code, the schema is in `src/policies/types.ts`), previewed
against your currently selected plan so you can see exactly which resources
it would flag, and only saved once you confirm it. After that, every review
in that workspace gets checked against it, citing your sentence in the
finding.

A review's policy findings are snapshotted the moment it's created. Add a
policy later and older reviews don't silently change. See
`docs/decisions.md` for the full propose → preview → confirm → persist
lifecycle and why it works that way.

## What satisfies the assignment's requirements

| Requirement | How | Where |
| --- | --- | --- |
| LLM | Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | [`src/ai/chat.ts`](src/ai/chat.ts) |
| Workflow / coordination | Agents SDK on Durable Objects: one persisted review state machine per workspace, idempotent submission, reconnect-safe | [`src/agent.ts`](src/agent.ts) |
| Chat or voice | Browser chat over WebSocket, grounded in the selected review | [`ui/app.js`](ui/app.js), [`src/agent.ts`](src/agent.ts) |
| Memory or state | Agent SQLite: reviews and conversation survive reload | [`src/agent.ts`](src/agent.ts) |
| AI prompt history | [`PROMPTS.md`](PROMPTS.md), exported straight from the session transcript | [`PROMPTS.md`](PROMPTS.md), [`prompts/`](prompts/) |

`docs/decisions.md` covers why Workflows-the-product weren't stacked on top
of the Agent/Durable Object coordination, and why D1 isn't in here. Neither
would be pulling its weight yet.

## Running it

Offline, no credentials:

```bash
nvm install 22 && nvm use 22   # wrangler 4.x needs Node >= 22
npm install --legacy-peer-deps # see docs/decisions.md for the one dependency conflict this works around
npm run typecheck
npm test                       # 78 tests, no network
npm run cli -- ui/samples/replace-db.json
npm run cli -- ui/samples/ordinary-update.json
npm run cli -- ui/samples/incomplete-evidence.json
```

CLI exit codes: `0` no high-severity finding, `1` at least one, `2` bad
input. Zero isn't a safety guarantee, just "the checks this tool runs found
nothing." In CI the exit code is the whole gate:

```bash
npm run cli -- plan.json
```

If you want your own message on top instead of just failing the step,
capture the exit code explicitly. Don't chain it with `||`/`&&` on one
line, which quietly reports success no matter what happened (an earlier
draft of this README shipped that exact bug):

```bash
npm run cli -- plan.json
code=$?
if [ "$code" -eq 1 ]; then echo "review required"; fi
exit "$code"
```

Full app, locally (needs Cloudflare credentials: Workers AI has no local
emulation, so `npm run dev` calls the real API):

```bash
wrangler login          # or export CLOUDFLARE_API_TOKEN=...
npm run dev
npm run deploy
```

The deployed URL above already runs this. You only need this if you're
changing the code.

## How it fits together

```
Browser (ui/, plain JS + WebSocket)
  │ POST /agents/review-agent/workspace/review   { plan, idempotencyKey }
  │ WS   /agents/review-agent/workspace          { type: "chat", reviewId, text }
  ▼
worker.ts — derives workspace identity from an HttpOnly cookie server-side,
            routes to that workspace's Durable Object, serves static assets
  ▼
agent.ts — ReviewAgent (one Durable Object instance per workspace)
  1. validate + limit (1 MiB, 200 resources, 20 retained reviews)
  2. core/analyze.ts — parse → rules → graph, all deterministic, no AI
  3. persist to SQLite, respond with the complete result immediately
  4. fire-and-forget: ai/chat.ts appends a Workers AI summary to the chat
  5. chat over WebSocket, every answer grounded in the stored review and
     checked by ai/verify.ts against the plan's real resource ids
```

`src/core/` has no network dependency at all. It's the exact code the CLI
runs. The model never sees a raw plan value: `ResourceChangeFact` only ever
carries addresses, types, actions, and evidence *paths*, never the values at
those paths (`src/core/sanitize.ts`), and there's no code path that lets a
model's output write back into a finding.

## What's actually verified, and how

Offline, reproduced by `npm test`:

- **78 tests, 0 failures** across the parser, the deterministic analyzer, the
  reference graph, the six-entry rule pack, the policy interpreter's
  three-valued logic, the policy compiler (including two real bugs it
  caught before this ever ran live), proposal hashing, a worker-level test
  against the real exported HTTP handler, and a browser-client test that
  loads the actual `ui/app.js` against stubbed fetch/DOM to prove a real
  infinite-request-loop bug stays fixed.
- All three sample plans produce the exact output shown above and in
  `docs/limitations.md`.

Against the live deployment, not mocked:

- A real plan submitted returns correct deterministic findings immediately,
  then a Llama 3.3 summary lands a few seconds later citing the actual
  resource id and forcing attribute.
- Asking the live chat "why is this being replaced?" over a real WebSocket
  gets a grounded answer citing `replace_paths: instance_class`.
- Proposing a policy, confirming it, then submitting a plan afterward
  produces the policy finding citing your sentence, and a review submitted
  *before* the policy existed stays unchanged. The snapshot guarantee holds
  against real infrastructure, not just a mock.
- This is also how a real bug got caught: Workers AI hands back
  `raw.response` pre-parsed as an object, not the JSON string the
  documented example implies, when the completion is valid JSON. Every live
  policy-compile call silently failed on an empty string until this was
  found with `wrangler tail` and fixed. Full writeup in `docs/decisions.md`.

**Not measured:** accuracy against a larger real-plan corpus. There's no
`bench/` harness yet, and a made-up number here would be worse than none.

## Limitations

Full list in [`docs/limitations.md`](docs/limitations.md), including a
line-by-line disposition of everything an adversarial review pass found.
The short version: the reference graph only resolves single-instance,
root-module resources (`count`/`for_each` and nested modules come back as
explicitly unresolved, never guessed); the rule pack covers 6 resource
types; replacement causes only show up when Terraform's own plan JSON
provides them; and a couple of fixes (binding policy confirmation to a
server-issued proposal id, rejecting malformed request bodies) don't have
automated coverage yet because exercising them needs a real Durable Object
runtime this test suite doesn't have.

## Where this stands

Built and deployed. The deterministic core, rule pack, reference graph,
policy compiler, and chat are all confirmed against the live app, not just
against mocks, see the section above. `wrangler deploy` runs clean; two
real bugs (a packaging issue in the `agents` dependency, and the Workers AI
response-shape surprise above) were found and fixed by actually deploying,
not by assuming it would work.

An adversarial review pass found 15 issues. Eight are fixed, most with a
regression test: an infinite-request loop in the browser client, a
workspace-identity race on first visit, an S3 rule that missed
replacements, a policy-confirmation endpoint that trusted a
client-computable hash instead of a server-issued token, two crashes on
malformed input, two resource-address bugs in the chat verifier, and a
policy-predicate matcher that used substring matching and produced false
positives. The rest is real gaps, tracked and not hidden, in
`docs/limitations.md`: input-validation hardening, AI call budgets, a
schema migration path for already-deployed workspaces, a real benchmark
harness, a delete-workspace endpoint.

## Layout

```
README.md               this file
PROMPTS.md               prompt history index
wrangler.jsonc
src/worker.ts             Worker entry: routing, workspace identity, static assets
src/agent.ts              ReviewAgent: state, HTTP, WebSocket chat
src/cli.ts                local CLI over the same core
src/core/                  parse, sanitize, rules, graph, analyze — pure TS, no network
src/ai/                    context building, Workers AI call, grounding verifier
src/policies/              policy DSL, three-valued interpreter, English-to-rule compiler, proposal hashing
ui/                        browser client (plain HTML/CSS/JS) + sample plans
test/                      78 offline unit tests (vitest)
docs/decisions.md          the actual tradeoffs and why
docs/limitations.md        what this tool cannot tell you
prompts/                   raw exported prompt history
scripts/export-prompts.py  the exporter that produced prompts/
```
