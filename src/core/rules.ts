// A small, hand-written, versioned rule pack. Each rule cites the exact
// provider resource doc it was written against. Deliberately narrow — see
// docs/decisions.md for why this stays at 6 rules instead of trying to
// reproduce full provider ForceNew semantics.
//
// A rule NEVER claims certainty beyond what the plan's actions establish.
// "Terraform plans to delete/replace X" is a fact from the plan. "Verify
// backups" is advice, not a guarantee anything is recoverable.

import type { PlannedAction, ResourceChangeFact, RuleFinding, RuleSource, Severity } from "./types.js";

export interface Rule {
  id: string;
  resourceType: string;
  appliesTo: PlannedAction[];
  severity: Severity;
  message: string;
  source: RuleSource;
}

const REPLACE_OR_DELETE: PlannedAction[] = ["delete", "replace-delete-first", "replace-create-first"];

export const RULE_PACK: Rule[] = [
  {
    id: "aws-db-instance-loss",
    resourceType: "aws_db_instance",
    appliesTo: REPLACE_OR_DELETE,
    severity: "high",
    message:
      "Terraform plans to delete or replace this database instance. Confirm a recent backup or final snapshot exists before applying.",
    source: {
      provider: "hashicorp/aws",
      providerVersionTested: "5.94.0",
      url: "https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance",
    },
  },
  {
    id: "aws-rds-cluster-loss",
    resourceType: "aws_rds_cluster",
    appliesTo: REPLACE_OR_DELETE,
    severity: "high",
    message:
      "Terraform plans to delete or replace this RDS cluster. Confirm a recent backup or final snapshot exists before applying.",
    source: {
      provider: "hashicorp/aws",
      providerVersionTested: "5.94.0",
      url: "https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/rds_cluster",
    },
  },
  {
    id: "aws-s3-bucket-delete",
    resourceType: "aws_s3_bucket",
    // A replacement (e.g. changing `bucket` or `bucket_prefix`) deletes the
    // old bucket exactly as a plain delete does — this rule originally only
    // covered ["delete"], silently missing that case. Confirmed via a live
    // adversarial review of this repo and fixed here; see docs/decisions.md.
    appliesTo: REPLACE_OR_DELETE,
    severity: "high",
    message:
      "Terraform plans to delete or replace this S3 bucket. Bucket contents are not restorable through Terraform; confirm the bucket is empty or a lifecycle/replication policy covers it.",
    source: {
      provider: "hashicorp/aws",
      providerVersionTested: "5.94.0",
      url: "https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket",
    },
  },
  {
    id: "aws-ebs-volume-replace",
    resourceType: "aws_ebs_volume",
    appliesTo: REPLACE_OR_DELETE,
    severity: "high",
    message:
      "Terraform plans to delete or replace this EBS volume. Replacement destroys the existing volume; confirm a snapshot exists if the data matters.",
    source: {
      provider: "hashicorp/aws",
      providerVersionTested: "5.94.0",
      url: "https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ebs_volume",
    },
  },
  {
    id: "cloudflare-d1-database-delete",
    resourceType: "cloudflare_d1_database",
    appliesTo: REPLACE_OR_DELETE,
    severity: "high",
    message:
      "Terraform plans to delete or replace this D1 database. Confirm an exported backup exists; D1 database deletion through the API is not reversible.",
    source: {
      provider: "cloudflare/cloudflare",
      providerVersionTested: "5.9.0",
      url: "https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/d1_database",
    },
  },
  {
    id: "cloudflare-dns-record-delete",
    resourceType: "cloudflare_dns_record",
    appliesTo: ["delete"],
    severity: "notable",
    message:
      "Terraform plans to delete this DNS record. Confirm nothing external still depends on the current name resolving.",
    source: {
      provider: "cloudflare/cloudflare",
      providerVersionTested: "5.9.0",
      url: "https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/dns_record",
    },
  },
];

const RULES_BY_TYPE: Map<string, Rule[]> = new Map();
for (const rule of RULE_PACK) {
  const list = RULES_BY_TYPE.get(rule.resourceType) ?? [];
  list.push(rule);
  RULES_BY_TYPE.set(rule.resourceType, list);
}

export const RULE_COVERED_TYPES: ReadonlySet<string> = new Set(RULE_PACK.map((r) => r.resourceType));

export function evaluateRules(fact: ResourceChangeFact): RuleFinding[] {
  const candidates = RULES_BY_TYPE.get(fact.resourceType) ?? [];
  const findings: RuleFinding[] = [];
  for (const rule of candidates) {
    if (!rule.appliesTo.includes(fact.plannedAction)) continue;
    findings.push({
      ruleId: rule.id,
      resourceId: fact.id,
      severity: rule.severity,
      message: rule.message,
      evidence: fact.replacePaths.length > 0 ? fact.replacePaths : [{ path: "(root)", unknown: false }],
      source: rule.source,
    });
  }
  return findings;
}
