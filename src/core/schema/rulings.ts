// Append-only grader overrides, rulings-shaped (Claude §2.5 + D20).
// Replay is by `seq`, never by `at`. A ruling changes only correctness, never speed, memory,
// hardware or hashes.
import { z } from "zod";
import { idString, isoUtc } from "./common.js";
import { candidateKeyString } from "./candidate.js";
import { DEFAULT_RULING_BY } from "../config/defaults.js";

export const RulingSchema = z
  .object({
    id: idString,
    seq: z.number().int().positive(),
    previousRulingId: idString.nullable(),
    kind: z.literal("grader_override"),
    runId: idString,
    candidateKey: candidateKeyString,
    itemId: z.string().min(1).max(100),
    originalCorrect: z.boolean(),
    overrideCorrect: z.boolean(),
    correctedExtraction: z.string().max(1000).nullable(),
    reason: z.string().min(1).max(500),
    by: z.string().min(1).max(100).default(DEFAULT_RULING_BY),
    at: isoUtc,
  })
  .strict();

export type Ruling = z.infer<typeof RulingSchema>;

export interface RulingIssue {
  path: (string | number)[];
  message: string;
}

/** What a run file offers for rulings to refer to. */
export interface RulingContext {
  runId: string;
  /**
   * candidate key -> (item id -> the graded `correct` of that candidate's ItemResult). An item id
   * is a key exactly when the candidate has a result for it.
   */
  correctByCandidate: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
}

/**
 * Structural checks across the rulings array (path is relative to the run file root):
 * unique ids, seq unique and strictly increasing in array order, references name this run and an
 * existing candidate + item result, originalCorrect equals that result's graded `correct`,
 * previousRulingId names an earlier ruling for the same pair.
 */
export function checkRulings(rulings: readonly Ruling[], ctx: RulingContext): RulingIssue[] {
  const issues: RulingIssue[] = [];
  const earlier = new Map<string, Ruling>();
  let lastSeq = 0;
  rulings.forEach((r, i) => {
    const at = (field: string, message: string): void => {
      issues.push({ path: ["rulings", i, field], message });
    };
    if (earlier.has(r.id)) at("id", `duplicate ruling id ${r.id}`);
    if (r.seq <= lastSeq) at("seq", `seq ${r.seq} must be greater than the previous seq ${lastSeq} (unique, strictly increasing)`);
    lastSeq = Math.max(lastSeq, r.seq);
    if (r.runId !== ctx.runId) at("runId", `ruling names run ${r.runId}, but this file is run ${ctx.runId}`);
    const items = ctx.correctByCandidate.get(r.candidateKey);
    const graded = items?.get(r.itemId);
    if (items === undefined) {
      at("candidateKey", "ruling names a candidate that is not in this run");
    } else if (graded === undefined) {
      at("itemId", "ruling names an item with no result for this candidate");
    } else if (r.originalCorrect !== graded) {
      at("originalCorrect", `originalCorrect (${String(r.originalCorrect)}) must equal the graded correct (${String(graded)}) of this item result`);
    }
    if (r.previousRulingId !== null) {
      const prev = earlier.get(r.previousRulingId);
      if (prev === undefined) {
        at("previousRulingId", "previousRulingId must name an earlier ruling in this file");
      } else if (prev.candidateKey !== r.candidateKey || prev.itemId !== r.itemId) {
        at("previousRulingId", "previousRulingId must name a ruling for the same candidate and item");
      }
    }
    if (!earlier.has(r.id)) earlier.set(r.id, r);
  });
  return issues;
}

/** The seq a newly appended ruling must use. */
export function nextRulingSeq(rulings: readonly Ruling[]): number {
  let max = 0;
  for (const r of rulings) max = Math.max(max, r.seq);
  return max + 1;
}
