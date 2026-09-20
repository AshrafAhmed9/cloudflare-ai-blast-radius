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

## Why the policy compiler (English → executable rule) was cut from this pass

This was the most distinctive idea in earlier drafts of this plan, and it's
explicitly still the "full submission target." It was cut from the initial
working slice for one reason: it is the single highest-risk piece to get
right (constrained DSL, three-valued logic, confirm-before-persist lifecycle,
held-out evaluation) and the plan's own stop rule says to cut the compiler and
its evaluation together rather than ship a compiler without evaluation. The
rest of the submission — parser, rules, graph, chat, persistent memory,
CLI — is complete, tested, and honest about its limits. The compiler is the
next thing to build if there's more time before submission; it is not silently
dropped, it's sequenced.

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

## Why `wrangler dev` and deploy were not verified against the live Workers AI service

Workers AI has no local emulation — every `env.AI.run()` call proxies to the
real Cloudflare API, which requires an authenticated `wrangler` session or a
`CLOUDFLARE_API_TOKEN`. Neither was available in the environment this was
built in (`wrangler whoami` reports not logged in, no token set). Everything
that doesn't require the AI binding was verified directly: the deterministic
core, the CLI (run against all three real sample plans with correct output and
exit codes), and all 33 offline unit tests pass under Node 22 (the minimum
`wrangler` 4.135 requires — this machine's default Node was 20.20.2, switched
via `nvm install 22`).

What was **not** independently verified before this commit: a live Workers AI
response (the model call path is unit-tested against a mock, not the real
API), the WebSocket chat flow end-to-end in a browser, and an actual
`wrangler deploy`. These need one of: `wrangler login` run interactively, or a
`CLOUDFLARE_API_TOKEN` in the environment. This is stated plainly rather than
claimed as done — see the README's "Verified vs. not yet verified" section.
