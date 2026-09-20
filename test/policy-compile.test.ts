import { describe, expect, it } from "vitest";
import { compilePolicy } from "../src/policies/compile.js";
import type { WorkersAIBinding } from "../src/ai/chat.js";

function mockAi(responses: string[]): WorkersAIBinding {
  let i = 0;
  return {
    run: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return { response: r };
    },
  };
}

describe("compilePolicy", () => {
  it("compiles a well-formed model response into a validated rule", async () => {
    const ai = mockAi([
      JSON.stringify({
        resourceTypes: ["aws_db_instance"],
        actions: ["delete", "replace-delete-first", "replace-create-first"],
        attributePredicate: null,
        severity: "high",
        summary: "Flag any database instance deletion or replacement.",
      }),
    ]);
    const result = await compilePolicy(ai, "Flag deletion or replacement of database instances.");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.resourceTypes).toEqual(["aws_db_instance"]);
  });

  it("passes through an explicit model refusal", async () => {
    const ai = mockAi([JSON.stringify({ refused: true, reason: "Backup recoverability cannot be determined from a plan." })]);
    const result = await compilePolicy(ai, "Ensure backups are recoverable.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("recoverab");
  });

  it("rejects a resourceType outside the allowlist even if the model invents one", async () => {
    const ai = mockAi([
      JSON.stringify({
        resourceTypes: ["aws_lambda_function"], // not in POLICY_RESOURCE_TYPES
        actions: ["delete"],
        attributePredicate: null,
        severity: "high",
        summary: "x",
      }),
      JSON.stringify({
        resourceTypes: ["aws_lambda_function"],
        actions: ["delete"],
        attributePredicate: null,
        severity: "high",
        summary: "x",
      }),
    ]);
    const result = await compilePolicy(ai, "Flag lambda deletions.");
    expect(result.ok).toBe(false); // fails validation twice, refuses after the bounded retry
  });

  it("retries once on malformed JSON and succeeds on the second attempt", async () => {
    const ai = mockAi([
      "not json at all",
      JSON.stringify({
        resourceTypes: ["*"],
        actions: ["delete"],
        attributePredicate: null,
        severity: "notable",
        summary: "Flag any deletion.",
      }),
    ]);
    const result = await compilePolicy(ai, "Flag any deletion.");
    expect(result.ok).toBe(true);
  });

  it("refuses after malformed output on both attempts", async () => {
    const ai = mockAi(["garbage", "still garbage"]);
    const result = await compilePolicy(ai, "Do something vague.");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty sentence without calling the model", async () => {
    let called = false;
    const ai: WorkersAIBinding = { run: async () => { called = true; return {}; } };
    const result = await compilePolicy(ai, "   ");
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("strips markdown code fences from the model response", async () => {
    const ai = mockAi([
      "```json\n" +
        JSON.stringify({
          resourceTypes: ["cloudflare_dns_record"],
          actions: ["delete"],
          attributePredicate: null,
          severity: "notable",
          summary: "x",
        }) +
        "\n```",
    ]);
    const result = await compilePolicy(ai, "Flag DNS record deletions.");
    expect(result.ok).toBe(true);
  });
});
