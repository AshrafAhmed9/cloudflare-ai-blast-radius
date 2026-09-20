// Binds a confirmation to the exact (sentence, rule) pair it previewed, per
// PLAN.md §6: "Bind confirmation to proposal ID/hash and policy revision, so
// an edited proposal cannot reuse earlier approval." Uses Web Crypto
// (available in both Workers and Node >=19), not Node's `crypto` module, so
// this file works unmodified in the Worker runtime.

export async function proposalHash(sentence: string, rule: unknown): Promise<string> {
  // `rule` must already be the zod-parsed output (see compile.ts / types.ts)
  // so key order is canonical regardless of how the client serialized it.
  const payload = JSON.stringify({ sentence, rule });
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
