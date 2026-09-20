// A small, typed policy DSL. No generated code, no eval, no arbitrary regex
// or SQL — a policy is data, interpreted by interpret.ts. See PLAN.md §6.

import { z } from "zod";
import type { PlannedAction } from "../core/types.js";

// Fixed allowlist the compiler must choose from — not open-ended free text,
// so a compiled policy can only ever reference resource types this tool
// already has some rule-pack knowledge of, plus "*" for "any type".
export const POLICY_RESOURCE_TYPES = [
  "*",
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_s3_bucket",
  "aws_ebs_volume",
  "cloudflare_d1_database",
  "cloudflare_dns_record",
] as const;

export const POLICY_ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "replace-delete-first",
  "replace-create-first",
] as const satisfies readonly PlannedAction[];

const AttributePredicateSchema = z.object({
  kind: z.enum(["replace_path_includes", "unknown_path_includes"]),
  value: z.string().min(1).max(200),
});

export const PolicyRuleSchema = z.object({
  resourceTypes: z.array(z.enum(POLICY_RESOURCE_TYPES)).min(1).max(10),
  actions: z.array(z.enum(POLICY_ACTIONS)).min(1).max(6),
  attributePredicate: AttributePredicateSchema.nullable(),
  severity: z.enum(["info", "notable", "high"]),
  summary: z.string().min(1).max(300),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type AttributePredicate = z.infer<typeof AttributePredicateSchema>;

export interface StoredPolicy {
  id: string;
  sentence: string;
  rule: PolicyRule;
  createdAt: string;
  proposalHash: string;
}

export type PolicyMatch = "match" | "no-match" | "unknown";

export interface PolicyFinding {
  policyId: string;
  sentence: string;
  resourceId: string;
  result: PolicyMatch;
  severity: PolicyRule["severity"];
}
