import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunFileSchema, aggregateAccuracy, aggregateMemory, aggregateSpeed, discordance, median } from "../../src/core/index.js";
import type { RunFile, SpeedRepeat } from "../../src/core/index.js";

const fixture = (name = "s01-q2-accuracy-collapse.json"): RunFile => RunFileSchema.parse(JSON.parse(readFileSync(new URL(`../../fixtures/runs/${name}`, import.meta.url), "utf8")));
const speed = (): SpeedRepeat[] => structuredClone(fixture().candidates[0]!.speed);

describe("speed aggregation", () => {
  it("drops every prompt's warm-up and uses min/max of per-prompt medians", () => {
    const rows = speed();
    const ids = [...new Set(rows.map((r) => r.promptId))];
    for (const row of rows) {
      const i = ids.indexOf(row.promptId);
      row.genTokPerSec = row.repeat === 0 ? 10_000 : [10, 20, 30][i]! + row.repeat - 2;
      row.ttftMs = row.repeat === 0 ? 20_000 : [100, 300, 200][i]! + row.repeat - 2;
      row.loadMs = row.repeat === 0 ? 5000 : 0;
    }
    const aggregate = aggregateSpeed(rows);
    expect(aggregate.complete).toBe(true);
    expect(aggregate.tokPerSec).toBe(10);
    expect(aggregate.latencyMs).toBe(300);
    expect(aggregate.speedRange).toEqual({ lo: 9, hi: 11 });
    expect(aggregate.spreadMax).toBeCloseTo(0.2);
    expect(aggregate.coldLoadMs).toBe(5000);
    expect(aggregate.warmLoadMs).toBe(0);
    expect(aggregate.perPrompt.every((p) => p.validRepeats === 3)).toBe(true);
  });
  it("uses time to first answer for every prompt when any measured repeat observed thinking", () => {
    const rows = speed();
    for (const row of rows) { row.ttftMs = 10; row.ttfaMs = 7000; }
    rows.find((r) => r.repeat === 1)!.thinkingObserved = true;
    const aggregate = aggregateSpeed(rows);
    expect(aggregate.latencyMetric).toBe("ttfa");
    expect(aggregate.latencyMs).toBe(7000);
    expect(aggregate.maxMedianTtftMs).toBe(10);
    expect(aggregate.maxMedianTtfaMs).toBe(7000);
  });
  it("invalid repeats stay incomplete and never become throughput zero", () => {
    const rows = speed();
    const invalid = rows.find((r) => r.repeat === 3)!;
    invalid.valid = false;
    invalid.invalidReason = "missing done chunk";
    invalid.genTokPerSec = null;
    const aggregate = aggregateSpeed(rows);
    expect(aggregate.complete).toBe(false);
    expect(aggregate.tokPerSec).toBeNull();
    expect(aggregate.incompleteReason).toContain("missing done chunk");
  });
  it("does not count duplicate repeat indices or ignore missing latency values", () => {
    const rows = speed();
    rows.find((r) => r.repeat === 3)!.repeat = 2;
    expect(aggregateSpeed(rows).complete).toBe(false);
    const missing = speed();
    missing.find((r) => r.repeat === 2)!.ttftMs = null;
    expect(aggregateSpeed(missing).complete).toBe(false);
    expect(aggregateSpeed([]).tokPerSec).toBeNull();
  });
  it("requires exactly three prompts and treats zero cached prompt-eval as valid", () => {
    const rows = speed();
    for (const row of rows) { row.promptEvalCount = 0; row.promptEvalMs = 0; row.promptTokPerSec = null; }
    expect(aggregateSpeed(rows).complete).toBe(true);
    expect(aggregateSpeed(rows.filter((r) => r.promptId !== rows[0]!.promptId)).complete).toBe(false);
    expect(median([8, 1, 5, 4])).toBe(4.5);
    expect(() => median([])).toThrow();
  });
});

describe("memory aggregation", () => {
  it("uses max sampled size and min sampled byte ratio, in decimal GB", () => {
    expect(aggregateMemory([
      { phase: "after-load", sizeBytes: 2e9, sizeVramBytes: 2e9, offloadFraction: 1, source: "api/ps" },
      { phase: "after-repeat", sizeBytes: 2.5e9, sizeVramBytes: 1e9, offloadFraction: 0.4, source: "api/ps" },
    ])).toMatchObject({ measured: true, memoryGB: 2.5, offload: 0.4, maxSizeBytes: 2.5e9 });
  });
  it("keeps unknown distinct from zero and never uses an invalid ratio", () => {
    expect(aggregateMemory([])).toMatchObject({ measured: false, memoryGB: null, offload: null });
    expect(aggregateMemory([{ phase: "after-load", sizeBytes: 0, sizeVramBytes: 0, offloadFraction: null, source: "api/ps" }])).toMatchObject({ memoryGB: 0, offload: null });
    expect(aggregateMemory([{ phase: "after-load", sizeBytes: 2, sizeVramBytes: 3, offloadFraction: null, source: "api/ps" }]).offload).toBeNull();
  });
});

describe("accuracy and paired items", () => {
  it("replays by highest seq, independent of array order and timestamp", () => {
    const run = fixture("s14-grader-overrides.json");
    const b = run.candidates[1]!;
    const original = aggregateAccuracy(b.items, run.rulings, run.runId, b.candidate.key, false);
    const corrected = aggregateAccuracy(b.items, [...run.rulings].reverse(), run.runId, b.candidate.key, true);
    expect(original.correct).toBe(21);
    expect(corrected.correct).toBe(25);
    expect(corrected.humanCorrected).toBe(true);
    const a = run.candidates[0]!;
    expect(aggregateAccuracy(a.items, [...run.rulings].reverse(), run.runId, a.candidate.key, true).humanCorrected).toBe(false);
    expect(aggregateAccuracy(b.items, run.rulings, "another-run", b.candidate.key, true).correct).toBe(21);
    expect(aggregateAccuracy([], [], run.runId, b.candidate.key, true).accuracy).toBeNull();
  });
  it("discards concordant pairs and reports discordances per grader", () => {
    const d = discordance(["a", "b", "c", "d"], new Map([["a", true], ["b", false], ["c", true], ["d", false]]), new Map([["a", false], ["b", true], ["c", true], ["d", false]]), new Map([["a", "numeric"], ["b", "choice"]]));
    expect(d.b).toBe(1);
    expect(d.c).toBe(1);
    expect(Object.fromEntries(d.byGrader)).toEqual({ numeric: { b: 1, c: 0 }, choice: { b: 0, c: 1 } });
  });
});
