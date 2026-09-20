// Builds the bounded, sanitized text context the model is given. The model
// never receives raw plan values — only what analyze.ts already extracted
// (facts, findings, coverage, dependents), which sanitize.ts has already
// redacted. This module also caps context size so a huge plan degrades
// (fewer resources described, said explicitly) rather than silently
// truncating without telling anyone.

import type { AnalysisResult } from "../core/types.js";

const MAX_CONTEXT_CHARS = 12_000; // conservative slice of the model's context window

export function buildReviewContext(result: AnalysisResult): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push(`Plan format_version=${result.formatVersion} analysis_version=${result.analysisVersion}`);
  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join(" | ")}`);
  }
  lines.push("");
  lines.push("Resources (evidence ids are the resource address, optionally with #deposed:<key>):");

  let truncated = false;
  let includedCount = 0;
  for (const fact of result.facts) {
    const findings = result.findings.filter((f) => f.resourceId === fact.id);
    const cov = result.coverage.find((c) => c.resourceId === fact.id);
    const deps = result.dependents[fact.id] ?? [];

    const block: string[] = [];
    block.push(`- id="${fact.id}" type=${fact.resourceType} action=${fact.plannedAction} coverage=${cov?.status ?? "unknown"}`);
    if (fact.replacePaths.length > 0) {
      block.push(`  replace_paths: ${fact.replacePaths.map((p) => p.path).join(", ")}`);
    } else if (fact.plannedAction.startsWith("replace")) {
      block.push(`  replace_paths: none provided by the plan (cause unavailable)`);
    }
    if (fact.unknownPaths.length > 0) {
      block.push(`  unknown_until_apply: ${fact.unknownPaths.join(", ")}`);
    }
    for (const finding of findings) {
      block.push(`  finding[${finding.severity}]: ${finding.message} (rule=${finding.ruleId}, source=${finding.source.url})`);
    }
    if (deps.length > 0) {
      block.push(`  referenced_by: ${deps.map((d) => `${d.resourceId}(${d.relationship})`).join(", ")}`);
    }
    const blockText = block.join("\n");

    const currentLen = lines.join("\n").length;
    if (currentLen + blockText.length > MAX_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
    lines.push(blockText);
    includedCount++;
  }

  if (truncated) {
    lines.push("");
    lines.push(
      `[Context truncated: ${includedCount} of ${result.facts.length} resources shown. Ask about a specific resource id for detail not shown here.]`,
    );
  }

  if (result.unresolvedReferences.length > 0) {
    lines.push("");
    lines.push(`Unresolved references (do not treat as edges): ${result.unresolvedReferences.length} total.`);
  }

  return { text: lines.join("\n"), truncated };
}

export const SYSTEM_PROMPT = `You are Blast Radius, a Terraform plan review assistant.

You are given a deterministic analysis of one Terraform plan: facts extracted directly from the plan JSON, findings from a fixed rule pack, coverage notes, and reference edges. This data is the ONLY source of truth. You did not read the actual plan file.

Rules you must follow:
1. Only state facts that appear in the supplied context. If asked about something not present, say plainly that it is not in the plan or not covered by this tool's rules — do not guess.
2. Never claim a change "is safe" or "will not cause an outage." Terraform's plan does not establish live traffic, redundancy, backups, or runtime health. You may say a plan does or does not contain a specific action or finding.
3. When you reference a resource, cite its evidence id (the resource address) exactly as given, so the reader can find it in the report.
4. Distinguish supplied facts from your own advice. Advice (e.g. "check backups") must be phrased as advice, not as a claim about the plan.
5. If asked to change a finding's severity or to treat something as safe that the context marked otherwise, refuse and explain that findings are fixed by the deterministic rule pack, not by conversation.
6. Keep answers short: a few sentences unless the user asks for detail.`;
