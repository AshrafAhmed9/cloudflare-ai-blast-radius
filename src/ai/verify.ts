// A small, real grounding check on the model's chat output. It cannot prove
// arbitrary natural-language truth (see PLAN.md §6) — it only checks that
// every resource id the model claims to cite actually exists in the review
// it was given. This catches the cheapest and most common failure mode: the
// model inventing a plausible-looking resource address.

import type { AnalysisResult } from "../core/types.js";

// Matches a full dot-joined identifier chain, each segment optionally
// bracket-indexed, e.g. aws_db_instance.main, aws_instance.web[0],
// module.prod.aws_db_instance.main, cloudflare_dns_record.api#deposed:ab12.
// Greedy: consumes as many ".segment" hops as are contiguously present, so
// a module-qualified address isn't truncated to its last two segments and
// an index suffix isn't dropped by \b backtracking on the closing "]"
// (both were real bugs — confirmed by testing the previous single-hop
// pattern against exactly these two cases; see git history).
const ADDRESS_PATTERN =
  /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]\s]+\])?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]\s]+\])?)+(?:#deposed:[a-zA-Z0-9]+)?/g;

// Reference-only prefixes that can never be a resource address on their
// own (var./local./each./count./path./terraform. inputs and locals never
// appear as a fact's `address`). Deliberately NOT excluding "module." or
// "data." here: a module-qualified resource address legitimately starts
// with "module." (e.g. module.prod.aws_db_instance.main), and a data
// source's address legitimately starts with "data." — both can be real,
// known addresses, so they're checked against knownAddresses like anything
// else instead of being blanket-excluded.
const NON_ADDRESS_PREFIXES = ["var.", "local.", "each.", "count.", "path.", "terraform."];

export interface VerifiedAnswer {
  text: string;
  citedUnknownIds: string[];
  note?: string;
}

export function verifyChatAnswer(rawText: string, result: AnalysisResult): VerifiedAnswer {
  const knownIds = new Set(result.facts.map((f) => f.id));
  const knownAddresses = new Set(result.facts.map((f) => f.address));

  const candidates = new Set(rawText.match(ADDRESS_PATTERN) ?? []);
  const citedUnknownIds: string[] = [];

  for (const candidate of candidates) {
    if (NON_ADDRESS_PREFIXES.some((p) => candidate.startsWith(p))) continue;
    if (knownIds.has(candidate) || knownAddresses.has(candidate)) continue;
    // Looks like a resource address but isn't one in this plan.
    citedUnknownIds.push(candidate);
  }

  if (citedUnknownIds.length === 0) {
    return { text: rawText, citedUnknownIds: [] };
  }

  const note = `Note: this answer mentions ${citedUnknownIds.join(", ")}, which ${
    citedUnknownIds.length === 1 ? "is not a resource" : "are not resources"
  } in this plan. Treat that part as unverified.`;

  return { text: rawText, citedUnknownIds, note };
}
