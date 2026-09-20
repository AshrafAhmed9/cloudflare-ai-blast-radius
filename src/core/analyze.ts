// Orchestrates the deterministic core: parse -> sanitize -> rules -> graph
// -> coverage. Zero network, zero AI. This is the only module callers
// (CLI, Worker, Agent) should import for "what does this plan mean".

import { buildGraph } from "./graph.js";
import { parsePlan } from "./parse.js";
import { evaluateRules, RULE_COVERED_TYPES } from "./rules.js";
import { sanitizeFacts } from "./sanitize.js";
import { ANALYSIS_VERSION, type AnalysisResult, type CoverageNote, type RuleFinding } from "./types.js";

export function analyzePlan(raw: unknown): AnalysisResult {
  const parsed = parsePlan(raw); // throws PlanParseError on invalid input — caller decides how to surface it
  const facts = sanitizeFacts(parsed.facts);

  const findings: RuleFinding[] = [];
  const coverage: CoverageNote[] = [];

  for (const fact of facts) {
    findings.push(...evaluateRules(fact));

    if (fact.plannedAction === "unsupported") {
      coverage.push({
        resourceId: fact.id,
        status: "unsupported",
        reason: `Unrecognized action sequence [${fact.actions.join(",")}]. Not evaluated by any rule.`,
      });
      continue;
    }

    const isReplacement = fact.plannedAction === "replace-delete-first" || fact.plannedAction === "replace-create-first";
    if (isReplacement && !fact.replacementCauseAvailable) {
      coverage.push({
        resourceId: fact.id,
        status: "partial",
        reason: "Terraform's plan JSON did not include replace_paths or an action_reason for this replacement; the specific cause is unavailable.",
      });
    } else if (!RULE_COVERED_TYPES.has(fact.resourceType)) {
      coverage.push({
        resourceId: fact.id,
        status: "unsupported",
        reason: `No rule is defined for resource type "${fact.resourceType}". Only the plan's declared action is available for this resource.`,
      });
    } else {
      coverage.push({ resourceId: fact.id, status: "complete", reason: "Covered by the rule pack for this resource type and action." });
    }
  }

  const graph = buildGraph(parsed.configuration, facts);

  return {
    formatVersion: parsed.formatVersion,
    terraformVersion: parsed.terraformVersion,
    facts,
    findings,
    coverage,
    edges: graph.edges,
    unresolvedReferences: graph.unresolvedReferences,
    dependents: graph.dependents,
    analysisVersion: ANALYSIS_VERSION,
    warnings: parsed.warnings,
  };
}
