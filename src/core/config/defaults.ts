// Default limits and protocol constants. Every user-facing limit is a labelled proposal
// (// PROPOSED), surfaced in the UI and CLI as "proposed default". Nothing here is inferred
// from the machine; maxMemoryGB in particular is never guessed.
import type { Constraints, SelectionOptions, Objective } from "../schema/constraints.js";

/** Hard cap on run-file size, checked before JSON.parse on import and on serialised bytes before every write. */
export const RUN_FILE_MAX_BYTES = 10_000_000;

/**
 * Answer cap (D9): the first N characters of the answer stream, taken BEFORE redaction. Also the
 * upper bound of protocol.caps.rawChars. `truncated` / `over_cap` are decided against this cap.
 */
export const RAW_ANSWER_MAX_CHARS = 8000;

/**
 * Redaction can lengthen text (`::1` -> `<ipv6>`, a two-character host literal -> `<host>`); the
 * worst case of the current rules is 3x (a two-character match replaced by a six-character token,
 * adjacent repeats need no separator only when the literal itself is non-alphanumeric, e.g. `--`). Stored `raw` (capped, then
 * redacted) may therefore be up to this factor times the pre-redaction cap.
 */
export const REDACTION_MAX_EXPANSION = 4;

/** Bound on stored `raw` after redaction: REDACTION_MAX_EXPANSION x RAW_ANSWER_MAX_CHARS = 32,000. */
export const REDACTED_RAW_MAX_CHARS = REDACTION_MAX_EXPANSION * RAW_ANSWER_MAX_CHARS;

/** Speed protocol: 3 prompts x (1 warm-up + 3 measured repeats). Fixed in schemaVersion 1. */
export const SPEED_PROMPT_COUNT = 3;
export const SPEED_REPEATS = 3;
export const SPEED_WARMUPS = 1;

/** Fixed scope id of the synthetic mock fingerprint, so bundled samples group identically on any machine. */
export const MOCK_SCOPE_ID = "mock-v1";

/** Default author of a ruling made in the viewer (D20). */
export const DEFAULT_RULING_BY = "local-user";

/** z for a two-sided 95% Wilson interval. */
export const WILSON_Z_95 = 1.959964;

/** Transport and storage caps recorded in protocol.caps (D10, D31, D35). */
export const DEFAULT_PROTOCOL_CAPS = {
  metadataTimeoutMs: 10_000, // PROPOSED: /api/tags, /api/show, /api/ps, /api/version
  headerTimeoutMs: 30_000, // PROPOSED: time to receive response headers on a generation request
  genTimeoutMs: 300_000, // PROPOSED: whole streamed generation (--timeout-gen)
  ndjsonLineBytes: 262_144, // PROPOSED: 256 KB per NDJSON line
  streamBytes: 1_048_576, // PROPOSED: 1 MB per streamed response
  rawChars: RAW_ANSWER_MAX_CHARS, // stored answer prefix (D9)
} as const;

/** Generation settings written into protocol by the CLI. */
export const DEFAULT_GENERATION = {
  temperature: 0,
  seed: 42, // PROPOSED: fixed generation seed
  numCtx: 4096, // PROPOSED: context window for every request
  numPredict: 512, // PROPOSED: capped output tokens per request
  think: "default",
} as const;

const baseConstraints = {
  minTokPerSec: 8, // PROPOSED: minimum generation throughput (min of per-prompt medians), tokens/s
  maxTtftMs: 5000, // PROPOSED: maximum latency (max of per-prompt medians; time to first answer on thinking models), ms
  maxMemoryGB: null, // never inferred; the user sets it or it is not applied
  requireFullGpu: "auto", // PROPOSED: resolved per D14
  fullGpuThreshold: 0.95, // PROPOSED: minimum observed size_vram / size for "fully on GPU"
  alpha: 0.05, // PROPOSED: one-sided exact sign test significance level
  spreadThreshold: 0.25, // PROPOSED: (max - min) / median of a prompt's repeats above this -> low confidence
} as const;

/** Quality objective: no accuracy floor by default. */
export const DEFAULT_CONSTRAINTS_QUALITY: Constraints = {
  ...baseConstraints,
  minAccuracy: null, // PROPOSED: no floor for the quality objective
};

/** Speed objective: minAccuracy is required and prefilled. */
export const DEFAULT_CONSTRAINTS_SPEED: Constraints = {
  ...baseConstraints,
  minAccuracy: 0.6, // PROPOSED: required accuracy floor for the speed objective
};

export function defaultConstraints(objective: Objective): Constraints {
  return objective === "speed" ? { ...DEFAULT_CONSTRAINTS_SPEED } : { ...DEFAULT_CONSTRAINTS_QUALITY };
}

export const DEFAULT_SELECTION_OPTIONS: SelectionOptions = {
  objective: "quality",
  groupKey: null,
  allowMixedHardware: false,
  acceptRemote: false,
  applyRulings: true,
};
