// Confidence (Claude §2.6 step 9 as amended by D13, D14, D19, D32). `low` when any reason in this
// closed list holds; otherwise `high`. Each reason is listed separately, in this fixed order:
//   no recommendation (none/refused, D32) | noise set > 1 | fewer than two survivors |
//   any survivor's per-prompt spread > spreadThreshold (one reason per survivor) |
//   allowMixedHardware used | Ollama versions differ in the group |
//   full-GPU check skipped (no GPU detected; unified memory not interpretable, per candidate) |
//   runtime mock (keyed on runtime, not on `synthetic`) | remote group |
//   pick has over_cap or unterminated_think on any item | item bank incomplete (D19).
// Every other warning (e.g. ambiguous unload ownership) is display-only. Confidence is an internal
// heuristic label, not a probability. Every reason text starts with a stable prefix (REASON_PREFIX).
import { fmtNum, q } from "./trace.js";

export const REASON_PREFIX = {
  noRecommendation: "no recommendation",
  noise: "accuracy margin is inside noise",
  fewSurvivors: "fewer than two candidates passed the limits",
  spread: "unstable speed",
  mixedHardware: "mixed hardware",
  versions: "Ollama versions differ within the group",
  noGpu: "no GPU detected; full-GPU check not applied",
  unified: "unified memory: offload not interpretable",
  mock: "mock data: not a measurement",
  remote: "remote server",
  pickFlags: "pick's graded text",
  incompleteBank: "item bank incomplete (placeholders)",
} as const;

export interface ConfidenceInput {
  kind: "pick" | "none" | "refused";
  /** none/refused: the reason the result has no pick. */
  noPickMessage: string | null;
  noiseSetSize: number;
  survivorCount: number;
  /** Survivors whose spreadMax exceeds the threshold. */
  unstable: readonly { key: string; spreadMax: number }[];
  spreadThreshold: number;
  mixedHardware: boolean;
  /** Distinct Ollama versions of the contributing runs (null = not recorded). */
  ollamaVersions: readonly (string | null)[];
  gpuSkippedNoGpu: boolean;
  gpuSkippedUnified: readonly string[];
  mock: boolean;
  remote: boolean;
  /** "true" | "false": the explicit GPU rule enforced on a remote group. */
  remoteGpuRule: string | null;
  /** Items of the pick flagged over_cap or unterminated_think. */
  pickFlaggedItems: number;
  itemBankIncomplete: boolean;
}

export interface Confidence {
  confidence: "high" | "low";
  reasons: string[];
}

function groupReasons(input: ConfidenceInput): string[] {
  const out: string[] = [];
  if (input.mixedHardware) out.push(`${REASON_PREFIX.mixedHardware}: allowMixedHardware used, hardware fingerprints were not compared`);
  const versions = [...new Set(input.ollamaVersions.map((v) => v ?? "unknown"))].sort();
  if (versions.length > 1) out.push(`${REASON_PREFIX.versions} (${versions.join(", ")})`);
  if (input.gpuSkippedNoGpu) out.push(REASON_PREFIX.noGpu);
  for (const key of [...input.gpuSkippedUnified].sort()) out.push(`${REASON_PREFIX.unified} for ${q(key)}; full-GPU check skipped`);
  if (input.mock) out.push(REASON_PREFIX.mock);
  if (input.remote) out.push(`${REASON_PREFIX.remote}: hardware unknown; requireFullGpu ${input.remoteGpuRule ?? "explicit"} enforced as chosen`);
  return out;
}

/** Reasons are bounded (schema max 500 chars); quoted keys can be long. */
export const REASON_MAX = 500;

function clipReason(text: string): string {
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 3)}...`;
}

export function computeConfidence(input: ConfidenceInput): Confidence {
  const { confidence, reasons } = computeRaw(input);
  // The result contract allows 50 reasons. Keep every reason class; when many candidates share
  // spread/unified-memory reasons, summarize those classes here. recommend() keeps the detailed
  // evidence for each affected candidate in its trace (never silently drop a reason class).
  if (reasons.length <= 50) return { confidence, reasons: reasons.map(clipReason) };
  let spreadShown = false;
  let unifiedShown = false;
  const bounded: string[] = [];
  for (const reason of reasons) {
    if (reason.startsWith(`${REASON_PREFIX.spread}:`)) {
      if (!spreadShown) bounded.push(`${REASON_PREFIX.spread}: ${input.unstable.length} candidates exceed spread threshold ${fmtNum(input.spreadThreshold)}; per-candidate evidence is in the trace`);
      spreadShown = true;
    } else if (reason.startsWith(`${REASON_PREFIX.unified} for `)) {
      if (!unifiedShown) bounded.push(`${REASON_PREFIX.unified} for ${input.gpuSkippedUnified.length} candidates; full-GPU check skipped; per-candidate evidence is in the trace`);
      unifiedShown = true;
    } else bounded.push(reason);
  }
  return { confidence, reasons: bounded.map(clipReason) };
}

function computeRaw(input: ConfidenceInput): Confidence {
  const reasons: string[] = [];
  if (input.kind !== "pick") {
    reasons.push(`${REASON_PREFIX.noRecommendation}: ${input.noPickMessage ?? "no candidate was picked"}`);
    if (input.kind === "none") {
      reasons.push(...groupReasons(input));
      if (input.itemBankIncomplete) reasons.push(REASON_PREFIX.incompleteBank);
    }
    return { confidence: "low", reasons };
  }
  if (input.noiseSetSize > 1) {
    reasons.push(`${REASON_PREFIX.noise}: ${input.noiseSetSize} candidates are tied within noise (failure to distinguish, not proven equivalence)`);
  }
  if (input.survivorCount < 2) reasons.push(REASON_PREFIX.fewSurvivors);
  for (const u of [...input.unstable].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    reasons.push(`${REASON_PREFIX.spread}: ${q(u.key)} per-prompt spread ${fmtNum(u.spreadMax)} exceeds ${fmtNum(input.spreadThreshold)}`);
  }
  reasons.push(...groupReasons(input));
  if (input.pickFlaggedItems > 0) {
    reasons.push(`${REASON_PREFIX.pickFlags} was cut at the cap or left an unterminated think block on ${input.pickFlaggedItems} item(s)`);
  }
  if (input.itemBankIncomplete) reasons.push(REASON_PREFIX.incompleteBank);
  return { confidence: reasons.length > 0 ? "low" : "high", reasons };
}
