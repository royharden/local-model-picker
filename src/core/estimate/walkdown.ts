// Estimate-only walk-down baseline (Claude §2.6 "Estimate-only walk-down", D17, D29, R5).
// Uses only /api/tags weight sizes and the probe's availableMemory, never measurements.
// Budget = vramFreeBytes on a discrete NVIDIA GPU, ramFreeBytes on CPU-only / unknown GPU or Apple
// unified memory; a null budget makes the baseline unavailable (no fallback to totals, no guessed
// overhead). A candidate fits when sizeBytes <= budget; KV cache and runtime overhead are openly
// excluded, hence the label. Per model (tag name before ":" + parameterSize) the highest fitting
// quant in QUANT_ORDER wins; across models the largest parameterSize wins, ties to the higher quant,
// then key ascending. Remote groups and mixed-hardware groups: unavailable.
import type { Candidate } from "../schema/candidate.js";
import type { AvailableMemory, HardwareFingerprint } from "../schema/fingerprint.js";
import { QUANT_ORDER, quantRank, parseParameterSize, modelNameOf } from "./quant-order.js";

export const WALKDOWN_LABEL = "llmfit-style installed-only weights estimate";

export type WalkdownBudget =
  | { available: true; bytes: number; source: "vramFreeBytes" | "ramFreeBytes" }
  | { available: false; reason: string };

export interface BudgetInput {
  fingerprint: HardwareFingerprint;
  availableMemory: AvailableMemory;
  remote: boolean;
  mixedHardware: boolean;
}

export function estimateBudget(input: BudgetInput): WalkdownBudget {
  if (input.remote) return { available: false, reason: "remote group: no trustworthy server memory figure" };
  if (input.mixedHardware) return { available: false, reason: "mixed hardware: no single free-memory budget" };
  const gpu = input.fingerprint.gpu;
  const discrete = gpu.vendor === "nvidia" && gpu.unifiedMemory !== true;
  if (discrete) {
    const v = input.availableMemory.vramFreeBytes;
    if (v === null) return { available: false, reason: "free VRAM was not recorded (availableMemory.vramFreeBytes is null)" };
    return { available: true, bytes: v, source: "vramFreeBytes" };
  }
  const r = input.availableMemory.ramFreeBytes;
  if (r === null) return { available: false, reason: "free RAM was not recorded (availableMemory.ramFreeBytes is null)" };
  return { available: true, bytes: r, source: "ramFreeBytes" };
}

export interface WalkdownExclusion {
  key: string;
  reason: string;
}

export interface WalkdownModel {
  model: string;
  parameterSize: string;
  billions: number;
  /** Highest fitting quant candidate of this model, or null when none fits. */
  pick: string | null;
}

export interface WalkdownResult {
  label: string;
  available: boolean;
  /** Reason when unavailable or when nothing fits; null when a pick exists. */
  reason: string | null;
  pick: Candidate | null;
  budgetBytes: number | null;
  budgetSource: "vramFreeBytes" | "ramFreeBytes" | null;
  models: WalkdownModel[];
  excluded: WalkdownExclusion[];
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function walkdown(candidates: readonly Candidate[], budget: WalkdownBudget): WalkdownResult {
  if (!budget.available) {
    return { label: WALKDOWN_LABEL, available: false, reason: budget.reason, pick: null, budgetBytes: null, budgetSource: null, models: [], excluded: [] };
  }
  const bytes = budget.bytes;
  const source = budget.source;
  const excluded: WalkdownExclusion[] = [];
  const groups = new Map<string, { model: string; parameterSize: string; billions: number; members: { c: Candidate; rank: number }[] }>();
  const sorted = [...candidates].sort((a, b) => cmpStr(a.key, b.key));
  for (const c of sorted) {
    const billions = parseParameterSize(c.parameterSize);
    if (c.parameterSize === null || billions === null) {
      excluded.push({ key: c.key, reason: "parameter size unknown: excluded from the walk-down" });
      continue;
    }
    const rank = quantRank(c.quantization);
    if (rank === null) {
      excluded.push({ key: c.key, reason: `quantization ${c.quantization === null ? "unknown" : JSON.stringify(c.quantization)} is not in ${QUANT_ORDER.join(" > ")}` });
      continue;
    }
    const model = modelNameOf(c.tag);
    const gk = `${model}\u0000${c.parameterSize}`;
    const g = groups.get(gk) ?? { model, parameterSize: c.parameterSize, billions, members: [] };
    g.members.push({ c, rank });
    groups.set(gk, g);
  }

  const models: WalkdownModel[] = [];
  const winners: { c: Candidate; rank: number; billions: number }[] = [];
  const groupKeys = [...groups.keys()].sort(cmpStr);
  for (const gk of groupKeys) {
    const g = groups.get(gk);
    if (g === undefined) continue;
    const fitting = g.members
      .filter((m) => m.c.sizeBytes <= bytes)
      .sort((x, y) => x.rank - y.rank || cmpStr(x.c.key, y.c.key));
    const best = fitting[0];
    models.push({ model: g.model, parameterSize: g.parameterSize, billions: g.billions, pick: best === undefined ? null : best.c.key });
    if (best !== undefined) winners.push({ c: best.c, rank: best.rank, billions: g.billions });
    for (const m of g.members) {
      if (m.c.sizeBytes > bytes) excluded.push({ key: m.c.key, reason: `weights ${m.c.sizeBytes} B exceed the budget ${bytes} B (${source})` });
    }
  }
  winners.sort((x, y) => y.billions - x.billions || x.rank - y.rank || cmpStr(x.c.key, y.c.key));
  const pick = winners[0]?.c ?? null;
  excluded.sort((a, b) => cmpStr(a.key, b.key));
  return {
    label: WALKDOWN_LABEL,
    available: true,
    reason: pick === null ? "no candidate's weights fit the free-memory budget" : null,
    pick,
    budgetBytes: bytes,
    budgetSource: source,
    models,
    excluded,
  };
}
