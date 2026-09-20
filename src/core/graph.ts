// Builds a deterministic *partial reference graph* from the plan's
// `configuration` block — not an outage graph. We resolve a supported
// subset of Terraform's reference syntax and report everything else as
// unresolved, rather than guessing or joining instances by string prefix.
//
// Supported: root-module resources with no `count`/`for_each` (single
// instance, address == configuration address), referencing other
// root-module resources under the same constraint.
//
// Not supported (reported as unresolved, not silently dropped): nested
// modules, count/for_each instances, `for_each`/`count.index` expressions,
// module outputs/variables/locals as intermediate hops.
//
// Reference: https://developer.hashicorp.com/terraform/internals/json-format
// (the `configuration.root_module.resources[].expressions` block).

import type { DependentResult, ReferenceEdge, ResourceChangeFact, UnresolvedReference } from "./types.js";

interface ConfigResource {
  address: string;
  mode?: string;
  type?: string;
  name?: string;
  expressions?: Record<string, unknown>;
  count_expression?: unknown;
  for_each_expression?: unknown;
}

interface ConfigRootModule {
  resources?: ConfigResource[];
  module_calls?: Record<string, unknown>;
}

interface ConfigurationBlock {
  root_module?: ConfigRootModule;
}

const REFERENCE_PREFIX_TYPES = ["var.", "local.", "data.", "each.", "count.", "module.", "path.", "terraform."];

/** Reference strings look like "aws_vpc.main" or "aws_vpc.main.id". We only
 *  want the resource address (first two dot segments for a managed
 *  resource), and only when it isn't one of the non-resource prefixes. */
function extractResourceAddress(ref: string): string | null {
  for (const p of REFERENCE_PREFIX_TYPES) {
    if (ref.startsWith(p)) return null;
  }
  const parts = ref.split(".");
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[1]}`;
}

/** Walks an expressions object (which nests arbitrarily for block
 *  attributes) collecting every `references` array found at any depth,
 *  bounded so untrusted input can't cause runaway recursion. */
function collectReferences(node: unknown, depth = 0): string[] {
  if (depth > 12 || node === null || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(obj["references"])) {
    for (const r of obj["references"] as unknown[]) {
      if (typeof r === "string") out.push(r);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === "references") continue;
    if (value && typeof value === "object") out.push(...collectReferences(value, depth + 1));
  }
  return out;
}

export interface GraphResult {
  edges: ReferenceEdge[];
  unresolvedReferences: UnresolvedReference[];
  dependents: Record<string, DependentResult[]>;
}

export function buildGraph(configuration: unknown, facts: readonly ResourceChangeFact[]): GraphResult {
  const edges: ReferenceEdge[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];

  const config = configuration as ConfigurationBlock | undefined;
  // `resources` should be an array per Terraform's own JSON format spec, but
  // a malformed or hand-edited plan could hand us anything at this boundary
  // — never trust an external document's shape past what we've already
  // validated. Anything not actually an array degrades to "no resources",
  // not a crash.
  const rawResources = config?.root_module?.resources;
  const resources = Array.isArray(rawResources) ? rawResources : [];

  // address -> fact.id, restricted to single-instance resources so we never
  // join a count/for_each instance to a config-level address by prefix.
  const singleInstanceFactByAddress = new Map<string, string>();
  const multiInstanceAddresses = new Set<string>();
  for (const f of facts) {
    if (f.address.includes("[") || f.deposed) {
      multiInstanceAddresses.add(f.address.split("[")[0] ?? f.address);
      continue;
    }
    singleInstanceFactByAddress.set(f.address, f.id);
  }

  for (const res of resources) {
    if (res.count_expression || res.for_each_expression) {
      unresolvedReferences.push({
        fromId: res.address,
        viaPath: "(count/for_each)",
        reason: "Resource uses count or for_each; instance-level reference resolution is not supported.",
      });
      continue;
    }
    const fromId = singleInstanceFactByAddress.get(res.address);
    if (!fromId) continue; // resource wasn't changed in this plan; nothing to attach an edge to

    const refs = collectReferences(res.expressions);
    for (const ref of refs) {
      const targetAddress = extractResourceAddress(ref);
      if (!targetAddress) continue; // var./local./data. etc — not a resource edge
      if (multiInstanceAddresses.has(targetAddress)) {
        unresolvedReferences.push({
          fromId,
          viaPath: ref,
          reason: `Reference target "${targetAddress}" uses count/for_each; cannot resolve to a specific instance.`,
        });
        continue;
      }
      const toId = singleInstanceFactByAddress.get(targetAddress);
      if (!toId) {
        unresolvedReferences.push({
          fromId,
          viaPath: ref,
          reason: `Reference target "${targetAddress}" is not among this plan's changed resources (unchanged, in a nested module, or a data source not tracked here).`,
        });
        continue;
      }
      edges.push({ fromId, toId, viaPath: ref, resolved: true });
    }
  }

  // Reverse traversal: for each changed resource, find direct and
  // transitive dependents (resources whose config references it).
  const forward = new Map<string, ReferenceEdge[]>(); // toId -> edges pointing at it
  for (const e of edges) {
    const list = forward.get(e.toId) ?? [];
    list.push(e);
    forward.set(e.toId, list);
  }

  const dependents: Record<string, DependentResult[]> = {};
  for (const f of facts) {
    const results: DependentResult[] = [];
    const visited = new Set<string>([f.id]);
    let frontier: { id: string; path: string[] }[] = (forward.get(f.id) ?? []).map((e) => ({
      id: e.fromId,
      path: [f.id, e.fromId],
    }));
    let depth = 0;
    while (frontier.length > 0 && depth < 25) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        results.push({
          resourceId: node.id,
          relationship: depth === 0 ? "direct" : "transitive",
          path: node.path,
        });
        for (const e of forward.get(node.id) ?? []) {
          if (!visited.has(e.fromId)) next.push({ id: e.fromId, path: [...node.path, e.fromId] });
        }
      }
      frontier = next;
      depth++;
    }
    if (results.length > 0) dependents[f.id] = results;
  }

  return { edges, unresolvedReferences, dependents };
}
