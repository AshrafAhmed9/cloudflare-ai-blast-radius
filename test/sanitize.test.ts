import { describe, expect, it } from "vitest";
import { redactValue, sanitizeFact } from "../src/core/sanitize.js";
import type { ResourceChangeFact } from "../src/core/types.js";

describe("redactValue", () => {
  it("redacts a top-level leaf path", () => {
    const value = { password: "hunter2", username: "alice" };
    const out = redactValue(value, ["password"]) as Record<string, unknown>;
    expect(out.password).toBe("«redacted»");
    expect(out.username).toBe("alice");
  });

  it("redacts a nested path and preserves siblings", () => {
    const value = { db: { credentials: { secret: "s3cr3t" }, name: "prod" } };
    const out = redactValue(value, ["db.credentials.secret"]) as any;
    expect(out.db.credentials.secret).toBe("«redacted»");
    expect(out.db.name).toBe("prod");
  });

  it("redacts an array element by index", () => {
    const value = { tags: [{ value: "public" }, { value: "internal-secret" }] };
    const out = redactValue(value, ["tags[1].value"]) as any;
    expect(out.tags[0].value).toBe("public");
    expect(out.tags[1].value).toBe("«redacted»");
  });

  it("does not mutate the original input", () => {
    const value = { secret: "abc" };
    redactValue(value, ["secret"]);
    expect(value.secret).toBe("abc");
  });

  it("is a no-op when the path does not exist", () => {
    const value = { a: 1 };
    const out = redactValue(value, ["nonexistent.path"]);
    expect(out).toEqual({ a: 1 });
  });
});

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
