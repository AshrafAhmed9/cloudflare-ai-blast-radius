import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/core/graph.js";
import type { ResourceChangeFact } from "../src/core/types.js";

function fact(overrides: Partial<ResourceChangeFact>): ResourceChangeFact {
  return {
    id: overrides.address ?? "x.y",
    address: "x.y",
    resourceType: "aws_instance",
    providerName: "registry.terraform.io/hashicorp/aws",
    mode: "managed",
    actions: ["update"],
    plannedAction: "update",
    replacePaths: [],
    replacementCauseAvailable: false,
    unknownPaths: [],
    sensitivePaths: [],
    ...overrides,
  };
}

describe("buildGraph", () => {
  it("reports count/for_each resources as unresolved rather than joining by prefix", () => {
    const facts = [fact({ id: "aws_instance.web[0]", address: "aws_instance.web[0]" })];
    const configuration = {
      root_module: {
        resources: [{ address: "aws_instance.web", count_expression: {}, expressions: {} }],
      },
    };
    const result = buildGraph(configuration, facts);
    expect(result.edges).toHaveLength(0);
    expect(result.unresolvedReferences.some((u) => u.reason.includes("count or for_each"))).toBe(true);
  });

  it("does not resolve a reference to a count/for_each target", () => {
    const facts = [
      fact({ id: "aws_security_group_rule.rule", address: "aws_security_group_rule.rule" }),
      fact({ id: "aws_instance.web[0]", address: "aws_instance.web[0]" }),
    ];
    const configuration = {
      root_module: {
        resources: [
          {
            address: "aws_security_group_rule.rule",
            expressions: { security_group_id: { references: ["aws_instance.web.id"] } },
          },
          { address: "aws_instance.web", count_expression: {} },
        ],
      },
    };
    const result = buildGraph(configuration, facts);
    expect(result.edges).toHaveLength(0);
    expect(result.unresolvedReferences.some((u) => u.reason.includes("cannot resolve to a specific instance"))).toBe(true);
  });

  it("reports a reference to an unchanged/untracked resource as unresolved, not dropped silently", () => {
    const facts = [fact({ id: "aws_security_group_rule.rule", address: "aws_security_group_rule.rule" })];
    const configuration = {
      root_module: {
        resources: [
          {
            address: "aws_security_group_rule.rule",
            expressions: { security_group_id: { references: ["aws_vpc.main.id"] } },
          },
        ],
      },
    };
    const result = buildGraph(configuration, facts);
    expect(result.edges).toHaveLength(0);
    expect(result.unresolvedReferences).toHaveLength(1);
    expect(result.unresolvedReferences[0]!.viaPath).toBe("aws_vpc.main.id");
  });

  it("ignores var./local./data. references — they are not resource edges", () => {
    const facts = [fact({ id: "aws_instance.web", address: "aws_instance.web" })];
    const configuration = {
      root_module: {
        resources: [
          {
            address: "aws_instance.web",
            expressions: { ami: { references: ["var.ami_id", "local.common_tags"] } },
          },
        ],
      },
    };
    const result = buildGraph(configuration, facts);
    expect(result.edges).toHaveLength(0);
    expect(result.unresolvedReferences).toHaveLength(0);
  });

  it("finds a transitive dependent two hops away", () => {
    const facts = [
      fact({ id: "aws_vpc.main", address: "aws_vpc.main" }),
      fact({ id: "aws_subnet.a", address: "aws_subnet.a" }),
      fact({ id: "aws_instance.web", address: "aws_instance.web" }),
    ];
    const configuration = {
      root_module: {
        resources: [
          { address: "aws_vpc.main", expressions: {} },
          { address: "aws_subnet.a", expressions: { vpc_id: { references: ["aws_vpc.main.id"] } } },
          { address: "aws_instance.web", expressions: { subnet_id: { references: ["aws_subnet.a.id"] } } },
        ],
      },
    };
    const result = buildGraph(configuration, facts);
    const deps = result.dependents["aws_vpc.main"] ?? [];
    expect(deps.find((d) => d.resourceId === "aws_subnet.a")?.relationship).toBe("direct");
    expect(deps.find((d) => d.resourceId === "aws_instance.web")?.relationship).toBe("transitive");
  });

  it("returns no edges or dependents when configuration is absent", () => {
    const result = buildGraph(undefined, [fact({ id: "a.b", address: "a.b" })]);
    expect(result.edges).toHaveLength(0);
    expect(Object.keys(result.dependents)).toHaveLength(0);
  });
});
