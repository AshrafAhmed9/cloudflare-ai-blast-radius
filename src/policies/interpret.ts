// Pure interpreter for a compiled PolicyRule against one ResourceChangeFact.
// Three-valued logic per PLAN.md §6: a rule can MATCH, NOT MATCH, or be
// UNKNOWN — missing/unavailable evidence must never silently satisfy (or
// silently fail) a predicate. No network, no AI, fully deterministic.

import type { ResourceChangeFact } from "../core/types.js";
import type { PolicyRule, PolicyMatch } from "./types.js";

function typeMatches(rule: PolicyRule, fact: ResourceChangeFact): boolean {
  return rule.resourceTypes.includes("*") || rule.resourceTypes.includes(fact.resourceType as PolicyRule["resourceTypes"][number]);
}

function actionMatches(rule: PolicyRule, fact: ResourceChangeFact): boolean {
  return rule.actions.includes(fact.plannedAction as PolicyRule["actions"][number]);
}

/** Evaluates the attribute predicate, if any. Returns null when there's no
 *  predicate (nothing further to check — the type/action match already
 *  decided it), or a three-valued result when there is one. */
function predicateMatches(rule: PolicyRule, fact: ResourceChangeFact): PolicyMatch | null {
  const predicate = rule.attributePredicate;
  if (!predicate) return null;

  if (predicate.kind === "replace_path_includes") {
    // A replacement with no replace_paths and no cause available means we
    // genuinely don't know whether the predicate's attribute was involved.
    const isReplacement = fact.plannedAction === "replace-delete-first" || fact.plannedAction === "replace-create-first";
    if (isReplacement && !fact.replacementCauseAvailable) return "unknown";
    const found = fact.replacePaths.some((p) => p.path.includes(predicate.value));
    return found ? "match" : "no-match";
  }

  if (predicate.kind === "unknown_path_includes") {
    const found = fact.unknownPaths.some((p) => p.includes(predicate.value));
    return found ? "match" : "no-match";
  }

  return null;
}

export function evaluatePolicy(rule: PolicyRule, fact: ResourceChangeFact): PolicyMatch {
  if (!typeMatches(rule, fact)) return "no-match";
  if (!actionMatches(rule, fact)) return "no-match";

  const predicateResult = predicateMatches(rule, fact);
  if (predicateResult === null) return "match"; // type+action matched, no further predicate to check
  return predicateResult;
}

export function evaluatePolicyAgainstFacts(
  rule: PolicyRule,
  facts: readonly ResourceChangeFact[],
): { resourceId: string; result: PolicyMatch }[] {
  return facts
    .map((f) => ({ resourceId: f.id, result: evaluatePolicy(rule, f) }))
    .filter((r) => r.result !== "no-match"); // "no-match" is the overwhelming common case; don't report every non-match
}
