# Prompt history

Genuine, unedited prompts, tool-neutral (see `scripts/export-prompts.py`).
This project was built with Claude Code (Anthropic), model Opus 5 for
planning and Sonnet 5 for implementation, in a single continuous session on
2026-09-19/20 (`/Users/ashraf/.claude/projects/.../11f692c8-....jsonl`,
sessionId `11f692c8-9c61-4598-b1c1-5b06a35bd1bf`).

## Index

- [`prompts/session-01-planning-and-build.md`](prompts/session-01-planning-and-build.md)
  — all 8 human-authored prompts from the session, in order, including
  mid-turn interjections (messages sent while a previous turn was still
  running — Claude Code surfaces these distinctly, and the exporter captures
  both kinds).

## How this was captured

`scripts/export-prompts.py` reads the session's own JSONL transcript
directly — the same file Claude Code itself reads — rather than a
hand-written summary. It extracts two kinds of entries: the text the human
typed to start a turn, and `queued_command` attachments with
`origin.kind == "human"`, which are messages sent mid-turn. It does **not**
include tool outputs, system reminders, or the assistant's own responses —
only what a person actually typed. Run it yourself: `python3
scripts/export-prompts.py <transcript.jsonl> <output.md> <title>`.

## Redaction

The initial prompt is the full pasted job posting and application form,
which contained Ashraf's personal phone number and two email addresses.
Partway through the session, Ashraf also pasted a live Cloudflare API token
directly into chat so this work could deploy and verify against the real
API. All of these are redacted with an explicit `[REDACTED: <label>]` marker
by regex in the exporter — see `REDACTIONS` in `scripts/export-prompts.py`.

The token redaction was **not caught on the first export** — an earlier
version of the exporter only redacted phone/email patterns, and the token
appeared in plaintext in a draft of `prompts/session-01-planning-and-build.md`
that was about to be committed. It was caught before any `git add`/`commit`
(verified via `git status` and a repo-wide grep for the token string — see
git history if this repo's history is ever inspected for the fix commit),
the exporter was given a token-pattern rule plus a generic long-opaque-string
fallback, and re-run. Nothing else in this transcript matched a secret/token
pattern on inspection beyond what the exporter now redacts automatically;
that was checked manually, not exhaustively, so treat this as "checked," not
"guaranteed clean." **The token itself should be rotated/revoked** once this
project is done being iterated on, since it was pasted into a chat session
whose local transcript (outside this repo, on Ashraf's machine) retains it
in plaintext — that's normal for how Claude Code stores history, but it's a
reason to rotate the credential, not a reason to worry about this repo.

## What the model got wrong, and the correction

- **First plan draft overclaimed.** An earlier draft of `PLAN.md` (written
  before this repository existed) asserted things like "0% false negatives"
  and ranked this idea against six other GitHub repositories as if that were
  a verified competitive study. Prompt 7 ("tell me what is left have you
  completed the entire submission") and a general "how confident are you"
  push (see the conversation around prompt 8) forced an honest self-review:
  the plan was rewritten to remove outage guarantees, replace the
  unverified competitor ranking with a plainly-labeled informal check,
  separate deterministic facts from AI-generated advisory text, and add
  explicit acceptance gates instead of adjectives like "good enough to win."
  The version in this repository's `PLAN.md` is the corrected one.
- **Assumed a Cloudflare deadline that didn't exist.** An early draft
  scheduled the build around a fixed 7-day window. Ashraf's actual
  constraint, surfaced during planning, was "as long as you need" — the plan
  was rewritten to use milestones (M0–M4) instead of calendar days.
- **The `agents` npm package failed to bundle** (`@modelcontextprotocol/*`
  imports it needs internally weren't declared as its own dependencies).
  This was a real build failure, not a prompting issue — caught by actually
  running `wrangler dev`, not assumed away. Fixed by adding those packages
  directly; documented in `docs/decisions.md`.
- **No Cloudflare credentials were available** for most of the build.
  Rather than claiming live verification was done, `docs/decisions.md` and
  the README stated plainly what wasn't verified and what was needed. Ashraf
  then supplied a scoped API token, which unblocked deployment — see below.
- **Live deployment immediately found two real bugs no mocked test could
  catch**: a packaging issue in the `agents` dependency, and — more
  interesting — Workers AI pre-parsing JSON model output into an object
  rather than returning it as a string, which silently broke every live
  policy-compile call until `wrangler tail` surfaced the actual payload
  shape and the code was fixed to handle both. Both are documented in full
  in `docs/decisions.md`, including the exact bug and the fix, because this
  is the most concrete evidence in the whole submission that "verified" here
  means actually run, not assumed.

If a later session continues this work, re-run the exporter and append a new
`prompts/session-NN-*.md` rather than editing this history.
