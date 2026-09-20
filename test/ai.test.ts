import { describe, expect, it } from "vitest";
import { analyzePlan } from "../src/core/analyze.js";
import { buildReviewContext } from "../src/ai/context.js";
import { verifyChatAnswer } from "../src/ai/verify.js";
import { askAboutReview, type WorkersAIBinding } from "../src/ai/chat.js";

function samplePlan() {
  return {
    format_version: "1.2",
    resource_changes: [
      {
        address: "aws_db_instance.main",
        mode: "managed",
        type: "aws_db_instance",
        name: "main",
        provider_name: "registry.terraform.io/hashicorp/aws",
        change: { actions: ["delete", "create"], before: {}, after: {}, replace_paths: [["instance_class"]] },
      },
    ],
  };
}

describe("buildReviewContext", () => {
  it("includes evidence ids and findings a model would need to answer grounded questions", () => {
    const result = analyzePlan(samplePlan());
    const { text, truncated } = buildReviewContext(result);
    expect(truncated).toBe(false);
    expect(text).toContain("aws_db_instance.main");
    expect(text).toContain("replace_paths: instance_class");
    expect(text).toContain("finding[high]");
  });
});

describe("verifyChatAnswer", () => {
  it("passes through an answer that only cites real resource ids", () => {
    const result = analyzePlan(samplePlan());
    const verified = verifyChatAnswer("aws_db_instance.main is being replaced due to instance_class.", result);
    expect(verified.citedUnknownIds).toEqual([]);
    expect(verified.note).toBeUndefined();
  });

  it("flags a hallucinated resource address not present in the plan", () => {
    const result = analyzePlan(samplePlan());
    const verified = verifyChatAnswer("aws_lambda_function.ghost will also be affected.", result);
    expect(verified.citedUnknownIds).toContain("aws_lambda_function.ghost");
    expect(verified.note).toContain("unverified");
  });

  it("does not flag terraform reference prefixes as resource addresses", () => {
    const result = analyzePlan(samplePlan());
    const verified = verifyChatAnswer("This depends on var.region and local.tags.", result);
    expect(verified.citedUnknownIds).toEqual([]);
  });
});

describe("askAboutReview", () => {
  it("returns a degraded, honest response when the model call fails, without touching findings", async () => {
    const result = analyzePlan(samplePlan());
    const failingAi: WorkersAIBinding = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const answer = await askAboutReview(failingAi, result, "why is this replaced?");
    expect(answer.text).toContain("unavailable");
    expect(result.findings).toHaveLength(1); // untouched
  });

  it("extracts text from a typical Workers AI {response} payload and verifies it", async () => {
    const result = analyzePlan(samplePlan());
    const mockAi: WorkersAIBinding = {
      run: async () => ({ response: "aws_db_instance.main is replaced because of instance_class." }),
    };
    const answer = await askAboutReview(mockAi, result, "why?");
    expect(answer.text).toContain("aws_db_instance.main");
    expect(answer.citedUnknownIds).toEqual([]);
  });
});
