// recommend(runs, constraints, options): pure, deterministic, never mutates its input
// (Claude §2.6 steps 1-11 with D11-D17, D19, D32-D34). No clock, no I/O, no randomness.
//  1 comparison group (refused when >1 group and none chosen; remote needs acceptRemote and an
//    explicit requireFullGpu)          2 one whole measurement per candidate key (supersession)
//  3 unmeasured partition              4 hard filters, EVERY failing filter recorded
//  5 no survivors -> none (never the least bad)
//  6 quality: leader, one-sided exact sign test per survivor, noise set, pick = fastest of it
//  7 speed: requires minAccuracy; pick = fastest survivor; paired test vs leader still shown
//  8 runner-up = next in the final ordering   9 confidence (closed list)   10 trace
// 11 command only for tags matching the safe grammar.
import type { RunFile, CandidateRun } from "../schema/runfile.js";
import { MAX_CANDIDATES } from "../schema/runfile.js";
import type { Constraints, SelectionOptions } from "../schema/constraints.js";
import { RecommendConfigSchema } from "../schema/constraints.js";
import type { HardwareFingerprint } from "../schema/fingerprint.js";
import type { CandidateSummary, FilterName, GroupInfo, RecommendResult, TraceEntry } from "../schema/result.js";
import { aggregateSpeed } from "../aggregate/speed.js";
import type { SpeedAggregate } from "../aggregate/speed.js";
import { aggregateMemory } from "../aggregate/memory.js";
import type { MemoryAggregate } from "../aggregate/memory.js";
import { aggregateAccuracy, discordance } from "../aggregate/accuracy.js";
import type { AccuracyAggregate, Discordance } from "../aggregate/accuracy.js";
import { signTestOneSided } from "../evalkit/signtest.js";
import { groupRuns, groupDifferences, MIXED_HARDWARE, groupKeyParts } from "./group.js";
import type { RunGroup } from "./group.js";
import { computeConfidence } from "./confidence.js";
import {
  accuracySource,
  fmtNum,
  fullGpuEntry,
  incompatibleEntry,
  maxMemoryEntry,
  maxTtftEntry,
  minAccuracyEntry,
  minTokEntry,
  q,
  significantlyLowerEntry,
  speedCostEntry,
  speedSlowerEntry,
  supersededEntry,
  tiedPickEntry,
  tieSlowerEntry,
  unmeasuredEntry,
} from "./trace.js";
import { safeRunCommand, UNSAFE_TAG_REASON } from "./safe-command.js";
import { estimateBudget, walkdown } from "../estimate/walkdown.js";
import { accuracyOnly, estimateOnly, fastestOnly, unavailableBaselines } from "../baselines.js";
import type { EvaluatedCandidate } from "../baselines.js";

