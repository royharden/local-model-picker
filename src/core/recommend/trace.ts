// TraceEntry builders (Claude §2.5 TraceEntry, §2.6 steps 4 and 10). One "why not" (or why) line
// per entry. Filter entries always carry measured, limit, unit and source; a missing measurement is
// recorded as measured "not measured", never as 0. Candidate keys may contain untrusted tag text
// (scenario s09), so they are quoted with JSON.stringify (control characters escaped) in texts.
import type { FilterName, TraceEntry, RecommendResult } from "../schema/result.js";
import type { Discordance } from "../aggregate/accuracy.js";
import type { LatencyMetric } from "../aggregate/speed.js";

export const NOT_MEASURED = "not measured";
const TEXT_MAX = 1000;

/** Quote untrusted text (tags, keys) for trace and message text. */
export function q(text: string): string {
  return JSON.stringify(text);
}

function clip(text: string): string {
  return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX - 3)}...`;
}

/** Up to two decimals, no trailing zeros. */
export function fmtNum(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return String(Math.round(x * 100) / 100);
}

/** p-value text: 4 decimals, or exponent form below 0.001. */
export function fmtP(p: number): string {
  if (p === 0) return "0";
  if (p < 0.001) return p.toExponential(2);
  return p.toFixed(4);
}

function fmtPct(x: number): string {
  return `${fmtNum(x * 100)}%`;
}

export const FILTER_UNITS: Readonly<Record<FilterName, string>> = {
  minTokPerSec: "tok/s",
  maxTtftMs: "ms",
  maxMemoryGB: "GB (decimal)",
  requireFullGpu: "fraction in VRAM",
  minAccuracy: "fraction correct",
};

export function latencySource(metric: LatencyMetric | null): string {
  return metric === "ttfa"
    ? "max of per-prompt median time to first answer (thinking observed)"
    : "max of per-prompt median TTFT";
}

export function accuracySource(applyRulings: boolean, humanCorrected: boolean): string {
  if (!applyRulings) return "effective accuracy (original grades)";
  return humanCorrected ? "effective accuracy (rulings applied, human-corrected)" : "effective accuracy (rulings applied)";
}

export const SPEED_SOURCE = "min of per-prompt median genTokPerSec (eval_count / eval_duration)";
export const MEMORY_SOURCE = "max /api/ps size over observations";
export const OFFLOAD_SOURCE = "min /api/ps size_vram / size over observations";

function entry(
  candidateKey: string,
  kind: TraceEntry["kind"],
  text: string,
  fields: Partial<Pick<TraceEntry, "filter" | "measured" | "limit" | "unit" | "source">> = {},
): TraceEntry {
  return {
    candidateKey,
    kind,
    filter: fields.filter ?? null,
    measured: fields.measured ?? null,
    limit: fields.limit ?? null,
    unit: fields.unit ?? null,
    source: fields.source ?? null,
    text: clip(text),
  };
}

export function minTokEntry(key: string, measured: number, limit: number): TraceEntry {
  return entry(key, "filter", `throughput ${fmtNum(measured)} tok/s is below the minimum ${fmtNum(limit)} tok/s (${SPEED_SOURCE})`, {
    filter: "minTokPerSec", measured, limit, unit: FILTER_UNITS.minTokPerSec, source: SPEED_SOURCE,
  });
}

export function maxTtftEntry(key: string, measured: number, limit: number, metric: LatencyMetric | null): TraceEntry {
  const name = metric === "ttfa" ? "time to first answer (thinking observed)" : "time to first token";
  const source = latencySource(metric);
  return entry(key, "filter", `latency (${name}) ${fmtNum(measured)} ms exceeds the maximum ${fmtNum(limit)} ms (${source})`, {
    filter: "maxTtftMs", measured, limit, unit: FILTER_UNITS.maxTtftMs, source,
  });
}

export function maxMemoryEntry(key: string, measured: number | null, limit: number): TraceEntry {
  const text = measured === null
    ? `memory not measured (no /api/ps observation), so the ${fmtNum(limit)} GB limit cannot be shown to hold`
    : `memory ${fmtNum(measured)} GB exceeds the maximum ${fmtNum(limit)} GB (${MEMORY_SOURCE})`;
  return entry(key, "filter", text, {
    filter: "maxMemoryGB", measured: measured ?? NOT_MEASURED, limit, unit: FILTER_UNITS.maxMemoryGB, source: MEMORY_SOURCE,
  });
}

export function fullGpuEntry(key: string, measured: number | null, threshold: number, how: string): TraceEntry {
  const text = measured === null
    ? `offload not measured (no valid /api/ps size_vram), so the full-GPU rule (${how}) cannot be shown to hold`
    : `only ${fmtPct(measured)} of the model is in VRAM; the full-GPU rule (${how}) needs at least ${fmtPct(threshold)} (${OFFLOAD_SOURCE})`;
  return entry(key, "filter", text, {
    filter: "requireFullGpu", measured: measured ?? NOT_MEASURED, limit: threshold, unit: FILTER_UNITS.requireFullGpu, source: OFFLOAD_SOURCE,
  });
}

export function minAccuracyEntry(key: string, measured: number, limit: number, source: string): TraceEntry {
  return entry(key, "filter", `accuracy ${fmtPct(measured)} is below the minimum ${fmtPct(limit)} (${source})`, {
    filter: "minAccuracy", measured, limit, unit: FILTER_UNITS.minAccuracy, source,
  });
}

export function unmeasuredEntry(key: string, reason: string): TraceEntry {
  return entry(key, "unmeasured", `unmeasured: ${reason}; never eligible`);
}

export function supersededEntry(key: string, olderRunId: string, newerRunId: string): TraceEntry {
  return entry(key, "superseded", `superseded by a newer measurement: older measurement of ${q(key)} from run ${olderRunId} ignored; run ${newerRunId} used as a whole`);
}

export function incompatibleEntry(key: string, runId: string, differences: readonly string[]): TraceEntry {
  const why = differences.length > 0 ? differences.join(", ") : "comparison-group key";
  return entry(key, "incompatible", `not compared: run ${runId} is in a different comparison group (${why} differ)`);
}

function graderBreakdown(d: Discordance): string {
  const parts = [...d.byGrader.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([g, v]) => `${g} ${v.b} vs ${v.c}`);
  return parts.length > 0 ? `; discordant by grader: ${parts.join(", ")}` : "";
}

/** Survivor outside the noise set (quality objective). */
export function significantlyLowerEntry(key: string, leaderKey: string, d: Discordance, p: number, alpha: number): TraceEntry {
  return entry(
    key,
    "quality",
    `significantly lower accuracy than leader ${q(leaderKey)} (${d.b} vs ${d.c} discordant items, one-sided sign test p = ${fmtP(p)} < alpha ${fmtNum(alpha)})${graderBreakdown(d)}`,
  );
}

/** Noise-set member that was not picked (quality objective). */
export function tieSlowerEntry(key: string, tok: number, pickTok: number): TraceEntry {
  const text = tok < pickTok
    ? `tied within noise but slower (${fmtNum(tok)} vs ${fmtNum(pickTok)} tok/s)`
    : `tied within noise; equal throughput (${fmtNum(tok)} tok/s), lost the tie-break (lower memory, then lower latency, then key)`;
  return entry(key, "tie-slower", text);
}

/** The pick when it is not the accuracy leader (quality objective, tied). */
export function tiedPickEntry(key: string, leaderKey: string, d: Discordance, p: number): TraceEntry {
  return entry(
    key,
    "quality",
    `tied within noise with accuracy leader ${q(leaderKey)} (${d.b} vs ${d.c} discordant items, p = ${fmtP(p)}); picked as the fastest of the noise set${graderBreakdown(d)}`,
  );
}

/** Survivor not picked under the speed objective. */
export function speedSlowerEntry(key: string, tok: number, pickTok: number): TraceEntry {
  const text = tok < pickTok
    ? `slower than the pick under the speed objective (${fmtNum(tok)} vs ${fmtNum(pickTok)} tok/s)`
    : `equal throughput (${fmtNum(tok)} tok/s) under the speed objective; lost the tie-break (higher accuracy, then lower memory, then lower latency, then key)`;
  return entry(key, "tie-slower", text);
}

/** Speed objective: the paired comparison of the pick against the accuracy leader (what speed costs). */
export function speedCostEntry(key: string, leaderKey: string, d: Discordance, p: number, alpha: number): TraceEntry {
  const verdict = p < alpha
    ? `significantly lower accuracy than leader ${q(leaderKey)}`
    : `not significantly lower accuracy than leader ${q(leaderKey)}`;
  return entry(
    key,
    "quality",
    `speed objective: ${verdict} (${d.b} vs ${d.c} discordant items, one-sided sign test p = ${fmtP(p)}, alpha ${fmtNum(alpha)}); shown so the accuracy cost of speed is visible${graderBreakdown(d)}`,
  );
}

/** All trace lines for one candidate, in trace order. */
export function whyNot(result: Pick<RecommendResult, "trace">, candidateKey: string): string[] {
  return result.trace.filter((t) => t.candidateKey === candidateKey).map((t) => t.text);
}

/** Failing filter names per candidate key (FILTER order preserved as recorded). */
export function rejectedFilters(result: Pick<RecommendResult, "trace">): Map<string, FilterName[]> {
  const out = new Map<string, FilterName[]>();
  for (const t of result.trace) {
    if (t.kind !== "filter" || t.filter === null) continue;
    const list = out.get(t.candidateKey) ?? [];
    list.push(t.filter);
    out.set(t.candidateKey, list);
  }
  return out;
}
