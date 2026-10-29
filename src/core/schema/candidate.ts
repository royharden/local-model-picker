// Candidate identity, speed repeats, memory observations and per-item results (Claude §2.5, D2, D9, D33).
import { z } from "zod";
import { nonNegNumber, nonNegInt, fraction } from "./common.js";
import { REDACTED_RAW_MAX_CHARS, SPEED_REPEATS, SPEED_WARMUPS } from "../config/defaults.js";

/**
 * Model tag as reported by the runtime. Treated as untrusted data (scenario s09): any characters,
 * bounded length. Shown as text only; `safeRunCommand` decides whether a command may be printed.
 */
export const tagString = z.string().min(1).max(300);

/** Candidate key = `${tag}@${digest.slice(0, 12)}`; it inherits the tag's untrusted characters. */
export const candidateKeyString = z.string().min(1).max(320);

export function candidateKeyOf(tag: string, digest: string): string {
  return `${tag}@${digest.slice(0, 12)}`;
}

export const CandidateSchema = z
  .object({
    key: candidateKeyString,
    tag: tagString,
    digest: z.string().regex(/^[0-9a-f]{12,128}$/, "digest must be lowercase hex (as /api/tags reports it)"),
    family: z.string().min(1).max(100).nullable(),
    parameterSize: z.string().min(1).max(50).nullable(),
    quantization: z.string().min(1).max(50).nullable(),
    sizeBytes: nonNegNumber,
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.key !== candidateKeyOf(c.tag, c.digest)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["key"], message: "key must equal tag + '@' + first 12 chars of digest" });
    }
  });

export type Candidate = z.infer<typeof CandidateSchema>;

/** Final-chunk numeric fields as received (durations in nanoseconds), at most 32 entries. */
export const UsageRawSchema = z
  .record(z.string().min(1).max(64), z.number().finite())
  .refine((r) => Object.keys(r).length <= 32, "usageRaw holds at most 32 fields");

const MAX_REPEAT_INDEX = SPEED_WARMUPS + SPEED_REPEATS - 1;

/**
 * One streamed generation of a speed prompt. repeat 0 is the warm-up (dropped from aggregation).
 * Conversions ns -> ms and counts/s happen in one place (src/core/providers/ollama-parse.ts).
 * Duration/count fields are null only when the stream gave no usable final chunk.
 */
export const SpeedRepeatSchema = z
  .object({
    promptId: z.string().min(1).max(100),
    repeat: z.number().int().min(0).max(MAX_REPEAT_INDEX),
    valid: z.boolean(),
    invalidReason: z.string().min(1).max(500).nullable(),
    ttftMs: nonNegNumber.nullable(),
    ttfaMs: nonNegNumber.nullable(),
    loadMs: nonNegNumber.nullable(),
    promptEvalCount: nonNegInt.nullable(),
    promptEvalMs: nonNegNumber.nullable(),
    evalCount: nonNegInt.nullable(),
    evalMs: nonNegNumber.nullable(),
    genTokPerSec: nonNegNumber.nullable(),
    promptTokPerSec: nonNegNumber.nullable(),
    thinkingObserved: z.boolean(),
    usageRaw: UsageRawSchema.nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (r.valid) {
      // An invalid repeat never becomes a speed of 0; a valid one has a positive generation rate.
      if (r.invalidReason !== null) issue("invalidReason", "a valid repeat has invalidReason null");
      if (r.evalCount === null || r.evalCount <= 0) issue("evalCount", "a valid repeat has evalCount > 0");
      if (r.evalMs === null || r.evalMs <= 0) issue("evalMs", "a valid repeat has evalMs > 0");
      if (r.genTokPerSec === null || r.genTokPerSec <= 0) issue("genTokPerSec", "a valid repeat has genTokPerSec > 0");
      if (r.loadMs === null) issue("loadMs", "a valid repeat records loadMs (0 is allowed)");
      if (r.promptEvalCount === null) issue("promptEvalCount", "a valid repeat records promptEvalCount (0 is allowed)");
      if (r.promptEvalMs === null) issue("promptEvalMs", "a valid repeat records promptEvalMs (0 is allowed)");
      if (r.ttftMs === null) issue("ttftMs", "a valid repeat records ttftMs");
      if (r.ttfaMs === null) issue("ttfaMs", "a valid repeat produced answer content, so ttfaMs is set");
    } else if (r.invalidReason === null) {
      issue("invalidReason", "an invalid repeat states its invalidReason");
    }
  });

export type SpeedRepeat = z.infer<typeof SpeedRepeatSchema>;

/** Allowed absolute difference between a stored offloadFraction and size_vram / size. */
export const OFFLOAD_FRACTION_TOLERANCE = 1e-9;

/** A /api/ps sample. offloadFraction = size_vram / size when valid (size > 0, 0 <= size_vram <= size), else null. */
export const MemoryObservationSchema = z
  .object({
    phase: z.enum(["after-load", "after-repeat"]),
    sizeBytes: nonNegNumber,
    sizeVramBytes: nonNegNumber,
    offloadFraction: fraction.nullable(),
    source: z.literal("api/ps"),
  })
  .strict()
  .superRefine((m, ctx) => {
    // sizeVramBytes >= 0 is already enforced by nonNegNumber.
    const valid = m.sizeBytes > 0 && m.sizeVramBytes <= m.sizeBytes;
    if (valid) {
      const expected = m.sizeVramBytes / m.sizeBytes;
      if (m.offloadFraction === null || Math.abs(m.offloadFraction - expected) > OFFLOAD_FRACTION_TOLERANCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["offloadFraction"],
          message: `offloadFraction must equal sizeVramBytes / sizeBytes (${expected}) when sizeBytes > 0 and sizeVramBytes <= sizeBytes`,
        });
      }
    } else if (m.offloadFraction !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["offloadFraction"],
        message: "offloadFraction is null unless sizeBytes > 0 and 0 <= sizeVramBytes <= sizeBytes",
      });
    }
  });

export type MemoryObservation = z.infer<typeof MemoryObservationSchema>;

export const ITEM_FLAGS = ["over_cap", "unterminated_think", "empty", "ambiguous"] as const;
export type ItemFlag = (typeof ITEM_FLAGS)[number];

/**
 * One graded item. `raw` is exactly the graded text (D9): structured thinking excluded, first
 * 8,000 chars, redacted. No answerText is stored (D33); graders derive it from `raw` on demand.
 * The 8,000-char cap applies before redaction (and decides `truncated` / `over_cap`); redaction
 * can lengthen the text, so the stored bound is REDACTED_RAW_MAX_CHARS.
 */
export const ItemResultSchema = z
  .object({
    itemId: z.string().min(1).max(100),
    raw: z.string().max(REDACTED_RAW_MAX_CHARS),
    truncated: z.boolean(),
    flags: z
      .array(z.enum(ITEM_FLAGS))
      .max(ITEM_FLAGS.length)
      .refine((f) => new Set(f).size === f.length, "flags are unique"),
    extracted: z.string().max(1000).nullable(),
    correct: z.boolean(),
    graderId: z.string().min(1).max(100),
    graderVersion: z.string().min(1).max(100),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.truncated !== r.flags.includes("over_cap")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "truncated is true exactly when flags contains over_cap" });
    }
  });

export type ItemResult = z.infer<typeof ItemResultSchema>;
