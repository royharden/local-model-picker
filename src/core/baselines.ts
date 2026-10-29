// Baselines (Claude §2.6, spec item 7): estimate-only (weights walk-down), fastest-only (max
// measured tok/s) and accuracy-only (max effective accuracy). Fastest-only and accuracy-only use
// all measured candidates of the selected group and IGNORE the user's limits by design; each row
// lists the measured limits its pick violates, so results can count violations separately per
// method. Estimate-only never reads measurements to choose; its violations are reported only when
// its pick happens to be measured.
import type { BaselineRow, FilterName, RecommendResult } from "./schema/result.js";
import type { Candidate } from "./schema/candidate.js";
import type { WalkdownResult } from "./estimate/walkdown.js";
import { WALKDOWN_LABEL } from "./estimate/walkdown.js";

export const FASTEST_ONLY_LABEL = "fastest-only (max measured tok/s; ignores limits)";
export const ACCURACY_ONLY_LABEL = "accuracy-only (max effective accuracy; ignores limits)";

/** What a baseline needs to know about one selected candidate measurement. */
export interface EvaluatedCandidate {
  key: string;
  candidate: Candidate;
  runId: string;
  /** measured, complete speed set and one result per item id */
  eligibleMeasurement: boolean;
  tokPerSec: number | null;
  latencyMs: number | null;
  memoryGB: number | null;
  accuracy: number | null;
  /** Failing filters under the caller's limits, in filter order. */
  failedFilters: FilterName[];
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function row(method: BaselineRow["method"], label: string, pick: EvaluatedCandidate | null, reason: string | null): BaselineRow {
  return {
    method,
    label,
    available: pick !== null,
    pick: pick === null ? null : pick.key,
    reason: pick === null ? reason : null,
    violations: pick === null ? [] : [...pick.failedFilters],
  };
}

function measured(cands: readonly EvaluatedCandidate[]): EvaluatedCandidate[] {
  return cands.filter((c) => c.eligibleMeasurement && c.tokPerSec !== null && c.accuracy !== null);
}

/** Max tokPerSec among measured candidates; ties: key ascending. */
export function fastestOnly(cands: readonly EvaluatedCandidate[]): BaselineRow {
  const pool = measured(cands).sort((a, b) => (b.tokPerSec as number) - (a.tokPerSec as number) || cmpStr(a.key, b.key));
  return row("fastest-only", FASTEST_ONLY_LABEL, pool[0] ?? null, "no measured candidate in the group");
}

/** Max effective accuracy among measured candidates; ties: faster, then key ascending. */
export function accuracyOnly(cands: readonly EvaluatedCandidate[]): BaselineRow {
  const pool = measured(cands).sort(
    (a, b) => (b.accuracy as number) - (a.accuracy as number) || (b.tokPerSec as number) - (a.tokPerSec as number) || cmpStr(a.key, b.key),
  );
  return row("accuracy-only", ACCURACY_ONLY_LABEL, pool[0] ?? null, "no measured candidate in the group");
}

/** Estimate-only row from a walk-down result. */
export function estimateOnly(cands: readonly EvaluatedCandidate[], walk: WalkdownResult): BaselineRow {
  if (!walk.available || walk.pick === null) {
    return { method: "estimate-only", label: walk.label, available: false, pick: null, reason: walk.reason ?? "unavailable", violations: [] };
  }
  const key = walk.pick.key;
  const ev = cands.find((c) => c.key === key);
  const isMeasured = ev !== undefined && ev.eligibleMeasurement;
  return {
    method: "estimate-only",
    label: walk.label,
    available: true,
    pick: key,
    reason: isMeasured ? null : "the estimate's pick was not measured in this group; its limit violations are unknown",
    violations: isMeasured ? [...ev.failedFilters] : [],
  };
}

/** All three rows unavailable (refused results: no comparison group was compared). */
export function unavailableBaselines(reason: string): RecommendResult["baselines"] {
  const r = (method: BaselineRow["method"], label: string): BaselineRow => ({ method, label, available: false, pick: null, reason, violations: [] });
  return {
    estimateOnly: r("estimate-only", WALKDOWN_LABEL),
    fastestOnly: r("fastest-only", FASTEST_ONLY_LABEL),
    accuracyOnly: r("accuracy-only", ACCURACY_ONLY_LABEL),
  };
}

/** Separate measured-limit violation counts per baseline method (results table input). */
export function baselineViolationCounts(baselines: RecommendResult["baselines"]): Record<"estimateOnly" | "fastestOnly" | "accuracyOnly", number> {
  return {
    estimateOnly: baselines.estimateOnly.violations.length,
    fastestOnly: baselines.fastestOnly.violations.length,
    accuracyOnly: baselines.accuracyOnly.violations.length,
  };
}
