// Speed aggregation (Claude §2.6 "Speed aggregation", D11, D12).
// Repeat 0 is the warm-up (one per prompt) and is dropped. Per prompt: median, min, max of
// genTokPerSec and of the latency over the measured repeats; spread = (max - min) / median.
// Candidate throughput = MIN of the per-prompt medians; candidate latency = MAX of the per-prompt
// medians, where latency is TTFT for non-thinking models and time to first answer (ttfaMs) when
// thinking was observed. A prompt with fewer than SPEED_REPEATS valid measured repeats makes the
// candidate incomplete (never eligible); an invalid repeat never becomes a speed of 0.
import type { SpeedRepeat } from "../schema/candidate.js";
import type { PerPromptSpeed } from "../schema/result.js";
import { SPEED_PROMPT_COUNT, SPEED_REPEATS } from "../config/defaults.js";

export type LatencyMetric = "ttft" | "ttfa";

export interface SpeedAggregate {
  /** True when every one of SPEED_PROMPT_COUNT prompts has at least SPEED_REPEATS valid measured repeats. */
  complete: boolean;
  /** Why the speed set is incomplete (null when complete). */
  incompleteReason: string | null;
  /** Per-prompt table, promptId ascending. medianLatencyMs uses the candidate's latencyMetric. */
  perPrompt: PerPromptSpeed[];
  /** Min of per-prompt median genTokPerSec (null unless complete). */
  tokPerSec: number | null;
  /** Max of per-prompt median latency in the chosen metric (null unless complete). */
  latencyMs: number | null;
  /** "ttfa" when thinking was observed on any valid measured repeat, else "ttft" (null when no valid measured repeat). */
  latencyMetric: LatencyMetric | null;
  /** Max of per-prompt median TTFT and of per-prompt median time to first answer; both are always shown. */
  maxMedianTtftMs: number | null;
  maxMedianTtfaMs: number | null;
  /** D12 descriptive bounds: [min over prompts of per-prompt min, min over prompts of per-prompt max]. */
  speedRange: { lo: number; hi: number } | null;
  /** Largest per-prompt spread (null when no prompt has a spread). */
  spreadMax: number | null;
  /** Warm-up (cold) load time: max loadMs over the valid warm-up repeats; null if none. */
  coldLoadMs: number | null;
  /** Median loadMs over valid measured repeats; null if none. */
  warmLoadMs: number | null;
}

/** Median of a non-empty list (mean of the two middle values for an even count). Does not mutate. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("median of an empty list");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function minOf(values: readonly number[]): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

function maxOf(values: readonly number[]): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

function isNum(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}

/** A measured repeat usable for throughput: valid, not the warm-up, positive finite rate. */
function usable(r: SpeedRepeat): boolean {
  return r.repeat >= 1 && r.repeat <= SPEED_REPEATS && r.valid && isNum(r.genTokPerSec) && r.genTokPerSec > 0;
}

export function aggregateSpeed(speed: readonly SpeedRepeat[]): SpeedAggregate {
  const promptIds = [...new Set(speed.map((r) => r.promptId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const measured = speed.filter(usable);
  const thinking = measured.some((r) => r.thinkingObserved);
  const latencyMetric: LatencyMetric | null = measured.length === 0 ? null : thinking ? "ttfa" : "ttft";
  const latencyOf = (r: SpeedRepeat): number | null => (latencyMetric === "ttfa" ? r.ttfaMs : r.ttftMs);

  const perPrompt: PerPromptSpeed[] = [];
  const medians: number[] = [];
  const latMedians: number[] = [];
  const ttftMedians: number[] = [];
  const ttfaMedians: number[] = [];
  const mins: number[] = [];
  const maxs: number[] = [];
  const spreads: number[] = [];
  const shortPrompts: string[] = [];

  for (const promptId of promptIds) {
    const rs = measured.filter((r) => r.promptId === promptId);
    const toks = rs.map((r) => r.genTokPerSec as number);
    if (rs.length !== SPEED_REPEATS || new Set(rs.map((r) => r.repeat)).size !== SPEED_REPEATS) {
      const firstInvalid = speed.find((r) => r.promptId === promptId && r.repeat >= 1 && !r.valid);
      const why = firstInvalid?.invalidReason ? ` (${firstInvalid.invalidReason})` : "";
      shortPrompts.push(`prompt ${promptId} needs ${SPEED_REPEATS} distinct valid measured repeats; recorded ${rs.length}${why}`);
    }
    if (toks.length === 0) {
      perPrompt.push({ promptId, validRepeats: 0, medianTokPerSec: null, minTokPerSec: null, maxTokPerSec: null, spread: null, medianLatencyMs: null });
      continue;
    }
    const med = median(toks);
    const lo = minOf(toks);
    const hi = maxOf(toks);
    const spread = (hi - lo) / med;
    const lats = rs.map(latencyOf).filter(isNum);
    if (lats.length !== rs.length || lats.some((v) => v < 0)) {
      shortPrompts.push(`prompt ${promptId} has a valid repeat without a usable ${latencyMetric ?? "latency"} value`);
    }
    const medLat = lats.length > 0 ? median(lats) : null;
    const ttfts = rs.map((r) => r.ttftMs).filter(isNum);
    const ttfas = rs.map((r) => r.ttfaMs).filter(isNum);
    perPrompt.push({ promptId, validRepeats: rs.length, medianTokPerSec: med, minTokPerSec: lo, maxTokPerSec: hi, spread, medianLatencyMs: medLat });
    medians.push(med);
    mins.push(lo);
    maxs.push(hi);
    spreads.push(spread);
    if (medLat !== null) latMedians.push(medLat);
    if (ttfts.length > 0) ttftMedians.push(median(ttfts));
    if (ttfas.length > 0) ttfaMedians.push(median(ttfas));
  }

  const reasons: string[] = [];
  if (promptIds.length !== SPEED_PROMPT_COUNT) {
    reasons.push(`${promptIds.length} of ${SPEED_PROMPT_COUNT} speed prompts recorded`);
  }
  reasons.push(...shortPrompts);
  const latencyComplete = latMedians.length === promptIds.length;
  if (reasons.length === 0 && !latencyComplete) reasons.push("a prompt has no latency value on its valid repeats");
  const complete = reasons.length === 0;

  const warmups = speed.filter((r) => r.repeat === 0 && r.valid && isNum(r.loadMs)).map((r) => r.loadMs as number);
  const warmLoads = measured.map((r) => r.loadMs).filter(isNum);

  return {
    complete,
    incompleteReason: complete ? null : reasons.join("; "),
    perPrompt,
    tokPerSec: complete ? minOf(medians) : null,
    latencyMs: complete ? maxOf(latMedians) : null,
    latencyMetric,
    maxMedianTtftMs: ttftMedians.length > 0 ? maxOf(ttftMedians) : null,
    maxMedianTtfaMs: ttfaMedians.length > 0 ? maxOf(ttfaMedians) : null,
    speedRange: complete ? { lo: minOf(mins), hi: minOf(maxs) } : null,
    spreadMax: spreads.length > 0 ? maxOf(spreads) : null,
    coldLoadMs: warmups.length > 0 ? maxOf(warmups) : null,
    warmLoadMs: warmLoads.length > 0 ? median(warmLoads) : null,
  };
}
