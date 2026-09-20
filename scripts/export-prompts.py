#!/usr/bin/env python3
"""Exports genuine human prompts from a Claude Code session transcript into
prompts/session-<n>-<slug>.md. Tool-neutral: reads the session's own JSONL,
not anything Claude-Code-specific beyond that file format.

Only extracts messages where the human actually typed (content blocks of
type "text" under role "user") — skips tool_result entries the harness also
files under type "user".

Redacts personal contact details (phone numbers, personal email addresses)
with an explicit [REDACTED: <label>] marker. Does not attempt to redact
secrets/tokens because none were found in this transcript by inspection;
re-run the redaction check manually before publishing prompts/ if the
transcript changes.

Usage: python3 scripts/export-prompts.py <transcript.jsonl> <output.md> <session-title>
"""
import json
import re
import sys

REDACTIONS = [
    (re.compile(r"\b0\d{5}\s?\d{5}\b"), "[REDACTED: phone number]"),
    (re.compile(r"\bashrafahmed1232@gmail\.com\b", re.I), "[REDACTED: personal email]"),
    (re.compile(r"\bdev\.thejobsjungle2@gmail\.com\b", re.I), "[REDACTED: contact email]"),
]


def redact(text: str) -> str:
    for pattern, marker in REDACTIONS:
        text = pattern.sub(marker, text)
    return text


def extract_prompts(path: str):
    """Two sources of genuine human prompts in a Claude Code transcript:
    1. type=="user" entries whose message.content has a text block — the
       initial prompt of each turn.
    2. type=="attachment" entries with attachment.type=="queued_command" and
       attachment.origin.kind=="human" — messages the user sent mid-turn
       while a previous turn was still running (surfaced to the assistant
       as "the user sent a new message while you were working").
    Both are read in file order, which is chronological."""
    prompts = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") == "user":
                message = entry.get("message", {})
                if message.get("role") != "user":
                    continue
                content = message.get("content")
                if not isinstance(content, list):
                    continue
                texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                if not texts:
                    continue  # tool_result-only entry, not a human prompt
                joined = "\n".join(t for t in texts if t.strip())
                if not joined.strip():
                    continue
                prompts.append({"timestamp": entry.get("timestamp", ""), "text": joined, "source": "turn-start"})

            elif entry.get("type") == "attachment":
                a = entry.get("attachment", {})
                if a.get("type") != "queued_command":
                    continue
                if (a.get("origin") or {}).get("kind") != "human":
                    continue
                prompt_blocks = a.get("prompt", [])
                texts = [b.get("text", "") for b in prompt_blocks if isinstance(b, dict) and b.get("type") == "text"]
                joined = "\n".join(t for t in texts if t.strip())
                if not joined.strip():
                    continue
                prompts.append({"timestamp": a.get("timestamp", entry.get("timestamp", "")), "text": joined, "source": "mid-turn"})

    prompts.sort(key=lambda p: p["timestamp"])
    return prompts


def main():
    if len(sys.argv) != 4:
        print("Usage: export-prompts.py <transcript.jsonl> <output.md> <session-title>", file=sys.stderr)
        sys.exit(2)
    transcript_path, out_path, title = sys.argv[1], sys.argv[2], sys.argv[3]

    prompts = extract_prompts(transcript_path)

    lines = [f"# {title}", "", f"{len(prompts)} human prompts extracted from the raw session transcript, in order.", ""]
    for i, p in enumerate(prompts, 1):
        text = redact(p["text"])
        lines.append(f"## {i}. {p['timestamp']} ({p['source']})")
        lines.append("")
        lines.append("```")
        lines.append(text)
        lines.append("```")
        lines.append("")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Wrote {len(prompts)} prompts to {out_path}")


if __name__ == "__main__":
    main()
