// RunFile v1 (Claude §2.5 as amended by D3, D9, D10, D19, D20, D35).
// Candidate validation is status-discriminated (C4): `measured` needs exactly one result per
// itemIds entry and the full speed repeat set; other statuses hold a bounded unique subset and a
// statusReason. Only `measured` candidates can ever be eligible in recommend.
import { z } from "zod";
import { idString, isoUtc, sha256Hex, nonNegNumber, posInt, messageList } from "./common.js";
import { HardwareFingerprintSchema, AvailableMemorySchema } from "./fingerprint.js";
import { CandidateSchema, SpeedRepeatSchema, MemoryObservationSchema, ItemResultSchema } from "./candidate.js";
import { RulingSchema, checkRulings } from "./rulings.js";
import {
  RAW_ANSWER_MAX_CHARS,
  REDACTION_MAX_EXPANSION,
  SPEED_PROMPT_COUNT,
  SPEED_REPEATS,
  SPEED_WARMUPS,
  MOCK_SCOPE_ID,
} from "../config/defaults.js";

export const RUN_SCHEMA_VERSION = 1;
export const CANDIDATE_STATUSES = ["measured", "incomplete", "failed", "skipped"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const MAX_ITEMS = 200;
export const MAX_CANDIDATES = 64;
export const MAX_RULINGS = 5000;
/** Full speed set per candidate: 3 prompts x (1 warm-up + 3 repeats) = 12 repeats. */
export const SPEED_SET_SIZE = SPEED_PROMPT_COUNT * (SPEED_WARMUPS + SPEED_REPEATS);

/** protocol.caps (D10, D31, D35). genTimeoutMs is configurable (--timeout-gen); all are recorded and hashed. */
export const ProtocolCapsSchema = z
  .object({
    metadataTimeoutMs: posInt,
    headerTimeoutMs: posInt,
    genTimeoutMs: posInt,
    ndjsonLineBytes: posInt,
    streamBytes: posInt,
    rawChars: z.number().int().positive().max(RAW_ANSWER_MAX_CHARS),
  })
  .strict();

export type ProtocolCaps = z.infer<typeof ProtocolCapsSchema>;

/** Requested settings only (never observations). protocolHash = sha256 of its canonical JSON (computed in the CLI). */
export const ProtocolSchema = z
  .object({
    promptSetHash: sha256Hex,
    temperature: z.literal(0),
    seed: z.number().int(),
    numCtx: posInt,
    numPredict: posInt,
    think: z.literal("default"),
    repeats: z.literal(SPEED_REPEATS),
    warmups: z.literal(SPEED_WARMUPS),
    redactionVersion: z.string().min(1).max(50),
    itemSetComplete: z.boolean(),
    caps: ProtocolCapsSchema,
  })
  .strict();

export type Protocol = z.infer<typeof ProtocolSchema>;

export const CandidateRunSchema = z
  .object({
    candidate: CandidateSchema,
    status: z.enum(CANDIDATE_STATUSES),
    statusReason: z.string().min(1).max(500).nullable(),
    speed: z.array(SpeedRepeatSchema).max(SPEED_SET_SIZE),
    memory: z.array(MemoryObservationSchema).max(64),
    nvidiaPeakBytes: nonNegNumber.nullable(),
    items: z.array(ItemResultSchema).max(MAX_ITEMS),
    wallClockMs: nonNegNumber,
    loadedByRun: z.boolean(),
  })
  .strict();

export type CandidateRun = z.infer<typeof CandidateRunSchema>;

const RunFileBaseSchema = z
  .object({
    schemaVersion: z.literal(RUN_SCHEMA_VERSION),
    runId: idString,
    createdAt: isoUtc,
    tool: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(50) }).strict(),
    runtime: z.enum(["mock", "ollama"]),
    synthetic: z.boolean(),
    seed: z.number().int().nullable(),
    remote: z.boolean(),
    endpointKind: z.enum(["loopback", "remote", "mock"]),
    runtimeInfo: z.object({ ollamaVersion: z.string().min(1).max(50).nullable() }).strict(),
    fingerprint: HardwareFingerprintSchema,
    availableMemory: AvailableMemorySchema,
    itemSetHash: sha256Hex,
    itemIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_ITEMS),
    graderVersion: z.string().min(1).max(100),
    protocol: ProtocolSchema,
    protocolHash: sha256Hex,
    flags: messageList,
    warnings: messageList,
    candidates: z.array(CandidateRunSchema).max(MAX_CANDIDATES),
    rulings: z.array(RulingSchema).max(MAX_RULINGS),
  })
  .strict();

type Ctx = z.RefinementCtx;
type Path = (string | number)[];

function addIssue(ctx: Ctx, path: Path, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

/** Duplicate values in a list, in first-seen order. */
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dup.add(v);
    else seen.add(v);
  }
  return [...dup];
}

