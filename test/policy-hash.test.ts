import { describe, expect, it } from "vitest";
import { proposalHash } from "../src/policies/hash.js";

const RULE = {
  resourceTypes: ["aws_db_instance"],
  actions: ["delete"],
  attributePredicate: null,
  severity: "high",
  summary: "x",
};

describe("proposalHash", () => {
  it("is deterministic for the same sentence and rule", async () => {
    const a = await proposalHash("flag db deletions", RULE);
    const b = await proposalHash("flag db deletions", RULE);
    expect(a).toBe(b);
  });

  it("changes when the sentence changes", async () => {
    const a = await proposalHash("flag db deletions", RULE);
    const b = await proposalHash("flag db replacements", RULE);
    expect(a).not.toBe(b);
  });

  it("changes when the rule changes, so an edited proposal cannot reuse an old approval", async () => {
    const a = await proposalHash("flag db deletions", RULE);
    const b = await proposalHash("flag db deletions", { ...RULE, severity: "notable" });
    expect(a).not.toBe(b);
  });

  it("produces a 64-character hex string (SHA-256)", async () => {
    const h = await proposalHash("x", RULE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
