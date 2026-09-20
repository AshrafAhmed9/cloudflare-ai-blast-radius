// Pure types for the deterministic core. No Cloudflare or network dependency
// in this module or anywhere under src/core — see docs/decisions.md.

/** One of Terraform's plan action verbs, taken verbatim from resource_changes[].change.actions. */
export type TfAction = "no-op" | "create" | "read" | "update" | "delete";

/** Our classification of what a resource_changes[] entry means operationally. */
export type PlannedAction =
  | "no-op"
  | "create"
  | "read"
  | "update"
  | "delete"
  | "replace-delete-first" // ["delete", "create"]
  | "replace-create-first" // ["create", "delete"]
  | "unsupported"; // any other action sequence we don't recognize

export type Severity = "info" | "notable" | "high";

export interface EvidencePath {
  /** Dot/bracket path into the resource's `after`/`before`/config, e.g. "engine" or "tags[0].value". */
  path: string;
  /** True when Terraform reports this value as not knowable until apply. */
  unknown: boolean;
}

export interface ResourceChangeFact {
  /** Stable identity within one plan: address, or address + deposed key if present. */
  id: string;
  address: string;
  moduleAddress?: string;
  resourceType: string;
  providerName: string;
  mode: "managed" | "data";
  actions: TfAction[];
  plannedAction: PlannedAction;
  /** From change.replace_paths, when Terraform supplied it. Empty does not mean "no reason" — see replacementCauseAvailable. */
  replacePaths: EvidencePath[];
  /** True only when Terraform's plan JSON itself provided replace_paths or action_reason for a replacement. */
  replacementCauseAvailable: boolean;
  actionReason?: string;
  /** Paths whose value is unknown until apply, independent of replace_paths. */
  unknownPaths: string[];
  sensitivePaths: string[];
  deposed?: string;
}

export interface RuleSource {
  provider: string;
  providerVersionTested: string;
  url: string;
}

export interface RuleFinding {
  ruleId: string;
  resourceId: string;
  severity: Severity;
  message: string;
  evidence: EvidencePath[];
  source: RuleSource;
}

export type CoverageStatus = "complete" | "partial" | "unsupported";

export interface CoverageNote {
  resourceId: string;
  status: CoverageStatus;
  reason: string;
}

export interface ReferenceEdge {
  fromId: string;
  toId: string;
  /** The expression path in the referencing resource's config that produced this edge. */
  viaPath: string;
  resolved: true;
}

export interface UnresolvedReference {
  fromId: string;
  viaPath: string;
  reason: string;
}

export interface DependentResult {
  resourceId: string;
  relationship: "direct" | "transitive";
  path: string[]; // chain of resource ids from the changed resource to this dependent
}

export interface AnalysisResult {
  formatVersion: string;
  terraformVersion?: string;
  facts: ResourceChangeFact[];
  findings: RuleFinding[];
  coverage: CoverageNote[];
  edges: ReferenceEdge[];
  unresolvedReferences: UnresolvedReference[];
  /** resourceId -> its dependents, direct and transitive, evidence-chained. */
  dependents: Record<string, DependentResult[]>;
  analysisVersion: string;
  warnings: string[];
}

export const ANALYSIS_VERSION = "2026-09-20.1";
export const SUPPORTED_FORMAT_MAJOR = 1;
