#!/usr/bin/env node
/// <reference types="node" />
// Local CLI over the deterministic core. Invoke via `npm run cli -- <file>`
// after `npm install` (this package is not published, so don't advertise
// `npx blast-radius` — see PLAN.md §4).
//
// Exit codes:
//   0 = analysis completed, no "high" severity finding under supported checks
//   1 = analysis completed, at least one "high" severity finding
//   2 = invalid/unsupported input, or the plan could not be parsed
//
// Exit code 0 means "no high-severity finding was produced by the checks
// this tool runs" — it is not a safety guarantee. See README limitations.

import { readFileSync } from "node:fs";
import { analyzePlan } from "./core/analyze.js";
import { PlanParseError } from "./core/parse.js";
import type { AnalysisResult } from "./core/types.js";

function printTable(result: AnalysisResult): void {
  console.log(`format_version=${result.formatVersion} terraform_version=${result.terraformVersion ?? "unknown"} analysis_version=${result.analysisVersion}\n`);

  if (result.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of result.warnings) console.log(`  - ${w}`);
    console.log("");
  }

  console.log("Resources:");
  for (const fact of result.facts) {
    const findings = result.findings.filter((f) => f.resourceId === fact.id);
    const cov = result.coverage.find((c) => c.resourceId === fact.id);
    const deps = result.dependents[fact.id] ?? [];
    console.log(`  ${fact.address}  [${fact.plannedAction}]  coverage=${cov?.status}`);
    if (fact.plannedAction.startsWith("replace") && !fact.replacementCauseAvailable) {
      console.log(`    ! replacement cause unavailable in plan JSON`);
    }
    for (const rp of fact.replacePaths) {
      console.log(`    replace_path: ${rp.path}`);
    }
    for (const finding of findings) {
      console.log(`    [${finding.severity.toUpperCase()}] ${finding.message} (rule=${finding.ruleId})`);
    }
    if (deps.length > 0) {
      console.log(`    referenced by: ${deps.map((d) => `${d.resourceId}(${d.relationship})`).join(", ")}`);
    }
  }

  if (result.unresolvedReferences.length > 0) {
    console.log("\nUnresolved references (not evaluated, not assumed safe):");
    for (const u of result.unresolvedReferences) {
      console.log(`  - ${u.fromId} via ${u.viaPath}: ${u.reason}`);
    }
  }

  const highCount = result.findings.filter((f) => f.severity === "high").length;
  console.log(`\n${result.findings.length} finding(s), ${highCount} high severity.`);
}

function main(): number {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: npm run cli -- <plan.json> [--json]");
    console.error("Input must be the output of: terraform show -json <planfile>");
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`Could not read/parse "${filePath}" as JSON: ${(err as Error).message}`);
    return 2;
  }

  let result: AnalysisResult;
  try {
    result = analyzePlan(raw);
  } catch (err) {
    if (err instanceof PlanParseError) {
      console.error(err.message);
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 2;
    }
    throw err;
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result);
  }

  const hasHigh = result.findings.some((f) => f.severity === "high");
  return hasHigh ? 1 : 0;
}

process.exit(main());
