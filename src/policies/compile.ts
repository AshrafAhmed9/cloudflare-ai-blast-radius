// Compiles one English sentence into a PolicyRule via Workers AI, validated
// against the fixed schema in types.ts. Never returns unvalidated model
// output — either a validated rule, or an explicit refusal with a reason.
// See PLAN.md §6: "A successful dry-run proves execution, not that the
// compiler understood the sentence" — this module only produces the rule;
// interpret.ts's dry run against real facts is what earns trust, in agent.ts.

import { PolicyRuleSchema, POLICY_ACTIONS, POLICY_RESOURCE_TYPES, type PolicyRule } from "./types.js";
import type { WorkersAIBinding } from "../ai/chat.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You compile one English sentence describing a Terraform review policy into a strict JSON object.

Schema:
{
  "resourceTypes": string[] — 1-10 values, ONLY from this exact list: ${POLICY_RESOURCE_TYPES.join(", ")}
  "actions": string[] — 1-6 values, ONLY from this exact list: ${POLICY_ACTIONS.join(", ")}
  "attributePredicate": null OR { "kind": "replace_path_includes" | "unknown_path_includes", "value": string }
  "severity": "info" | "notable" | "high"
  "summary": a short restatement of the rule, max 300 chars
}

Rules:
- Use "*" in resourceTypes only when the sentence is genuinely about any resource type, not as a default when unsure.
- If the sentence cannot be expressed with this schema (it asks about something not covered — e.g. "ensure backups are recoverable", "make everything safe", or names a resource type/attribute not in the allowed lists), respond with exactly: {"refused": true, "reason": "<short reason>"}
- Never invent a resourceType or attribute value outside what the sentence actually says.
- Output ONLY the JSON object. No prose, no markdown fences.`;

export type CompileResult = { ok: true; rule: PolicyRule } | { ok: false; reason: string };

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(trimmed);
}

/** Calls the model. Throws only on a genuine call failure (network, binding
 *  error) — never for malformed output, which the caller must treat as
 *  retryable, not fatal. */
async function callModel(ai: WorkersAIBinding, sentence: string): Promise<string> {
  const raw = await ai.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: sentence },
    ],
    stream: false,
    max_tokens: 400,
  });
  return typeof raw === "string" ? raw : (raw as { response?: string })?.response ?? "";
}

export async function compilePolicy(ai: WorkersAIBinding, sentence: string): Promise<CompileResult> {
  const trimmed = sentence.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return { ok: false, reason: "Policy sentence must be 1-500 characters." };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await callModel(ai, trimmed);
    } catch (err) {
      return { ok: false, reason: `Model request failed: ${(err as Error).message}` };
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      continue; // malformed JSON is retryable, not fatal — try again (bounded to 2 attempts)
    }

    if (parsed && typeof parsed === "object" && (parsed as { refused?: boolean }).refused === true) {
      const reason = (parsed as { reason?: string }).reason ?? "Not supported by the current policy schema.";
      return { ok: false, reason };
    }

    const result = PolicyRuleSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, rule: result.data };
    }
    // one bounded retry on malformed output, per PLAN.md §6
  }

  return { ok: false, reason: "Could not compile this sentence into a valid policy after one retry. Try a narrower, more specific rule." };
}
