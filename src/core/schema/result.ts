// RecommendResult and TraceEntry (Claude §2.5, D12, D13, D32). Produced by recommend() in M3;
// the schema lets tests, the CLI --json output and the viewer validate the shape.
import { z } from "zod";
import { fraction, nonNegNumber } from "./common.js";
import { candidateKeyString } from "./candidate.js";

export const TRACE_KINDS = ["filter", "quality", "tie-slower", "unmeasured", "superseded", "incompatible"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export const FILTER_NAMES = ["minTokPerSec", "maxTtftMs", "maxMemoryGB", "requireFullGpu", "minAccuracy"] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

/**
 * One "why not" (or why) line. Filter entries always carry measured, limit, unit and source;
 * a measurement that is missing is recorded as measured "not measured", never as 0.
 */
export const TraceEntrySchema = z
  .object({
    candidateKey: candidateKeyString,
    kind: z.enum(TRACE_KINDS),
    filter: z.enum(FILTER_NAMES).nullable(),
    measured: z.union([z.number().finite(), z.string().max(200)]).nullable(),
    limit: z.union([z.number().finite(), z.string().max(200), z.boolean()]).nullable(),
    unit: z.string().max(50).nullable(),
    source: z.string().max(200).nullable(),
    text: z.string().min(1).max(1000),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.kind === "filter" && (t.filter === null || t.measured === null || t.limit === null || t.unit === null || t.source === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "a filter trace entry names filter, measured, limit, unit and source" });
    }
  });

export type TraceEntry = z.infer<typeof TraceEntrySchema>;

export const IntervalSchema = z.object({ lo: fraction, hi: fraction }).strict();

export const PerPromptSpeedSchema = z
  .object({
    promptId: z.string().min(1).max(100),
    validRepeats: z.number().int().nonnegative(),
    medianTokPerSec: nonNegNumber.nullable(),
    minTokPerSec: nonNegNumber.nullable(),
    maxTokPerSec: nonNegNumber.nullable(),
    spread: nonNegNumber.nullable(),
    medianLatencyMs: nonNegNumber.nullable(),
  })
  .strict();

export type PerPromptSpeed = z.infer<typeof PerPromptSpeedSchema>;

export const CandidateSummarySchema = z
  .object({
    key: candidateKeyString,
    runId: z.string().min(1).max(200),
    status: z.enum(["measured", "incomplete", "failed", "skipped"]),
    accuracy: fraction.nullable(),
    correct: z.number().int().nonnegative(),
    n: z.number().int().nonnegative(),
    wilson95: IntervalSchema.nullable(),
    tokPerSec: nonNegNumber.nullable(),
    /** D12 descriptive bounds: [min over prompts of per-prompt min, min over prompts of per-prompt max]. */
    speedRange: z.object({ lo: nonNegNumber, hi: nonNegNumber }).strict().nullable(),
    perPrompt: z.array(PerPromptSpeedSchema).max(10),
    ttftMs: nonNegNumber.nullable(),
    latencyMetric: z.enum(["ttft", "ttfa"]).nullable(),
    memoryGB: nonNegNumber.nullable(),
    offload: fraction.nullable(),
    spreadMax: nonNegNumber.nullable(),
    humanCorrected: z.boolean(),
  })
  .strict();

export type CandidateSummary = z.infer<typeof CandidateSummarySchema>;

export const GroupInfoSchema = z
  .object({
    key: z.string().min(1).max(2000),
    runIds: z.array(z.string().min(1).max(200)).max(1000),
    candidateCount: z.number().int().nonnegative(),
    runtime: z.enum(["mock", "ollama"]),
    endpointKind: z.enum(["loopback", "remote", "mock"]),
    fingerprintHash: z.string().min(1).max(50),
  })
  .strict();

export type GroupInfo = z.infer<typeof GroupInfoSchema>;

export const BaselineRowSchema = z
  .object({
    method: z.enum(["estimate-only", "fastest-only", "accuracy-only"]),
    label: z.string().min(1).max(200),
    available: z.boolean(),
    pick: candidateKeyString.nullable(),
    reason: z.string().max(500).nullable(),
    /** Measured limits the baseline's pick violates (baselines ignore user constraints by design). */
    violations: z.array(z.enum(FILTER_NAMES)).max(FILTER_NAMES.length),
  })
  .strict();

export type BaselineRow = z.infer<typeof BaselineRowSchema>;

export const RecommendResultSchema = z
  .object({
    kind: z.enum(["pick", "none", "refused"]),
    group: z.object({ key: z.string().min(1).max(2000), runIds: z.array(z.string().min(1).max(200)).max(1000) }).strict().nullable(),
    groupsAvailable: z.array(GroupInfoSchema).max(1000),
    message: z.string().min(1).max(2000),
    pick: candidateKeyString.nullable(),
    runnerUp: candidateKeyString.nullable(),
    tied: z.boolean(),
    noiseSet: z.array(candidateKeyString).max(64),
    confidence: z.enum(["high", "low"]),
    confidenceReasons: z.array(z.string().min(1).max(500)).max(50),
    /** D12: display only; never changes confidence. */
    speedComparison: z
      .object({ clearlyFaster: z.boolean(), text: z.string().min(1).max(500) })
      .strict()
      .nullable(),
    perCandidate: z.array(CandidateSummarySchema).max(256),
    trace: z.array(TraceEntrySchema).max(5000),
    baselines: z
      .object({ estimateOnly: BaselineRowSchema, fastestOnly: BaselineRowSchema, accuracyOnly: BaselineRowSchema })
      .strict(),
    command: z.string().max(220).nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (r.kind !== "pick" && (r.pick !== null || r.runnerUp !== null || r.command !== null)) {
      issue("pick", "none/refused results have no pick, runner-up or command");
    }
    if (r.kind === "pick" && r.pick === null) issue("pick", "a pick result names its pick");
    // D32: none/refused are always low confidence with an explicit reason.
    if (r.kind !== "pick" && (r.confidence !== "low" || r.confidenceReasons.length === 0)) {
      issue("confidence", "none/refused results have confidence low with an explicit reason");
    }
    if (r.confidence === "low" && r.confidenceReasons.length === 0) issue("confidenceReasons", "low confidence lists its reasons");
    if (r.tied !== r.noiseSet.length > 1) issue("tied", "tied is true exactly when the noise set has more than one member");
  });

export type RecommendResult = z.infer<typeof RecommendResultSchema>;
