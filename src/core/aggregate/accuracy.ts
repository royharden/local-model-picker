// Accuracy aggregation (Claude §2.6 "Accuracy", §2.5 Ruling). Effective correctness per
// (candidate, item) = the original grade, replaced by the highest-`seq` ruling for that pair when
// rulings are applied. Replay is by seq, never by `at` or array order. A ruling changes only
// correctness. Rulings that name another run, another candidate or an item without a result are
// ignored here (readRunFile rejects such files; recommend never trusts array order or references).
import type { ItemResult } from "../schema/candidate.js";
import type { Ruling } from "../schema/rulings.js";
import { wilson } from "../evalkit/wilson.js";

export interface AccuracyAggregate {
  correct: number;
  n: number;
  accuracy: number | null;
  wilson95: { lo: number; hi: number } | null;
  /** True when at least one item's effective correctness differs from its original grade. */
  humanCorrected: boolean;
  /** itemId -> effective correctness (only items that have a result). */
  effective: ReadonlyMap<string, boolean>;
  /** Items whose effective correctness differs from the original grade, itemId ascending. */
  changedItems: string[];
  /** graderId -> { correct, n } over the effective grades, for per-kind trace counts. */
  byGrader: ReadonlyMap<string, { correct: number; n: number }>;
}

/** The highest-seq ruling per item for one candidate of one run (replay by seq). */
export function latestRulings(rulings: readonly Ruling[], runId: string, candidateKey: string): Map<string, Ruling> {
  const out = new Map<string, Ruling>();
  for (const r of rulings) {
    if (r.runId !== runId || r.candidateKey !== candidateKey) continue;
    const prev = out.get(r.itemId);
    if (prev === undefined || r.seq > prev.seq) out.set(r.itemId, r);
  }
  return out;
}

export function aggregateAccuracy(
  items: readonly ItemResult[],
  rulings: readonly Ruling[],
  runId: string,
  candidateKey: string,
  applyRulings: boolean,
): AccuracyAggregate {
  const latest = applyRulings ? latestRulings(rulings, runId, candidateKey) : new Map<string, Ruling>();
  const effective = new Map<string, boolean>();
  const byGrader = new Map<string, { correct: number; n: number }>();
  const changed: string[] = [];
  let correct = 0;
  for (const item of items) {
    const ruling = latest.get(item.itemId);
    const value = ruling === undefined ? item.correct : ruling.overrideCorrect;
    effective.set(item.itemId, value);
    if (value !== item.correct) changed.push(item.itemId);
    if (value) correct++;
    const g = byGrader.get(item.graderId) ?? { correct: 0, n: 0 };
    byGrader.set(item.graderId, { correct: g.correct + (value ? 1 : 0), n: g.n + 1 });
  }
  const n = items.length;
  const w = n > 0 ? wilson(correct, n) : null;
  return {
    correct,
    n,
    accuracy: n > 0 ? correct / n : null,
    wilson95: w === null ? null : { lo: w.lo, hi: w.hi },
    humanCorrected: changed.length > 0,
    effective,
    changedItems: changed.sort(),
    byGrader,
  };
}

/** Discordant pairs between a leader and another candidate over the given item ids. */
export interface Discordance {
  /** items the leader got right and the other got wrong */
  b: number;
  /** items the other got right and the leader got wrong */
  c: number;
  /** graderId -> {b, c}, only graders with at least one discordant item */
  byGrader: Map<string, { b: number; c: number }>;
}

export function discordance(
  itemIds: readonly string[],
  leader: ReadonlyMap<string, boolean>,
  other: ReadonlyMap<string, boolean>,
  graderOf: ReadonlyMap<string, string>,
): Discordance {
  let b = 0;
  let c = 0;
  const byGrader = new Map<string, { b: number; c: number }>();
  for (const id of itemIds) {
    const l = leader.get(id);
    const o = other.get(id);
    if (l === undefined || o === undefined || l === o) continue; // concordant (or missing) pairs discarded
    const g = graderOf.get(id) ?? "unknown";
    const cur = byGrader.get(g) ?? { b: 0, c: 0 };
    if (l) {
      b++;
      cur.b++;
    } else {
      c++;
      cur.c++;
    }
    byGrader.set(g, cur);
  }
  return { b, c, byGrader };
}
