import { describe, expect, it } from "vitest";
import { evaluatePolicy, evaluatePolicyAgainstFacts } from "../src/policies/interpret.js";
import type { PolicyRule } from "../src/policies/types.js";
import type { ResourceChangeFact } from "../src/core/types.js";

function fact(overrides: Partial<ResourceChangeFact>): ResourceChangeFact {
  return {
    id: "x.y",
    address: "x.y",
    resourceType: "aws_db_instance",
    providerName: "registry.terraform.io/hashicorp/aws",
    mode: "managed",
    actions: ["delete", "create"],
    plannedAction: "replace-delete-first",
    replacePaths: [],
    replacementCauseAvailable: false,
    unknownPaths: [],
    sensitivePaths: [],
    ...overrides,
  };
}

function rule(overrides: Partial<PolicyRule>): PolicyRule {
  return {
    resourceTypes: ["aws_db_instance"],
    actions: ["replace-delete-first", "replace-create-first", "delete"],
    attributePredicate: null,
    severity: "high",
    summary: "test rule",
    ...overrides,
  };
}

describe("evaluatePolicy — type/action gating", () => {
  it("does not match a resource type outside the rule's list", () => {
    const r = rule({ resourceTypes: ["aws_s3_bucket"] });
    expect(evaluatePolicy(r, fact({}))).toBe("no-match");
  });

  it("matches '*' resourceTypes for any type", () => {
    const r = rule({ resourceTypes: ["*"] });
    expect(evaluatePolicy(r, fact({ resourceType: "cloudflare_dns_record" }))).toBe("match");
  });

  it("does not match an action outside the rule's list", () => {
    const r = rule({ actions: ["update"] });
    expect(evaluatePolicy(r, fact({ plannedAction: "replace-delete-first" }))).toBe("no-match");
  });

  it("matches when type and action both match and there is no predicate", () => {
    expect(evaluatePolicy(rule({}), fact({}))).toBe("match");
  });
});

describe("evaluatePolicy — replace_path_includes predicate (three-valued)", () => {
  it("matches when the predicate value is present in replace_paths", () => {
    const r = rule({ attributePredicate: { kind: "replace_path_includes", value: "instance_class" } });
    const f = fact({ replacePaths: [{ path: "instance_class", unknown: false }], replacementCauseAvailable: true });
    expect(evaluatePolicy(r, f)).toBe("match");
  });

  it("does not match when replace_paths are known but don't include the value", () => {
    const r = rule({ attributePredicate: { kind: "replace_path_includes", value: "instance_class" } });
    const f = fact({ replacePaths: [{ path: "engine", unknown: false }], replacementCauseAvailable: true });
    expect(evaluatePolicy(r, f)).toBe("no-match");
  });

  it("is UNKNOWN — not no-match — when the replacement cause is unavailable", () => {
    const r = rule({ attributePredicate: { kind: "replace_path_includes", value: "instance_class" } });
    const f = fact({ replacePaths: [], replacementCauseAvailable: false });
    expect(evaluatePolicy(r, f)).toBe("unknown");
  });

  it("does not treat a non-replacement action with empty replace_paths as unknown", () => {
    const r = rule({ actions: ["delete"], attributePredicate: { kind: "replace_path_includes", value: "x" } });
    const f = fact({ plannedAction: "delete", actions: ["delete"], replacePaths: [], replacementCauseAvailable: false });
    expect(evaluatePolicy(r, f)).toBe("no-match");
  });
});

describe("evaluatePolicy — path predicate is exact-segment, not substring (R6)", () => {
  it("does not match 'id' against a path merely containing it, like 'identifier'", () => {
    const r = rule({ attributePredicate: { kind: "replace_path_includes", value: "id" } });
    const f = fact({ replacePaths: [{ path: "identifier", unknown: false }], replacementCauseAvailable: true });
    expect(evaluatePolicy(r, f)).toBe("no-match");
  });

  it("does not match 'engine' against 'engine_version'", () => {
    const r = rule({ attributePredicate: { kind: "replace_path_includes", value: "engine" } });
    const f = fact({ replacePaths: [{ path: "engine_version", unknown: false }], replacementCauseAvailable: true });
    expect(evaluatePolicy(r, f)).toBe("no-match");
  });

  it("still matches a whole leaf segment inside a nested/indexed path", () => {
    const r = rule({ attributePredicate: { kind: "replace_path_includes", value: "value" } });
    const f = fact({ replacePaths: [{ path: "tags[0].value", unknown: false }], replacementCauseAvailable: true });
    expect(evaluatePolicy(r, f)).toBe("match");
  });
});

describe("evaluatePolicy — unknown_path_includes predicate", () => {
  it("matches when the value appears in unknownPaths", () => {
    const r = rule({ attributePredicate: { kind: "unknown_path_includes", value: "id" } });
    expect(evaluatePolicy(r, fact({ unknownPaths: ["id"] }))).toBe("match");
  });

  it("does not match when unknownPaths doesn't contain the value", () => {
    const r = rule({ attributePredicate: { kind: "unknown_path_includes", value: "id" } });
    expect(evaluatePolicy(r, fact({ unknownPaths: ["private_ip"] }))).toBe("no-match");
  });
});

describe("evaluatePolicyAgainstFacts", () => {
  it("filters out no-match results but keeps match and unknown", () => {
    const r = rule({});
    const facts = [
      fact({ id: "a", resourceType: "aws_db_instance" }),
      fact({ id: "b", resourceType: "aws_s3_bucket" }), // no-match: wrong type
    ];
    const results = evaluatePolicyAgainstFacts(r, facts);
    expect(results).toEqual([{ resourceId: "a", result: "match" }]);
  });
});
