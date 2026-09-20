// A small, real grounding check on the model's chat output. It cannot prove
// arbitrary natural-language truth (see PLAN.md §6) — it only checks that
// every resource id the model claims to cite actually exists in the review
// it was given. This catches the cheapest and most common failure mode: the
// model inventing a plausible-looking resource address.

import type { AnalysisResult } from "../core/types.js";

// Matches things that look like resource addresses: type.name, optionally
// with an index/key or #deposed suffix, e.g. aws_db_instance.main,
// module.x.aws_instance.web[0], cloudflare_dns_record.api#deposed:ab12.
const ADDRESS_PATTERN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-zA-Z0-9_\-]+(?:\[[^\]]+\])?(?:#deposed:[a-zA-Z0-9]+)?)\b/g;

// Terraform type/provider name fragments that match the address shape but
// are not resource addresses on their own (avoid false-positive flags).
const NON_ADDRESS_PREFIXES = ["var.", "local.", "data.", "module.", "each.", "count.", "path.", "terraform."];

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
