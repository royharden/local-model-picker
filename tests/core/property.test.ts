// Bounded seeded invariants; no property-test dependency and no unseeded randomness.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION_OPTIONS, RecommendResultSchema, RunFileSchema, defaultConstraints, mulberry32, recommend } from "../../src/core/index.js";

const fixture = () => RunFileSchema.parse(JSON.parse(readFileSync(new URL("../../fixtures/runs/s01-q2-accuracy-collapse.json", import.meta.url), "utf8")));
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

describe("pure recommendation invariants", () => {
  it("is deterministic and never mutates frozen inputs", () => {
    const runs = [fixture()];
    const constraints = defaultConstraints("quality");
    const options = { ...DEFAULT_SELECTION_OPTIONS };
    const before = JSON.stringify({ runs, constraints, options });
    deepFreeze(runs); deepFreeze(constraints); deepFreeze(options);
    const first = recommend(runs, constraints, options);
    expect(recommend(runs, constraints, options)).toEqual(first);
    expect(JSON.stringify({ runs, constraints, options })).toBe(before);
  });
  it("candidate order and run import order cannot change the recommendation", () => {
    const run = fixture();
    const reversed = structuredClone(run);
    reversed.candidates.reverse();
    expect(recommend([reversed], defaultConstraints("quality"), DEFAULT_SELECTION_OPTIONS)).toEqual(recommend([run], defaultConstraints("quality"), DEFAULT_SELECTION_OPTIONS));
    const recent = structuredClone(run);
    recent.createdAt = "2026-10-24T10:00:00.000Z";
    recent.runId = "latest";
    expect(recommend([run, recent], defaultConstraints("quality"), DEFAULT_SELECTION_OPTIONS)).toEqual(recommend([recent, run], defaultConstraints("quality"), DEFAULT_SELECTION_OPTIONS));
  });
  it("never returns a pick outside the measured limits across seeded limit combinations", () => {
    const run = fixture();
    const rand = mulberry32(0x5332);
    for (let trial = 0; trial < 60; trial++) {
      const objective = trial % 2 === 0 ? "quality" : "speed";
      const constraints = {
        ...defaultConstraints(objective), minTokPerSec: rand() * 80, maxTtftMs: rand() * 10_000,
        maxMemoryGB: trial % 3 === 0 ? null : rand() * 10,
        minAccuracy: objective === "speed" || trial % 4 === 0 ? rand() : null,
        fullGpuThreshold: rand(),
      };
      const result = recommend([run], constraints, { ...DEFAULT_SELECTION_OPTIONS, objective });
      expect(RecommendResultSchema.safeParse(result).success).toBe(true);
      if (result.kind !== "pick") {
        expect(result.kind).toBe("none");
        expect(result.pick).toBeNull();
        expect(result.command).toBeNull();
        continue;
      }
      const pick = result.perCandidate.find((c) => c.key === result.pick)!;
      expect(pick.status).toBe("measured");
      expect(pick.tokPerSec!).toBeGreaterThanOrEqual(constraints.minTokPerSec);
      expect(pick.ttftMs!).toBeLessThanOrEqual(constraints.maxTtftMs);
      if (constraints.maxMemoryGB !== null) expect(pick.memoryGB!).toBeLessThanOrEqual(constraints.maxMemoryGB);
      if (constraints.minAccuracy !== null) expect(pick.accuracy!).toBeGreaterThanOrEqual(constraints.minAccuracy);
      expect(pick.offload!).toBeGreaterThanOrEqual(constraints.fullGpuThreshold);
      expect(result.trace.some((t) => t.kind === "filter" && t.candidateKey === result.pick)).toBe(false);
    }
  });
  it("returns none iff independent seeded candidate vectors have no survivors", () => {
    const rand = mulberry32(0x5333);
    const sample = <T,>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!;
    let sawNone = false;
    let sawPick = false;
    for (let trial = 0; trial < 24; trial++) {
      const run = fixture();
      const template = run.candidates[0]!;
      const objective = trial % 2 === 0 ? "quality" : "speed";
      const constraints = { ...defaultConstraints(objective), requireFullGpu: true as const,
        minTokPerSec: trial % 4 === 0 ? 100 : sample([8, 12, 16]), maxTtftMs: sample([1000, 5000]),
        maxMemoryGB: sample([2, 4, null]), minAccuracy: sample([0.5, 0.6, 0.75]), fullGpuThreshold: sample([0.75, 1]) };
      const vectors = Array.from({ length: 4 }, (_, index) => ({
        key: `seeded-${trial}-${index}:q4@${template.candidate.digest.slice(0, 12)}`,
        tok: sample([4, 8, 12, 24]), latency: sample([100, 1000, 5000, 8000]),
        memory: sample([1, 2, 4, 8]), offload: sample([0.5, 0.75, 1]),
        correct: 10 + Math.floor(rand() * 21), measured: rand() < 0.85, hasMemory: rand() < 0.9,
      }));
      // Guarantee that both empty and nonempty survivor sets occur within this bounded slate.
      if (trial % 4 === 1) Object.assign(vectors[0]!, { tok: 24, latency: 100, memory: 1, offload: 1, correct: 30, measured: true, hasMemory: true });
      run.candidates = vectors.map((vector, index) => {
        const candidate = structuredClone(template);
        candidate.candidate.tag = `seeded-${trial}-${index}:q4`;
        candidate.candidate.key = vector.key;
        candidate.status = vector.measured ? "measured" : "incomplete";
        candidate.statusReason = vector.measured ? null : "seeded partial measurement";
        for (const repeat of candidate.speed) { repeat.genTokPerSec = vector.tok; repeat.ttftMs = vector.latency; }
        candidate.memory = vector.hasMemory ? [{ phase: "after-load", sizeBytes: vector.memory * 1e9,
          sizeVramBytes: vector.memory * 1e9 * vector.offload, offloadFraction: vector.offload, source: "api/ps" }] : [];
        candidate.items.forEach((item, i) => { item.correct = i < vector.correct; });
        return candidate;
      });
      // This oracle reads only generated scalars, not aggregate helpers or recommend output.
      const survivors = vectors.filter((vector) => vector.measured && vector.tok >= constraints.minTokPerSec
        && vector.latency <= constraints.maxTtftMs && vector.hasMemory
        && (constraints.maxMemoryGB === null || vector.memory <= constraints.maxMemoryGB)
        && vector.offload >= constraints.fullGpuThreshold && vector.correct / 30 >= constraints.minAccuracy).map((vector) => vector.key);
      const result = recommend([run], constraints, { ...DEFAULT_SELECTION_OPTIONS, objective });
      expect(result.kind).toBe(survivors.length === 0 ? "none" : "pick"); // refused cannot escape
      const actual = result.perCandidate.filter((candidate) => candidate.status === "measured"
        && !result.trace.some((entry) => entry.candidateKey === candidate.key && entry.kind === "filter")).map((candidate) => candidate.key);
      expect(actual.sort()).toEqual([...survivors].sort());
      if (survivors.length === 0) {
        sawNone = true;
        expect(result.pick).toBeNull(); expect(result.runnerUp).toBeNull(); expect(result.command).toBeNull();
      } else { sawPick = true; expect(survivors).toContain(result.pick); }
    }
    expect(sawNone).toBe(true);
    expect(sawPick).toBe(true);
  });
});
