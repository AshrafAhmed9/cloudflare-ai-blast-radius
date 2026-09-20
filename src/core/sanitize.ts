// ResourceChangeFact (types.ts) never carries a resource's raw before/after
// values in the first place — parse.ts extracts only address, type, action,
// and evidence *paths* (e.g. "instance_class"), never the values at those
// paths. So the model, storage, and UI never receive sensitive values by
// construction, not because something strips them out afterward. This
// module's job is narrower than "redaction": deep-clone every fact so no
// caller holds a live reference back into the parsed plan, which matters
// because a fact could otherwise be mutated after the fact by an unrelated
// code path (e.g. the AI context builder attaching debug fields) and that
// mutation would leak into the original plan object.
//
// R6 (adversarial review): this file used to also export `redactValue`, a
// path-based masking function. It was unused in production — nothing ever
// attached raw values to a fact for it to mask — and its existence implied
// an active-redaction step that wasn't real. Removed rather than kept as
// dead code implying a guarantee this codebase doesn't provide.

import type { ResourceChangeFact } from "./types.js";

/** Deep-clones a fact so no caller holds a live reference into the parsed
 *  plan. Facts carry no raw resource values by construction (see above),
 *  so there is nothing to strip here — this is isolation, not redaction. */
export function sanitizeFact(fact: ResourceChangeFact): ResourceChangeFact {
  return structuredClone(fact);
}

export function sanitizeFacts(facts: readonly ResourceChangeFact[]): ResourceChangeFact[] {
  return facts.map(sanitizeFact);
}
