import { describe, expect, it } from "vitest";
import { parsePlan, PlanParseError } from "../src/core/parse.js";

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    format_version: "1.2",
    terraform_version: "1.9.0",
    resource_changes: [],
    ...overrides,
  };
}

describe("parsePlan", () => {
  it("rejects non-plan input rather than guessing", () => {
    expect(() => parsePlan({ hello: "world" })).toThrow(PlanParseError);
  });

  it("rejects an unsupported format major version", () => {
    expect(() => parsePlan(basePlan({ format_version: "2.0" }))).toThrow(/format_version/);
  });

  it("classifies a plain create", () => {
    const plan = parsePlan(
      basePlan({
        resource_changes: [
          {
            address: "aws_s3_bucket.logs",
            mode: "managed",
            type: "aws_s3_bucket",
            name: "logs",
            provider_name: "registry.terraform.io/hashicorp/aws",
            change: { actions: ["create"], before: null, after: {} },
          },
        ],
      }),
    );
    expect(plan.facts).toHaveLength(1);
    expect(plan.facts[0]!.plannedAction).toBe("create");
  });

  it("classifies delete-then-create as replace-delete-first and preserves replace_paths", () => {
    const plan = parsePlan(
      basePlan({
        resource_changes: [
          {
            address: "aws_db_instance.main",
            mode: "managed",
            type: "aws_db_instance",
            name: "main",
            provider_name: "registry.terraform.io/hashicorp/aws",
            change: {
              actions: ["delete", "create"],
              before: { engine: "postgres" },
              after: { engine: "mysql" },
              replace_paths: [["engine"]],
            },
          },
        ],
      }),
    );
    const fact = plan.facts[0]!;
    expect(fact.plannedAction).toBe("replace-delete-first");
    expect(fact.replacementCauseAvailable).toBe(true);
    expect(fact.replacePaths.map((p) => p.path)).toEqual(["engine"]);
  });

  it("marks a replacement with no replace_paths and no action_reason as cause-unavailable, not safe", () => {
    const plan = parsePlan(
      basePlan({
        resource_changes: [
          {
            address: "null_resource.tainted",
            mode: "managed",
            type: "null_resource",
            name: "tainted",
            provider_name: "registry.terraform.io/hashicorp/null",
            change: { actions: ["delete", "create"], before: {}, after: {} },
          },
        ],
      }),
    );
    expect(plan.facts[0]!.replacementCauseAvailable).toBe(false);
  });

  it("flags an unrecognized action sequence as unsupported, never as safe", () => {
    const plan = parsePlan(
      basePlan({
        resource_changes: [
          {
            address: "weird.thing",
            mode: "managed",
            type: "weird_type",
            name: "thing",
            provider_name: "registry.terraform.io/example/weird",
            change: { actions: ["move"], before: null, after: {} },
          },
        ],
      }),
    );
    expect(plan.facts[0]!.plannedAction).toBe("unsupported");
    expect(plan.warnings.some((w) => w.includes("weird.thing"))).toBe(true);
  });

  it("collects unknown leaf paths from after_unknown without flattening unrelated known values", () => {
    const plan = parsePlan(
      basePlan({
        resource_changes: [
          {
            address: "aws_instance.web",
            mode: "managed",
            type: "aws_instance",
            name: "web",
            provider_name: "registry.terraform.io/hashicorp/aws",
            change: {
              actions: ["create"],
              before: null,
              after: { ami: "ami-123", id: null },
              after_unknown: { ami: false, id: true, tags: { Name: false } },
            },
          },
        ],
      }),
    );
    expect(plan.facts[0]!.unknownPaths).toEqual(["id"]);
  });

  it("distinguishes deposed instances by id", () => {
    const plan = parsePlan(
      basePlan({
        resource_changes: [
          {
            address: "aws_instance.web",
            mode: "managed",
            type: "aws_instance",
            name: "web",
            provider_name: "registry.terraform.io/hashicorp/aws",
            deposed: "abcd1234",
            change: { actions: ["delete"], before: {}, after: null },
          },
        ],
      }),
    );
    expect(plan.facts[0]!.id).toBe("aws_instance.web#deposed:abcd1234");
  });
});
