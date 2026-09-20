import { describe, expect, it } from "vitest";
import { sanitizeFact } from "../src/core/sanitize.js";
import type { ResourceChangeFact } from "../src/core/types.js";

describe("sanitizeFact", () => {
  it("returns a deep clone, not a reference to the original fact", () => {
    const fact: ResourceChangeFact = {
      id: "aws_instance.web",
      address: "aws_instance.web",
      resourceType: "aws_instance",
      providerName: "registry.terraform.io/hashicorp/aws",
      mode: "managed",
      actions: ["create"],
      plannedAction: "create",
      replacePaths: [],
      replacementCauseAvailable: false,
      unknownPaths: [],
      sensitivePaths: [],
    };
    const clone = sanitizeFact(fact);
    expect(clone).toEqual(fact);
    expect(clone).not.toBe(fact);
    clone.address = "mutated";
    expect(fact.address).toBe("aws_instance.web");
  });
});
