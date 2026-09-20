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
- Output ONLY the JSON object. No prose, no markdown fences, no code block.
- The output MUST be strict JSON: double-quoted keys, double-quoted string values, no trailing commas, no comments. This is not a JavaScript object literal.

Example output for "Flag any S3 bucket deletion":
{"resourceTypes":["aws_s3_bucket"],"actions":["delete"],"attributePredicate":null,"severity":"high","summary":"Flag any S3 bucket deletion"}`;

export type CompileResult = { ok: true; rule: PolicyRule } | { ok: false; reason: string };

/** Best-effort repair for a JS-object-literal string into valid JSON:
 *  unquoted keys and single-quoted string values. Observed live from the
 *  model despite the prompt explicitly requiring strict JSON (see
 *  docs/decisions.md) — bounded to this fixed schema's shape, not a general
 *  JSON5 parser, so it's safe to apply blindly: quote bare identifier keys,
 *  and turn 'single quoted' values into "double quoted" ones. Values that
 *  are already valid JSON (numbers, true/false/null, double-quoted
 *  strings, arrays, nested objects) pass through untouched.
 *  A value containing an apostrophe (e.g. a summary like "don't") would
 *  break this — that's the tradeoff of not writing a full parser here;
 *  strict JSON.parse is always tried first, so this only ever activates as
 *  a fallback for the object-literal case actually observed. */
function repairObjectLiteral(text: string): string {
  return text
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":') // bare keys -> quoted keys
    .replace(/'([^'\\]*)'/g, '"$1"'); // 'value' -> "value" (no embedded quotes/escapes)
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch (strictError) {
    try {
      return JSON.parse(repairObjectLiteral(trimmed));
    } catch {
      throw strictError; // report the original strict-JSON error, not the repair attempt's
    }
  }
}

/** Calls the model and returns either the raw completion text (the normal
 *  case) or an already-parsed object, tagged so the caller knows which.
 *  Throws only on a genuine call failure (network, binding error) — never
 *  for malformed output, which the caller must treat as retryable, not
 *  fatal.
 *
 *  Observed live: when the completion is valid JSON, Workers AI returns it
 *  PRE-PARSED as an object in `raw.response` (not the JSON string) —
 *  confirmed via `wrangler tail` against the real API, not documented
 *  behavior found in the docs. Handling only the string case (what the
 *  docs example shows) silently dropped every well-formed response. */
async function callModel(ai: WorkersAIBinding, sentence: string): Promise<{ text: string } | { parsed: unknown }> {
  const raw = await ai.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: sentence },
    ],
    stream: false,
    max_tokens: 400,
  });
  if (typeof raw === "string") return { text: raw };
  const response = (raw as { response?: unknown } | null | undefined)?.response;
  if (typeof response === "string") return { text: response };
  if (response && typeof response === "object") return { parsed: response };
  return { text: "" };
}

export async function compilePolicy(ai: WorkersAIBinding, sentence: string): Promise<CompileResult> {
  const trimmed = sentence.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return { ok: false, reason: "Policy sentence must be 1-500 characters." };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let modelResult: { text: string } | { parsed: unknown };
    try {
      modelResult = await callModel(ai, trimmed);
    } catch (err) {
      return { ok: false, reason: `Model request failed: ${(err as Error).message}` };
    }

    let parsed: unknown;
    if ("parsed" in modelResult) {
      parsed = modelResult.parsed; // already an object (see callModel's doc comment) — nothing to JSON.parse
    } else {
      try {
        parsed = extractJson(modelResult.text);
      } catch {
        continue; // malformed JSON is retryable, not fatal — try again (bounded to 2 attempts)
      }
    }

    if (parsed && typeof parsed === "object" && (parsed as { refused?: boolean }).refused === true) {
      const reason = (parsed as { reason?: string }).reason ?? "Not supported by the current policy schema.";
      return { ok: false, reason };
    }

    const result = PolicyRuleSchema.safeParse(parsed);
    if (result.success) {
      return { ok: true, rule: result.data };
    }
    // Genuine production diagnostic (observability.enabled — see wrangler.jsonc),
    // not test noise: this only fires when the model's output fails schema
    // validation, which is exactly the case worth being able to see in
    // `wrangler tail` if it starts happening often.
    console.warn("[policy-compile] model output failed schema validation, attempt", attempt, JSON.stringify(result.error.issues));
    // one bounded retry on malformed output, per PLAN.md §6
  }

  return { ok: false, reason: "Could not compile this sentence into a valid policy after one retry. Try a narrower, more specific rule." };
}
