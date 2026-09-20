// Parses `terraform show -json <planfile>` output into ResourceChangeFact[].
// Pure, offline, no network. Treats the input as untrusted external data:
// validates structure and the supported format major version, and never
// silently accepts an unrecognized action sequence as safe.
//
// Terraform JSON plan format reference:
// https://developer.hashicorp.com/terraform/internals/json-format

import { z } from "zod";
import {
  ANALYSIS_VERSION,
  SUPPORTED_FORMAT_MAJOR,
  type EvidencePath,
  type PlannedAction,
  type ResourceChangeFact,
  type TfAction,
} from "./types.js";

const KNOWN_ACTIONS = ["no-op", "create", "read", "update", "delete"] as const;

const ChangeSchema = z.object({
  actions: z.array(z.string()),
  before: z.unknown().nullable().optional(),
  after: z.unknown().nullable().optional(),
  after_unknown: z.unknown().optional(),
  before_sensitive: z.unknown().optional(),
  after_sensitive: z.unknown().optional(),
  replace_paths: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
});

// `action_reason` is a sibling of `change` on the resource_changes[] entry
// itself, NOT nested inside `change` — confirmed against the HashiCorp JSON
// format spec after an earlier version of this parser read it from the
// wrong location (`rc.change.action_reason` instead of `rc.action_reason`),
// which meant it was always undefined even when Terraform actually provided
// it. Found via adversarial review; see docs/decisions.md.
const ResourceChangeSchema = z.object({
  address: z.string(),
  module_address: z.string().optional(),
  mode: z.enum(["managed", "data"]),
  type: z.string(),
  name: z.string(),
  provider_name: z.string(),
  deposed: z.string().optional(),
  action_reason: z.string().optional(),
  change: ChangeSchema,
});

const PlanSchema = z.object({
  format_version: z.string(),
  terraform_version: z.string().optional(),
  resource_changes: z.array(ResourceChangeSchema).optional(),
  configuration: z.unknown().optional(),
  prior_state: z.unknown().optional(),
  // Top-level status flags a real plan document carries. Not fully acted on
  // yet (see docs/limitations.md for what's still missing: distinguishing
  // an errored/incomplete plan or a bare state document from an ordinary
  // zero-change plan) — but an `errored: true` plan now at least produces a
  // visible warning instead of being silently treated as "0 changes, fine".
  errored: z.boolean().optional(),
  complete: z.boolean().optional(),
  applyable: z.boolean().optional(),
});

export class PlanParseError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "PlanParseError";
  }
}

export interface ParsedPlan {
  formatVersion: string;
  terraformVersion?: string;
  facts: ResourceChangeFact[];
  /** Raw configuration block, kept for graph.ts. Untyped on purpose: config
   *  shape varies by Terraform version and we only read a documented subset. */
  configuration: unknown;
  warnings: string[];
}

function pathToString(segments: (string | number)[]): string {
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out || "(root)";
}

/** Walks after_unknown (which mirrors `after`'s shape) and collects paths
 *  whose leaf value is `true`. Caps depth so a pathological structure
 *  cannot cause runaway recursion on untrusted input. */
function collectUnknownPaths(node: unknown, prefix: (string | number)[] = [], depth = 0): string[] {
  if (depth > 12) return [pathToString(prefix) + ".(depth-limit)"];
  if (node === true) return [pathToString(prefix)];
  if (node === false || node === null || node === undefined) return [];
  if (Array.isArray(node)) {
    const out: string[] = [];
    node.forEach((v, i) => out.push(...collectUnknownPaths(v, [...prefix, i], depth + 1)));
    return out;
  }
  if (typeof node === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.push(...collectUnknownPaths(v, [...prefix, k], depth + 1));
    }
    return out;
  }
  return [];
}

function collectSensitivePaths(node: unknown, prefix: (string | number)[] = [], depth = 0): string[] {
  // before_sensitive / after_sensitive follow the same shape convention as
  // after_unknown: `true` marks a leaf (or whole subtree) as sensitive.
  return collectUnknownPaths(node, prefix, depth);
}

function classifyActions(actions: string[]): { planned: PlannedAction; tf: TfAction[] } {
  const known = actions.filter((a): a is TfAction => (KNOWN_ACTIONS as readonly string[]).includes(a));
  if (known.length !== actions.length) {
    return { planned: "unsupported", tf: known };
  }
  const key = actions.join(",");
  switch (key) {
    case "no-op":
      return { planned: "no-op", tf: known };
    case "create":
      return { planned: "create", tf: known };
    case "read":
      return { planned: "read", tf: known };
    case "update":
      return { planned: "update", tf: known };
    case "delete":
      return { planned: "delete", tf: known };
    case "delete,create":
      return { planned: "replace-delete-first", tf: known };
    case "create,delete":
      return { planned: "replace-create-first", tf: known };
    default:
      return { planned: "unsupported", tf: known };
  }
}

export function parsePlan(raw: unknown): ParsedPlan {
  const result = PlanSchema.safeParse(raw);
  if (!result.success) {
    throw new PlanParseError(
      "Input is not a valid `terraform show -json` plan document.",
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const plan = result.data;

  const majorStr = plan.format_version.split(".")[0];
  const major = Number(majorStr);
  if (!Number.isFinite(major) || major !== SUPPORTED_FORMAT_MAJOR) {
    throw new PlanParseError(
      `Unsupported plan format_version "${plan.format_version}". This tool supports major version ${SUPPORTED_FORMAT_MAJOR}.x.`,
    );
  }

  const warnings: string[] = [];
  const facts: ResourceChangeFact[] = [];

  if (plan.errored === true) {
    warnings.push(
      "Terraform reported this plan run as errored (top-level `errored: true`). Results below may be incomplete — this is not a clean, fully-evaluated plan.",
    );
  }

  for (const rc of plan.resource_changes ?? []) {
    const { planned, tf } = classifyActions(rc.change.actions);
    if (planned === "unsupported") {
      warnings.push(
        `${rc.address}: unrecognized action sequence [${rc.change.actions.join(",")}] — reported as unsupported, not treated as safe.`,
      );
    }

    const replacePaths: EvidencePath[] = (rc.change.replace_paths ?? []).map((segs) => ({
      path: pathToString(segs),
      unknown: false,
    }));

    const unknownPaths = collectUnknownPaths(rc.change.after_unknown);
    const sensitivePaths = Array.from(
      new Set([
        ...collectSensitivePaths(rc.change.before_sensitive),
        ...collectSensitivePaths(rc.change.after_sensitive),
      ]),
    );

    const isReplacement = planned === "replace-delete-first" || planned === "replace-create-first";
    const replacementCauseAvailable = isReplacement && (replacePaths.length > 0 || !!rc.action_reason);

    const id = rc.deposed ? `${rc.address}#deposed:${rc.deposed}` : rc.address;

    facts.push({
      id,
      address: rc.address,
      moduleAddress: rc.module_address,
      resourceType: rc.type,
      providerName: rc.provider_name,
      mode: rc.mode,
      actions: tf,
      plannedAction: planned,
      replacePaths,
      replacementCauseAvailable,
      actionReason: rc.action_reason,
      unknownPaths,
      sensitivePaths,
      deposed: rc.deposed,
    });
  }

  return {
    formatVersion: plan.format_version,
    terraformVersion: plan.terraform_version,
    facts,
    configuration: plan.configuration,
    warnings,
  };
}

export { ANALYSIS_VERSION };
