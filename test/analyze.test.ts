import { describe, expect, it } from "vitest";
import { analyzePlan } from "../src/core/analyze.js";
import { PlanParseError } from "../src/core/parse.js";

// A compact but structurally realistic plan: an RDS instance being replaced
// (engine change, replace_paths present), referenced by a security group
// rule (which is not itself changed, so it won't appear in facts, but does
// let us exercise the "unresolved reference" and "no fact to attach" paths),
// and an EBS volume with a plain update.
function rdsReplacePlan() {
  return {
    format_version: "1.2",
    terraform_version: "1.9.0",
    resource_changes: [
      {
        address: "aws_db_instance.main",
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: {
          actions: ["delete", "create"],
          before: { engine: "postgres", identifier: "prod-db" },
          after: { engine: "postgres", identifier: "prod-db", instance_class: "db.r6g.large" },
          replace_paths: [["instance_class"]],
        },
      },
      {
        address: "aws_security_group_rule.db_ingress",
        mode: "managed",
        type: "aws_security_group_rule",
        name: "db_ingress",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["update"], before: {}, after: {} },
      },
    ],
    configuration: {
      root_module: {
        resources: [
          {
            address: "aws_db_instance.main",
            type: "aws_db_instance",
            expressions: {
              instance_class: { constant_value: "db.r6g.large" },
            },
          },
          {
            address: "aws_security_group_rule.db_ingress",
            type: "aws_security_group_rule",
            expressions: {
              security_group_id: { references: ["aws_db_instance.main.vpc_security_group_ids"] },
            },
          },
        ],
      },
    },
  };
}

describe("analyzePlan", () => {
  it("propagates a rejected parse as PlanParseError, not a silent empty result", () => {
    expect(() => analyzePlan({ not: "a plan" })).toThrow(PlanParseError);
  });

  it("flags a database replacement as high severity with a cited rule and source", () => {
    const result = analyzePlan(rdsReplacePlan());
    const dbFindings = result.findings.filter((f) => f.resourceId === "aws_db_instance.main");
    expect(dbFindings).toHaveLength(1);
    expect(dbFindings[0]!.severity).toBe("high");
    expect(dbFindings[0]!.source.url).toContain("db_instance");
  });

  it("marks coverage complete for a rule-covered resource", () => {
    const result = analyzePlan(rdsReplacePlan());
    const cov = result.coverage.find((c) => c.resourceId === "aws_db_instance.main");
    expect(cov?.status).toBe("complete");
  });

  it("marks coverage unsupported for a resource type with no rule", () => {
    const result = analyzePlan(rdsReplacePlan());
    const cov = result.coverage.find((c) => c.resourceId === "aws_security_group_rule.db_ingress");
    expect(cov?.status).toBe("unsupported");
  });

  it("resolves a reference edge from the security group rule to the db instance", () => {
    const result = analyzePlan(rdsReplacePlan());
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        fromId: "aws_security_group_rule.db_ingress",
        toId: "aws_db_instance.main",
      }),
    );
  });

  it("lists the security group rule as a direct dependent of the db instance", () => {
    const result = analyzePlan(rdsReplacePlan());
    const deps = result.dependents["aws_db_instance.main"] ?? [];
    expect(deps.some((d) => d.resourceId === "aws_security_group_rule.db_ingress" && d.relationship === "direct")).toBe(true);
  });

  it("never produces a finding for a resource with no matching rule/action", () => {
    const result = analyzePlan(rdsReplacePlan());
    expect(result.findings.every((f) => f.resourceId !== "aws_security_group_rule.db_ingress")).toBe(true);
  });
});
