import { describe, expect, it } from "vitest";
import { evaluateRules } from "../src/core/rules.js";
import type { ResourceChangeFact } from "../src/core/types.js";

function fact(overrides: Partial<ResourceChangeFact>): ResourceChangeFact {
  return {
    id: "x.y",
    address: "x.y",
    resourceType: "aws_s3_bucket",
    providerName: "registry.terraform.io/hashicorp/aws",
    mode: "managed",
    actions: ["delete"],
    plannedAction: "delete",
    replacePaths: [],
    replacementCauseAvailable: false,
    unknownPaths: [],
    sensitivePaths: [],
    ...overrides,
  };
}

describe("evaluateRules — aws_s3_bucket", () => {
  // Regression: an earlier version only matched plannedAction "delete",
  // silently producing zero findings for a replacement — which also
  // deletes the old bucket. Found via adversarial review, fixed in
  // src/core/rules.ts; see docs/decisions.md.
  it("fires on a plain delete", () => {
    const findings = evaluateRules(fact({ plannedAction: "delete" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("high");
  });

  it("fires on replace-delete-first (not just plain delete)", () => {
    const findings = evaluateRules(fact({ plannedAction: "replace-delete-first", actions: ["delete", "create"] }));
    expect(findings).toHaveLength(1);
  });

  it("fires on replace-create-first (not just plain delete)", () => {
    const findings = evaluateRules(fact({ plannedAction: "replace-create-first", actions: ["create", "delete"] }));
    expect(findings).toHaveLength(1);
  });

  it("does not fire on a plain update", () => {
    const findings = evaluateRules(fact({ plannedAction: "update", actions: ["update"] }));
    expect(findings).toHaveLength(0);
  });

  it("does not fire on create", () => {
    const findings = evaluateRules(fact({ plannedAction: "create", actions: ["create"] }));
    expect(findings).toHaveLength(0);
  });
});

describe("evaluateRules — every rule fires on both replace orders", () => {
  const statefulTypes = ["aws_db_instance", "aws_rds_cluster", "aws_ebs_volume", "cloudflare_d1_database"];

  for (const resourceType of statefulTypes) {
    it(`${resourceType}: fires on replace-delete-first and replace-create-first`, () => {
      const a = evaluateRules(fact({ resourceType, plannedAction: "replace-delete-first", actions: ["delete", "create"] }));
      const b = evaluateRules(fact({ resourceType, plannedAction: "replace-create-first", actions: ["create", "delete"] }));
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
    });
  }
});

describe("evaluateRules — cloudflare_dns_record", () => {
  it("fires on delete at notable severity", () => {
    const findings = evaluateRules(fact({ resourceType: "cloudflare_dns_record", plannedAction: "delete" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("notable");
  });

  it("does not fire on update", () => {
    const findings = evaluateRules(fact({ resourceType: "cloudflare_dns_record", plannedAction: "update", actions: ["update"] }));
    expect(findings).toHaveLength(0);
  });
});

describe("evaluateRules — unknown resource type", () => {
  it("produces no findings (coverage handled separately in analyze.ts)", () => {
    const findings = evaluateRules(fact({ resourceType: "aws_lambda_function", plannedAction: "delete" }));
    expect(findings).toHaveLength(0);
  });
});
