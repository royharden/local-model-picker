// Run plan (dry-run output; D30). Lists models, the 30 items, 3 prompts x (1 warm-up + 3 repeats),
// generation settings and caps, the output path, a rough duration with its basis, and an estimate of
// the run-file size. When the estimate exceeds the 10,000,000-byte cap, the dry-run says so with the
// instruction to pass fewer --models, and `run --yes` refuses to start (no sweep that cannot be saved).
// The pre-write size check in cli/io/write.ts stays as the exact backstop.
import type { ModelSummary, Protocol } from "../src/core/index.js";
import { MAX_CANDIDATES, RUN_FILE_MAX_BYTES, SPEED_PROMPT_COUNT, SPEED_REPEATS, SPEED_WARMUPS } from "../src/core/index.js";

/**
 * Size model of one run file. Basis: every answer reaches the stored cap (protocol.caps.rawChars) at
 * 2 bytes per character after JSON escaping (newlines, quotes, some non-ASCII), plus fixed per-item,
 * per-repeat and per-candidate overheads measured from the schema shape. Answers made mostly of
 * multi-byte or escaped characters can exceed it; the exact check before writing still applies.
 */
export const SIZE_MODEL = {
  baseBytes: 20_000,
  perCandidateBytes: 6_000,
  perRepeatBytes: 900,
  perItemOverheadBytes: 400,
  bytesPerRawChar: 2,
} as const;

export function estimateRunFileBytes(candidates: number, items: number, rawChars: number): number {
  const repeats = SPEED_PROMPT_COUNT * (SPEED_WARMUPS + SPEED_REPEATS);
  const perCandidate =
    SIZE_MODEL.perCandidateBytes +
    repeats * SIZE_MODEL.perRepeatBytes +
    items * (SIZE_MODEL.perItemOverheadBytes + rawChars * SIZE_MODEL.bytesPerRawChar);
  return SIZE_MODEL.baseBytes + candidates * perCandidate;
}

/** Largest candidate count whose estimate fits the cap. */
export function maxCandidatesForCap(items: number, rawChars: number): number {
  let n = 0;
  while (n < MAX_CANDIDATES && estimateRunFileBytes(n + 1, items, rawChars) <= RUN_FILE_MAX_BYTES) n++;
  return n;
}

/** Assumptions for the live duration estimate (labelled as such; the mock runs on a virtual clock). */
export const DURATION_BASIS = {
  assumedTokPerSec: 10,
  assumedLoadSec: 10,
} as const;

export interface RunPlan {
  runtime: "mock" | "ollama";
  endpointKind: "mock" | "loopback" | "remote";
  models: Array<{ tag: string; sizeBytes: number }>;
  itemCount: number;
  promptIds: string[];
  requestsPerCandidate: number;
  totalRequests: number;
  protocol: Protocol;
  outDir: string;
  outFile: string;
  estimatedBytes: number;
  overCap: boolean;
  durationText: string;
  /** reasons `run --yes` must not start; empty when it may */
  refusals: string[];
}

export interface PlanInput {
  runtime: "mock" | "ollama";
  endpointKind: "mock" | "loopback" | "remote";
  models: readonly ModelSummary[];
  itemCount: number;
  promptIds: readonly string[];
  protocol: Protocol;
  outDir: string;
  outFile: string;
}

function minutes(sec: number): string {
  return sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`;
}

export function buildRunPlan(input: PlanInput): RunPlan {
  const requestsPerCandidate = input.promptIds.length * (SPEED_WARMUPS + SPEED_REPEATS) + input.itemCount;
  const n = input.models.length;
  const estimatedBytes = estimateRunFileBytes(n, input.itemCount, input.protocol.caps.rawChars);
  const overCap = estimatedBytes > RUN_FILE_MAX_BYTES;
  const refusals: string[] = [];
  if (n === 0) refusals.push("no installed models selected; nothing to measure");
  if (n > MAX_CANDIDATES) refusals.push(`a run measures at most ${MAX_CANDIDATES} candidates; pass fewer --models`);
  if (overCap) {
    const fit = maxCandidatesForCap(input.itemCount, input.protocol.caps.rawChars);
    refusals.push(
      `the run file could reach about ${estimatedBytes} bytes, over the ${RUN_FILE_MAX_BYTES}-byte limit; pass fewer --models (at most ${fit} per run)`,
    );
  }
  let durationText: string;
  if (input.runtime === "mock") {
    durationText = "a few seconds (mock: virtual clock, no inference)";
  } else {
    const perRequestSec = input.protocol.numPredict / DURATION_BASIS.assumedTokPerSec;
    const sec = n * (DURATION_BASIS.assumedLoadSec + requestsPerCandidate * perRequestSec);
    durationText =
      n === 0
        ? "unknown"
        : `rough upper estimate ${minutes(sec)} (basis: every response reaches num_predict ${input.protocol.numPredict} tokens at ${DURATION_BASIS.assumedTokPerSec} tok/s, ${DURATION_BASIS.assumedLoadSec} s load per model; real time depends on the models)`;
  }
  return {
    runtime: input.runtime,
    endpointKind: input.endpointKind,
    models: input.models.map((m) => ({ tag: m.name, sizeBytes: m.sizeBytes })),
    itemCount: input.itemCount,
    promptIds: [...input.promptIds],
    requestsPerCandidate,
    totalRequests: requestsPerCandidate * n,
    protocol: input.protocol,
    outDir: input.outDir,
    outFile: input.outFile,
    estimatedBytes,
    overCap,
    durationText,
    refusals,
  };
}

/** Plan as printable lines (the caller sanitises before printing). */
export function formatPlan(plan: RunPlan): string[] {
  const p = plan.protocol;
  const lines: string[] = [];
  if (plan.runtime === "mock") lines.push("MOCK DATA: the mock runtime serves synthetic responses (not a measurement)");
  if (plan.endpointKind === "remote") lines.push("REMOTE endpoint: results describe that server, never this machine");
  lines.push(`Runtime: ${plan.runtime} (${plan.endpointKind})`);
  lines.push(`Models (${plan.models.length}, measured serially):`);
  for (const m of plan.models) lines.push(`  ${m.tag}  ${(m.sizeBytes / 1e9).toFixed(2)} GB`);
  lines.push(`Items: ${plan.itemCount} (one temperature-0 response each)`);
  lines.push(`Speed: ${plan.promptIds.length} prompts x (${SPEED_WARMUPS} warm-up + ${SPEED_REPEATS} measured repeats): ${plan.promptIds.join(", ")}`);
  lines.push(`Requests: ${plan.requestsPerCandidate} per model, ${plan.totalRequests} total`);
  lines.push(`Settings: temperature ${p.temperature}, seed ${p.seed}, num_ctx ${p.numCtx}, num_predict ${p.numPredict}, think ${p.think} (PROPOSED defaults)`);
  lines.push(
    `Caps: metadata ${p.caps.metadataTimeoutMs} ms, headers ${p.caps.headerTimeoutMs} ms, generation ${p.caps.genTimeoutMs} ms, line ${p.caps.ndjsonLineBytes} B, stream ${p.caps.streamBytes} B, stored answer ${p.caps.rawChars} chars`,
  );
  lines.push(`Output: ${plan.outFile} (inside ${plan.outDir})`);
  lines.push(`Estimated file size: about ${plan.estimatedBytes} bytes (limit ${RUN_FILE_MAX_BYTES})`);
  lines.push(`Duration: ${plan.durationText}`);
  for (const r of plan.refusals) lines.push(`Cannot run: ${r}`);
  return lines;
}