const MESSAGE_MAX = 2000;

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clipMessage(text: string): string {
  return text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX - 3)}...`;
}

/** Full-GPU rule resolution for one candidate (D14). */
export type GpuRuleResolution =
  | { applied: true; how: string }
  | { applied: false; skipped: "off" | "no-gpu" | "unified" };

export function resolveFullGpuRule(rule: Constraints["requireFullGpu"], fp: HardwareFingerprint, offload: number | null): GpuRuleResolution {
  if (rule === false) return { applied: false, skipped: "off" };
  if (rule === true) return { applied: true, how: "requireFullGpu true" };
  const gpu = fp.gpu;
  if (gpu.vendor === "apple" || gpu.unifiedMemory === true) {
    return offload !== null ? { applied: true, how: "auto, unified memory with valid size_vram" } : { applied: false, skipped: "unified" };
  }
  if (gpu.vendor === "nvidia" && gpu.vramTotalBytes !== null) return { applied: true, how: "auto, discrete NVIDIA GPU" };
  return { applied: false, skipped: "no-gpu" };
}

/** Internal per-candidate evaluation. */
interface Evaluated extends EvaluatedCandidate {
  run: RunFile;
  cr: CandidateRun;
  speed: SpeedAggregate;
  memory: MemoryAggregate;
  acc: AccuracyAggregate;
  unmeasuredReason: string | null;
  gpu: GpuRuleResolution | null;
  failures: TraceEntry[];
}

interface Selection {
  chosen: { run: RunFile; cr: CandidateRun }[];
  superseded: TraceEntry[];
}

/** Step 2: one whole measurement per candidate key (latest createdAt, then highest runId). */
function selectMeasurements(group: RunGroup): Selection {
  const byKey = new Map<string, { run: RunFile; cr: CandidateRun; index: number }[]>();
  group.runs.forEach((run, index) => {
    for (const cr of run.candidates) {
      const list = byKey.get(cr.candidate.key) ?? [];
      list.push({ run, cr, index });
      byKey.set(cr.candidate.key, list);
    }
  });
  const chosen: { run: RunFile; cr: CandidateRun }[] = [];
  const superseded: TraceEntry[] = [];
  for (const key of [...byKey.keys()].sort(cmpStr)) {
    const list = [...(byKey.get(key) ?? [])].sort(
      (a, b) =>
        cmpStr(b.run.createdAt, a.run.createdAt) ||
        cmpStr(b.run.runId, a.run.runId) ||
        // same run id imported twice (e.g. original and re-exported file): the copy with more rulings, then the later input
        b.run.rulings.length - a.run.rulings.length ||
        b.index - a.index,
    );
    const newest = list[0];
    if (newest === undefined) continue;
    chosen.push({ run: newest.run, cr: newest.cr });
    for (const older of list.slice(1)) superseded.push(supersededEntry(key, older.run.runId, newest.run.runId));
  }
  return { chosen, superseded };
}

function unmeasuredReasonOf(run: RunFile, cr: CandidateRun, speed: SpeedAggregate): string | null {
  if (cr.status !== "measured") return `status ${cr.status}: ${cr.statusReason ?? "no reason recorded"}`;
  if (!speed.complete) return speed.incompleteReason ?? "speed set incomplete";
  const have = new Set(cr.items.map((r) => r.itemId));
  if (cr.items.length !== run.itemIds.length || run.itemIds.some((id) => !have.has(id))) return "not exactly one item result per item id";
  return null;
}

/** Steps 3-4: aggregate, partition and filter one measurement. */
function evaluate(run: RunFile, cr: CandidateRun, constraints: Constraints, applyRulings: boolean): Evaluated {
  const key = cr.candidate.key;
  const speed = aggregateSpeed(cr.speed);
  const memory = aggregateMemory(cr.memory);
  const acc = aggregateAccuracy(cr.items, run.rulings, run.runId, key, applyRulings);
  const unmeasuredReason = unmeasuredReasonOf(run, cr, speed);
  const failures: TraceEntry[] = [];
  let gpu: GpuRuleResolution | null = null;
  if (unmeasuredReason === null) {
    const tok = speed.tokPerSec as number;
    const lat = speed.latencyMs as number;
    if (tok < constraints.minTokPerSec) failures.push(minTokEntry(key, tok, constraints.minTokPerSec));
    if (lat > constraints.maxTtftMs) failures.push(maxTtftEntry(key, lat, constraints.maxTtftMs, speed.latencyMetric));
    if (constraints.maxMemoryGB !== null && (memory.memoryGB === null || memory.memoryGB > constraints.maxMemoryGB)) {
      failures.push(maxMemoryEntry(key, memory.memoryGB, constraints.maxMemoryGB));
    }
    gpu = resolveFullGpuRule(constraints.requireFullGpu, run.fingerprint, memory.offload);
    if (gpu.applied && (memory.offload === null || memory.offload < constraints.fullGpuThreshold)) {
      failures.push(fullGpuEntry(key, memory.offload, constraints.fullGpuThreshold, gpu.how));
    }
    if (constraints.minAccuracy !== null && acc.accuracy !== null && acc.accuracy < constraints.minAccuracy) {
      failures.push(minAccuracyEntry(key, acc.accuracy, constraints.minAccuracy, accuracySource(applyRulings, acc.humanCorrected)));
    }
  }
  return {
    key,
    candidate: cr.candidate,
    runId: run.runId,
    eligibleMeasurement: unmeasuredReason === null,
    tokPerSec: speed.tokPerSec,
    latencyMs: speed.latencyMs,
    memoryGB: memory.memoryGB,
    accuracy: acc.accuracy,
    failedFilters: failures.map((f) => f.filter).filter((f): f is FilterName => f !== null),
    run,
    cr,
    speed,
    memory,
    acc,
    unmeasuredReason,
    gpu,
    failures,
  };
}

function summary(e: Evaluated): CandidateSummary {
  return {
    key: e.key,
    runId: e.runId,
    status: e.cr.status === "measured" && e.unmeasuredReason !== null ? "incomplete" : e.cr.status,
    accuracy: e.acc.accuracy,
    correct: e.acc.correct,
    n: e.acc.n,
    wilson95: e.acc.wilson95,
    tokPerSec: e.speed.tokPerSec,
    speedRange: e.speed.speedRange,
    perPrompt: e.speed.perPrompt,
    ttftMs: e.speed.latencyMs,
    latencyMetric: e.speed.latencyMetric,
    memoryGB: e.memory.memoryGB,
    offload: e.memory.offload,
    spreadMax: e.speed.spreadMax,
    humanCorrected: e.acc.humanCorrected,
  };
}

// Orderings. Missing memory/latency sort last (never "better" by being unmeasured).
const orNull = (x: number | null): number => (x === null ? Infinity : x);
const tokOf = (e: Evaluated): number => e.tokPerSec ?? -Infinity;
const accOf = (e: Evaluated): number => e.acc.accuracy ?? -Infinity;

/** Leader: highest accuracy; ties faster, lower memory, lower latency, key. */
function byAccuracy(a: Evaluated, b: Evaluated): number {
  return accOf(b) - accOf(a) || tokOf(b) - tokOf(a) || orNull(a.memoryGB) - orNull(b.memoryGB) || orNull(a.latencyMs) - orNull(b.latencyMs) || cmpStr(a.key, b.key);
}

/** Noise-set pick: fastest; ties lower memory, lower latency, key. */
function bySpeedQuality(a: Evaluated, b: Evaluated): number {
  return tokOf(b) - tokOf(a) || orNull(a.memoryGB) - orNull(b.memoryGB) || orNull(a.latencyMs) - orNull(b.latencyMs) || cmpStr(a.key, b.key);
}

/** Speed objective: fastest; ties higher accuracy, lower memory, lower latency, key. */
function bySpeedObjective(a: Evaluated, b: Evaluated): number {
  return tokOf(b) - tokOf(a) || accOf(b) - accOf(a) || orNull(a.memoryGB) - orNull(b.memoryGB) || orNull(a.latencyMs) - orNull(b.latencyMs) || cmpStr(a.key, b.key);
}

function graderMap(e: Evaluated): Map<string, string> {
  return new Map(e.cr.items.map((r): [string, string] => [r.itemId, r.graderId]));
}

interface Paired {
  d: Discordance;
  p: number;
  significant: boolean;
}

function refused(message: string, groupsAvailable: GroupInfo[], group: RunGroup | null): RecommendResult {
  const msg = clipMessage(message);
  const conf = computeConfidence({
    kind: "refused",
    noPickMessage: msg,
    noiseSetSize: 0,
    survivorCount: 0,
    unstable: [],
    spreadThreshold: 0,
    mixedHardware: false,
    ollamaVersions: [],
    gpuSkippedNoGpu: false,
    gpuSkippedUnified: [],
    mock: false,
    remote: false,
    remoteGpuRule: null,
    pickFlaggedItems: 0,
    itemBankIncomplete: false,
  });
  return {
    kind: "refused",
    group: group === null ? null : { key: group.key, runIds: group.info.runIds },
    groupsAvailable,
    message: msg,
    pick: null,
    runnerUp: null,
    tied: false,
    noiseSet: [],
    confidence: conf.confidence,
    confidenceReasons: conf.reasons,
    speedComparison: null,
    perCandidate: [],
    trace: [],
    baselines: unavailableBaselines("no comparison group was compared"),
    command: null,
  };
}

function configIssues(constraints: Constraints, options: SelectionOptions): string | null {
  const parsed = RecommendConfigSchema.safeParse({ constraints, options });
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export function recommend(runs: readonly RunFile[], constraints: Constraints, options: SelectionOptions): RecommendResult {
  // Validation (C7: every switch is an explicit argument; the speed objective requires minAccuracy).
  const issues = configIssues(constraints, options);
  if (issues !== null) return refused(`invalid limits or options: ${issues}`, [], null);
  if (runs.length === 0) return refused("no run files were given", [], null);
  if (runs.length > 1000) return refused("at most 1000 run files can be compared; import fewer files", [], null);

  // Step 1: comparison group.
  const groups = groupRuns(runs, options.allowMixedHardware);
  const groupsAvailable = groups.map((g) => g.info);
  let group: RunGroup | undefined;
  if (options.groupKey !== null) {
    group = groups.find((g) => g.key === options.groupKey);
    if (group === undefined) return refused("the chosen comparison group is not among the imported runs; choose one of groupsAvailable", groupsAvailable, null);
  } else if (groups.length > 1) {
    return refused(
      `the runs form ${groups.length} comparison groups (runtime, endpoint, item set, grader version, protocol or hardware differ); only one group is ever compared, so choose one`,
      groupsAvailable,
      null,
    );
  } else {
    group = groups[0];
  }
  if (group === undefined) return refused("no comparison group", groupsAvailable, null);
  const first = group.runs[0] as RunFile;
  const remote = first.endpointKind === "remote";
  if (remote && !options.acceptRemote) {
    return refused("remote server group: compare it only with acceptRemote (--accept-remote); results describe that server, always with low confidence", groupsAvailable, group);
  }
  if (remote && constraints.requireFullGpu === "auto") {
    return refused("choose requireFullGpu true or false for a remote server", groupsAvailable, group);
  }
  const mixedUsed = groupKeyParts(first, options.allowMixedHardware).hardware === MIXED_HARDWARE;

  // Steps 2-4.
  const selection = selectMeasurements(group);
  // A group union can be larger than a single imported run. Keep the frozen result contract's
  // candidate/noise-set bound; explicit refusal preserves evidence instead of truncating it.
  if (selection.chosen.length > MAX_CANDIDATES) {
    return refused(`the selected group has ${selection.chosen.length} distinct candidates; compare at most ${MAX_CANDIDATES} by importing fewer run files or splitting the selection`, groupsAvailable, group);
  }
  const evaluated = selection.chosen.map(({ run, cr }) => evaluate(run, cr, constraints, options.applyRulings));
  const byKey = [...evaluated].sort((a, b) => cmpStr(a.key, b.key));
  const measured = byKey.filter((e) => e.unmeasuredReason === null);
  const survivors = measured.filter((e) => e.failures.length === 0);

  const contributingRuns = [...new Map(evaluated.map((e): [string, RunFile] => [e.runId, e.run])).values()];
  const newestRun = [...contributingRuns].sort((a, b) => cmpStr(b.createdAt, a.createdAt) || cmpStr(b.runId, a.runId))[0] ?? first;
  const distinctFingerprints = new Set(contributingRuns.map((r) => `${r.fingerprint.hash}:${r.fingerprint.scopeId ?? "-"}`)).size;

  // Trace: superseded, unmeasured, filters (then quality / tie lines below), incompatible.
  const trace: TraceEntry[] = [...selection.superseded];
  for (const e of byKey) if (e.unmeasuredReason !== null) trace.push(unmeasuredEntry(e.key, e.unmeasuredReason));
  for (const e of measured) trace.push(...e.failures);
  if (options.objective === "speed") {
    for (const e of measured) {
      trace.push({ candidateKey: e.key, kind: "quality", filter: null, measured: e.acc.accuracy,
        limit: constraints.minAccuracy, unit: "fraction correct", source: accuracySource(options.applyRulings, e.acc.humanCorrected),
        text: `speed objective: required accuracy floor minAccuracy ${fmtNum(constraints.minAccuracy as number)} enforced; measured accuracy ${fmtNum(e.acc.accuracy as number)}` });
    }
  }

  // Step 6/7: leader, paired tests, noise set, ordering.
  let pick: Evaluated | null = null;
  let runnerUp: Evaluated | null = null;
  let noise: Evaluated[] = [];
  if (survivors.length > 0) {
    const ranked = [...survivors].sort(byAccuracy);
    const leader = ranked[0] as Evaluated;
    const leaderGraders = graderMap(leader);
    const paired = new Map<string, Paired>();
    for (const s of ranked.slice(1)) {
      const d = discordance(first.itemIds, leader.acc.effective, s.acc.effective, leaderGraders);
      const p = signTestOneSided(d.b, d.c);
      paired.set(s.key, { d, p, significant: p < constraints.alpha });
    }
    noise = ranked.filter((s) => s === leader || paired.get(s.key)?.significant === false);
    let ordering: Evaluated[];
    if (options.objective === "quality") {
      const noiseBySpeed = [...noise].sort(bySpeedQuality);
      const rest = ranked.filter((s) => !noise.includes(s)); // already accuracy-ordered (then speed)
      ordering = [...noiseBySpeed, ...rest];
      pick = ordering[0] as Evaluated;
      for (const s of rest) {
        const pr = paired.get(s.key) as Paired;
        trace.push(significantlyLowerEntry(s.key, leader.key, pr.d, pr.p, constraints.alpha));
      }
      for (const s of noiseBySpeed.slice(1)) trace.push(tieSlowerEntry(s.key, tokOf(s), tokOf(pick)));
      if (pick !== leader) {
        const pr = paired.get(pick.key) as Paired;
        trace.push(tiedPickEntry(pick.key, leader.key, pr.d, pr.p));
      }
    } else {
      ordering = [...survivors].sort(bySpeedObjective);
      pick = ordering[0] as Evaluated;
      if (pick !== leader) {
        const pr = paired.get(pick.key) as Paired;
        trace.push(speedCostEntry(pick.key, leader.key, pr.d, pr.p, constraints.alpha));
      }
      for (const s of ordering.slice(1)) trace.push(speedSlowerEntry(s.key, tokOf(s), tokOf(pick)));
    }
    noise = [...noise].sort(bySpeedQuality);
    runnerUp = ordering[1] ?? null;
  }

  // Candidates of other groups (only when a group was chosen among several).
  if (groups.length > 1) {
    for (const g of groups) {
      if (g === group) continue;
      for (const run of g.runs) {
        const diff = groupDifferences(first, run, options.allowMixedHardware);
        for (const cr of run.candidates) trace.push(incompatibleEntry(cr.candidate.key, run.runId, diff));
      }
    }
  }

  // Step 9: confidence.
  const autoGpu = constraints.requireFullGpu === "auto";
  const gpuSkippedNoGpu = autoGpu && measured.some((e) => e.gpu !== null && !e.gpu.applied && e.gpu.skipped === "no-gpu");
  const gpuSkippedUnified = autoGpu ? measured.filter((e) => e.gpu !== null && !e.gpu.applied && e.gpu.skipped === "unified").map((e) => e.key) : [];
  const pickFlaggedItems = pick === null ? 0 : pick.cr.items.filter((r) => r.flags.includes("over_cap") || r.flags.includes("unterminated_think")).length;
  // Details remain visible even if repeated confidence reasons need a collective summary.
  for (const candidate of survivors) {
    if (candidate.speed.spreadMax === null || candidate.speed.spreadMax <= constraints.spreadThreshold) continue;
    trace.push({ candidateKey: candidate.key, kind: "quality", filter: null, measured: candidate.speed.spreadMax,
      limit: constraints.spreadThreshold, unit: "relative spread", source: "(per-prompt max - min) / median",
      text: `confidence evidence: speed spread ${fmtNum(candidate.speed.spreadMax)} exceeds ${fmtNum(constraints.spreadThreshold)}; recommendation confidence is low` });
  }
  for (const key of gpuSkippedUnified) {
    trace.push({ candidateKey: key, kind: "quality", filter: null, measured: "not interpretable", limit: null,
      unit: "fraction in VRAM", source: "/api/ps size_vram / size",
      text: "confidence evidence: unified memory offload is not interpretable; auto full-GPU check skipped for this candidate" });
  }
  if (trace.length > 5000) return refused("the selection exceeds 5000 trace entries; import fewer run files to retain all candidate evidence", groupsAvailable, group);
  const kind: RecommendResult["kind"] = pick === null ? "none" : "pick";
  const noneMessage = "no candidate meets your limits";
  const conf = computeConfidence({
    kind,
    noPickMessage: kind === "none" ? noneMessage : null,
    noiseSetSize: noise.length,
    survivorCount: survivors.length,
    unstable: survivors
      .filter((s) => s.speed.spreadMax !== null && s.speed.spreadMax > constraints.spreadThreshold)
      .map((s) => ({ key: s.key, spreadMax: s.speed.spreadMax as number })),
    spreadThreshold: constraints.spreadThreshold,
    mixedHardware: mixedUsed,
    // Version mismatch describes the comparison group, including a superseded run.
    ollamaVersions: group.runs.map((r) => r.runtimeInfo.ollamaVersion),
    gpuSkippedNoGpu,
    gpuSkippedUnified,
    mock: first.runtime === "mock",
    remote,
    remoteGpuRule: remote ? String(constraints.requireFullGpu) : null,
    pickFlaggedItems,
    itemBankIncomplete: contributingRuns.some((r) => !r.protocol.itemSetComplete),
  });

  // Baselines (ignore limits by design; estimate-only reads weights and free memory only).
  const budget = estimateBudget({
    fingerprint: newestRun.fingerprint,
    availableMemory: newestRun.availableMemory,
    remote,
    mixedHardware: mixedUsed && distinctFingerprints > 1,
  });
  const walk = walkdown(byKey.map((e) => e.candidate), budget);
  const baselines = { estimateOnly: estimateOnly(byKey, walk), fastestOnly: fastestOnly(byKey), accuracyOnly: accuracyOnly(byKey) };

  // D12 speed line (display only) and step 11 command.
  let speedComparison: RecommendResult["speedComparison"] = null;
  if (pick !== null && runnerUp !== null && pick.speed.speedRange !== null && runnerUp.speed.speedRange !== null) {
    const a = pick.speed.speedRange;
    const b = runnerUp.speed.speedRange;
    const clearlyFaster = a.lo > b.hi;
    const text = clearlyFaster
      ? `clearly faster: min ${fmtNum(a.lo)} > max ${fmtNum(b.hi)} tok/s`
      : b.lo > a.hi
        ? `runner-up is clearly faster: min ${fmtNum(b.lo)} > max ${fmtNum(a.hi)} tok/s`
        : `speed ranges overlap (${fmtNum(a.lo)}-${fmtNum(a.hi)} vs ${fmtNum(b.lo)}-${fmtNum(b.hi)} tok/s)`;
    speedComparison = { clearlyFaster, text };
  }
  const cmd = pick === null ? null : safeRunCommand(pick.candidate.tag);

  let message: string;
  if (pick === null) {
    message = `${noneMessage}; every candidate's reasons are in the trace (no least-bad pick)`;
  } else {
    const tiedText = noise.length > 1
      ? options.objective === "quality" ? "; tied within noise, so the fastest of the tied set" : "; accuracy margin is tied within noise"
      : "";
    const corrected = pick.acc.humanCorrected ? " (human-corrected)" : "";
    const cmdText = cmd !== null && cmd.command === null ? ` (no run command shown: ${UNSAFE_TAG_REASON})` : "";
    message = `recommended ${q(pick.candidate.tag)}${corrected} for the ${options.objective} objective${tiedText}${cmdText}`;
  }

  return {
    kind,
    group: { key: group.key, runIds: group.info.runIds },
    groupsAvailable,
    message: clipMessage(message),
    pick: pick === null ? null : pick.key,
    runnerUp: runnerUp === null ? null : runnerUp.key,
    tied: noise.length > 1,
    noiseSet: noise.map((e) => e.key),
    confidence: conf.confidence,
    confidenceReasons: conf.reasons,
    speedComparison,
    perCandidate: byKey.map(summary),
    trace,
    baselines,
    command: cmd === null ? null : cmd.command,
  };
}