function checkFlags(run: z.infer<typeof RunFileBaseSchema>, ctx: Ctx): void {
  const fp = run.fingerprint;
  if (run.runtime === "mock") {
    if (!run.synthetic) addIssue(ctx, ["synthetic"], "runtime mock requires synthetic true");
    if (fp.source !== "mock") addIssue(ctx, ["fingerprint", "source"], "runtime mock requires fingerprint.source mock");
    if (run.endpointKind !== "mock") addIssue(ctx, ["endpointKind"], "runtime mock requires endpointKind mock");
    if (run.remote) addIssue(ctx, ["remote"], "runtime mock is never remote");
    if (fp.scopeId !== MOCK_SCOPE_ID) addIssue(ctx, ["fingerprint", "scopeId"], `runtime mock requires scopeId "${MOCK_SCOPE_ID}"`);
    if (run.availableMemory.source !== "mock" && run.availableMemory.source !== "unavailable") {
      addIssue(ctx, ["availableMemory", "source"], "runtime mock records availableMemory.source mock or unavailable");
    }
  } else {
    if (fp.source === "mock") addIssue(ctx, ["fingerprint", "source"], "fingerprint.source mock requires runtime mock");
    if (run.endpointKind === "mock") addIssue(ctx, ["endpointKind"], "endpointKind mock requires runtime mock");
    if (run.availableMemory.source === "mock") addIssue(ctx, ["availableMemory", "source"], "availableMemory.source mock requires runtime mock");
  }
  const remoteKind = run.endpointKind === "remote";
  if (run.remote !== remoteKind) addIssue(ctx, ["remote"], "remote is true exactly when endpointKind is remote");
  if (run.remote) {
    if (fp.source !== "remote-unknown") addIssue(ctx, ["fingerprint", "source"], "a remote run records a remote-unknown fingerprint");
    if (fp.scopeId !== run.runId) addIssue(ctx, ["fingerprint", "scopeId"], "a remote-unknown fingerprint has scopeId equal to runId");
    if (run.availableMemory.source !== "unavailable") addIssue(ctx, ["availableMemory", "source"], "a remote run records availableMemory.source unavailable");
  } else if (fp.source === "remote-unknown") {
    addIssue(ctx, ["fingerprint", "source"], "a remote-unknown fingerprint requires a remote run");
  }
  // Top-level `seed` is the synthetic-data seed (mock generator); protocol.seed is the generation seed.
}

function checkCandidate(run: z.infer<typeof RunFileBaseSchema>, c: CandidateRun, i: number, ctx: Ctx): void {
  const base: Path = ["candidates", i];
  const itemSet = new Set(run.itemIds);
  // caps.rawChars is the pre-redaction answer cap (D9); redaction may lengthen the stored text.
  const rawCap = run.protocol.caps.rawChars;
  const storedRawCap = REDACTION_MAX_EXPANSION * rawCap;

  // Items: never duplicate or foreign ids, whatever the status.
  const itemIds = c.items.map((r) => r.itemId);
  for (const d of duplicates(itemIds)) addIssue(ctx, [...base, "items"], `duplicate item result for ${d}`);
  c.items.forEach((r, j) => {
    if (!itemSet.has(r.itemId)) addIssue(ctx, [...base, "items", j, "itemId"], `item ${r.itemId} is not in itemIds`);
    if (r.graderVersion !== run.graderVersion) addIssue(ctx, [...base, "items", j, "graderVersion"], "item graderVersion must equal the run graderVersion");
    if (r.raw.length > storedRawCap) {
      addIssue(ctx, [...base, "items", j, "raw"], `raw exceeds ${REDACTION_MAX_EXPANSION} x protocol.caps.rawChars (${storedRawCap} chars after redaction)`);
    }
  });

  // Speed: unique (promptId, repeat) pairs, at most SPEED_PROMPT_COUNT prompts.
  const pairKeys = c.speed.map((r) => `${r.promptId}\u0000${r.repeat}`);
  if (duplicates(pairKeys).length > 0) addIssue(ctx, [...base, "speed"], "duplicate (promptId, repeat) pair");
  const prompts = new Map<string, Set<number>>();
  for (const r of c.speed) {
    const s = prompts.get(r.promptId) ?? new Set<number>();
    s.add(r.repeat);
    prompts.set(r.promptId, s);
  }
  if (prompts.size > SPEED_PROMPT_COUNT) addIssue(ctx, [...base, "speed"], `at most ${SPEED_PROMPT_COUNT} speed prompts`);

  if (c.status === "measured") {
    if (c.items.length !== run.itemIds.length) {
      addIssue(ctx, [...base, "items"], `a measured candidate has exactly one result per item id (${run.itemIds.length}); found ${c.items.length}`);
    } else {
      const have = new Set(itemIds);
      const missing = run.itemIds.filter((id) => !have.has(id));
      if (missing.length > 0) addIssue(ctx, [...base, "items"], `a measured candidate is missing results for ${missing.slice(0, 5).join(", ")}`);
    }
    const repeatsPerPrompt = SPEED_WARMUPS + SPEED_REPEATS;
    const full =
      c.speed.length === SPEED_SET_SIZE &&
      prompts.size === SPEED_PROMPT_COUNT &&
      [...prompts.values()].every((s) => s.size === repeatsPerPrompt);
    if (!full) {
      addIssue(ctx, [...base, "speed"], `a measured candidate has the full speed set: ${SPEED_PROMPT_COUNT} prompts x (${SPEED_WARMUPS} warm-up + ${SPEED_REPEATS} repeats)`);
    }
  } else if (c.statusReason === null) {
    addIssue(ctx, [...base, "statusReason"], `a ${c.status} candidate states its statusReason`);
  }
}

export const RunFileSchema = RunFileBaseSchema.superRefine((run, ctx) => {
  for (const d of duplicates(run.itemIds)) addIssue(ctx, ["itemIds"], `duplicate item id ${d}`);
  for (const d of duplicates(run.candidates.map((c) => c.candidate.key))) addIssue(ctx, ["candidates"], `duplicate candidate key ${d}`);
  checkFlags(run, ctx);
  run.candidates.forEach((c, i) => checkCandidate(run, c, i, ctx));

  const correctByCandidate = new Map<string, Map<string, boolean>>();
  for (const c of run.candidates) {
    correctByCandidate.set(c.candidate.key, new Map(c.items.map((r): [string, boolean] => [r.itemId, r.correct])));
  }
  for (const issue of checkRulings(run.rulings, { runId: run.runId, correctByCandidate })) {
    addIssue(ctx, issue.path, issue.message);
  }
});

export type RunFile = z.infer<typeof RunFileSchema>;
