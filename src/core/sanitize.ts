// Recursively masks values at sensitivePaths before a fact is ever sent to
// the model, persisted, logged, or rendered as a UI preview. Applied to a
// deep-cloned copy — callers never get a reference back into the original
// parsed plan.
//
// Sensitivity flags from Terraform (before_sensitive/after_sensitive) are
// not a complete secret detector — they only mark what the provider schema
// declares sensitive. See docs/decisions.md.

import type { ResourceChangeFact } from "./types.js";

const REDACTED = "«redacted»";

function splitPath(path: string): (string | number)[] {
  // Matches the format produced by parse.ts's pathToString: "a.b[0].c"
  const segments: (string | number)[] = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] !== undefined) segments.push(Number(m[2]));
  }
  return segments;
}

function redactAt(node: unknown, segments: (string | number)[]): unknown {
  if (segments.length === 0) return REDACTED;
  if (node === null || node === undefined || typeof node !== "object") return node;
  const [head, ...rest] = segments;
  if (Array.isArray(node)) {
    if (typeof head !== "number") return node;
    const copy = node.slice();
    if (head in copy) {
      copy[head] = rest.length === 0 ? REDACTED : redactAt(copy[head], rest);
    }
    return copy;
  }
  const obj = { ...(node as Record<string, unknown>) };
  const key = String(head);
  if (key in obj) {
    obj[key] = rest.length === 0 ? REDACTED : redactAt(obj[key], rest);
  }
  return obj;
}

/** Returns a deep-cloned fact with every declared-sensitive leaf replaced by
 *  a fixed redaction marker. Facts have no `before`/`after` payload of their
 *  own (see types.ts) — this exists for callers that attach raw resource
 *  values (e.g. the AI context builder) and must redact them the same way. */
export function redactValue(value: unknown, sensitivePaths: readonly string[]): unknown {
  let out = structuredClone(value);
  for (const p of sensitivePaths) {
    out = redactAt(out, splitPath(p));
  }
  return out;
}

/** Facts themselves carry no raw values (see ResourceChangeFact), so nothing
 *  to redact structurally — but we still strip anything an upstream caller
 *  might have bolted onto the object at runtime, defensively. */
export function sanitizeFact(fact: ResourceChangeFact): ResourceChangeFact {
  const clone = structuredClone(fact);
  return clone;
}

export function sanitizeFacts(facts: readonly ResourceChangeFact[]): ResourceChangeFact[] {
  return facts.map(sanitizeFact);
}
