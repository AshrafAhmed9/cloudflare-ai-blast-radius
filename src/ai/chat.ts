// Thin wrapper around the Workers AI binding for grounded chat. No
// structured-output requirement here — chat is prose, verified afterward by
// verify.ts, not schema-validated before use (facts/findings themselves are
// never touched by the model; see context.ts's system prompt, rule 5).

import { buildReviewContext, SYSTEM_PROMPT } from "./context.js";
import { verifyChatAnswer, type VerifiedAnswer } from "./verify.js";
import type { AnalysisResult } from "../core/types.js";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface WorkersAIBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function extractText(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object" && "response" in response) {
    const r = (response as { response: unknown }).response;
    if (typeof r === "string") return r;
  }
  return JSON.stringify(response);
}

export interface AskOptions {
  history?: ChatTurn[];
  maxHistoryTurns?: number;
}

export async function askAboutReview(
  ai: WorkersAIBinding,
  result: AnalysisResult,
  question: string,
  options: AskOptions = {},
): Promise<VerifiedAnswer> {
  const { text: context, truncated } = buildReviewContext(result);
  const history = (options.history ?? []).slice(-1 * (options.maxHistoryTurns ?? 6));

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `Review context:\n${context}${truncated ? "\n(context was truncated — say so if relevant)" : ""}` },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: question },
  ];

  let raw: unknown;
  try {
    raw = await ai.run(MODEL, { messages, stream: false, max_tokens: 512 });
  } catch (err) {
    return {
      text: "AI explanation unavailable right now (model request failed). The deterministic findings above are unaffected.",
      citedUnknownIds: [],
      note: `error: ${(err as Error).message}`,
    };
  }

  const text = extractText(raw);
  return verifyChatAnswer(text, result);
}

/** Used once per new review to produce the opening "here's what this plan does"
 *  message, so the chat isn't an empty box waiting for the first question. */
export async function summarizeReview(ai: WorkersAIBinding, result: AnalysisResult): Promise<VerifiedAnswer> {
  const highCount = result.findings.filter((f) => f.severity === "high").length;
  const notableCount = result.findings.filter((f) => f.severity === "notable").length;
  const prompt =
    highCount + notableCount === 0
      ? "Briefly summarize this plan in 2-3 sentences. No findings were raised by the rule pack — say that plainly, and mention how many resources have no coverage under the current rules if any."
      : `Briefly summarize this plan in 2-4 sentences, leading with the ${highCount} high-severity and ${notableCount} notable finding(s). Cite resource ids.`;
  return askAboutReview(ai, result, prompt);
}
