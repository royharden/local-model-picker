import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELECTION_OPTIONS, RecommendResultSchema, RunFileSchema, defaultConstraints,
  groupKeyOf, groupRuns, recommend, resolveFullGpuRule,
} from "../../src/core/index.js";
import type { Constraints, RunFile, SelectionOptions } from "../../src/core/index.js";

const fixture = (name = "s01-q2-accuracy-collapse.json"): RunFile => RunFileSchema.parse(JSON.parse(readFileSync(new URL(`../../fixtures/runs/${name}`, import.meta.url), "utf8")));
const choose = (runs: RunFile[], constraints: Partial<Constraints> = {}, options: Partial<SelectionOptions> = {}) => recommend(runs, { ...defaultConstraints(options.objective ?? "quality"), ...constraints }, { ...DEFAULT_SELECTION_OPTIONS, ...options });

describe("configuration, grouping and supersession", () => {
  it("refuses missing speed floor, invalid limits, no runs and unknown group keys", () => {
    expect(choose([fixture()], { minAccuracy: null }, { objective: "speed" }).kind).toBe("refused");
    expect(choose([fixture()], { minTokPerSec: Number.NaN }).kind).toBe("refused");
    expect(choose([]).confidence).toBe("low");
    expect(choose([fixture()], {}, { groupKey: "missing" }).kind).toBe("refused");
    expect(choose([fixture()], {}, { objective: "speed" }).trace.some((t) => t.text.includes("required accuracy floor minAccuracy 0.6 enforced"))).toBe(true);
  });
  it("compares only an explicitly selected group and traces other runs", () => {
    const a = fixture();
    const b = fixture("s06-larger-q4-beats-smaller-q8.json");
    expect(groupRuns([a, b], false)).toHaveLength(2);
    const result = choose([a, b], {}, { groupKey: groupKeyOf(a, false) });
    expect(result.pick).toBe(a.candidates[0]!.candidate.key);
    expect(result.trace.filter((t) => t.kind === "incompatible")).toHaveLength(b.candidates.length);
    expect(result.perCandidate.every((c) => c.runId === a.runId)).toBe(true);
  });
  it("never relaxes runtime, item, grader or protocol components under mixed hardware", () => {
    const a = fixture();
    for (const part of ["protocolHash", "itemSetHash", "graderVersion"] as const) {
      const b = structuredClone(a);
      b[part] = part === "graderVersion" ? "different" : "f".repeat(64);
      expect(groupRuns([a, b], true)).toHaveLength(2);
    }
    const mock = structuredClone(a);
    mock.runtime = "mock";
    mock.endpointKind = "mock";
    mock.fingerprint.source = "mock";
    mock.fingerprint.scopeId = "mock-v1";
    expect(groupRuns([a, mock], true)).toHaveLength(2);
  });
  it("takes the newest whole measurement, even when it is incomplete", () => {
    const old = fixture();
    const recent = structuredClone(old);
    recent.createdAt = "2026-10-23T10:00:00.000Z";
    recent.runId = "new-measurement";
    recent.candidates[0]!.status = "incomplete";
    recent.candidates[0]!.statusReason = "interrupted";
    recent.candidates[0]!.speed = [];
    recent.candidates[0]!.items = [];
    const result = choose([recent, old]);
    expect(result.pick).toBe(recent.candidates[1]!.candidate.key);
    expect(result.perCandidate.find((c) => c.key === recent.candidates[0]!.candidate.key)).toMatchObject({ runId: recent.runId, n: 0, status: "incomplete" });
    expect(result.trace.filter((t) => t.kind === "superseded")).toHaveLength(2);
  });
  it("uses highest runId when createdAt ties; version confidence covers superseded runs", () => {
    const old = fixture();
    const recent = structuredClone(old);
    recent.runId = "zz-newer";
    recent.runtimeInfo.ollamaVersion = "0.6.0";
    const result = choose([recent, old]);
    expect(result.perCandidate.every((c) => c.runId === "zz-newer")).toBe(true);
    expect(result.confidenceReasons.some((r) => r.startsWith("Ollama versions differ"))).toBe(true);
  });
  it("refuses group unions beyond 64 candidates, with no silent result truncation", () => {
    const first = fixture();
    const template = first.candidates[0]!;
    first.candidates = Array.from({ length: 64 }, (_, i) => {
      const candidate = structuredClone(template);
      candidate.candidate.tag = `model-${i}:q4`;
      candidate.candidate.key = `${candidate.candidate.tag}@${candidate.candidate.digest.slice(0, 12)}`;
      return candidate;
    });
    const second = fixture();
    second.runId = "extra-candidate-run";
    second.candidates = [structuredClone(template)];
    const result = choose([first, second]);
    expect(result.kind).toBe("refused");
    expect(result.confidence).toBe("low");
    expect(result.message).toContain("65 distinct candidates");
    expect(result.pick).toBeNull();
    expect(RecommendResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("hard limits and confidence", () => {
  it("keeps a candidate in noise when its exact sign-test p equals alpha", () => {
    const run = fixture();
    run.candidates.forEach((candidate, index) => {
      candidate.items.forEach((item, i) => { item.correct = i < (index === 0 ? 27 : 22); });
      for (const repeat of candidate.speed) repeat.genTokPerSec = index === 0 ? 20 : 40;
    });
    // Five leader-only successes, no converse successes: p = 1 / 2^5 exactly.
    const boundary = choose([run], { alpha: 1 / 32 });
    expect(boundary.kind).toBe("pick");
    expect(boundary.noiseSet).toHaveLength(2);
    expect(boundary.tied).toBe(true);
    expect(boundary.pick).toBe(run.candidates[1]!.candidate.key);
    const above = choose([run], { alpha: 1 / 16 });
    expect(above.noiseSet).toEqual([run.candidates[0]!.candidate.key]);
    expect(above.pick).toBe(run.candidates[0]!.candidate.key);
  });
  it("passes throughput, latency, memory, offload and accuracy exactly at active limits", () => {
    const run = fixture();
    run.candidates = [run.candidates[0]!];
    const candidate = run.candidates[0]!;
    for (const repeat of candidate.speed) { repeat.genTokPerSec = 8; repeat.ttftMs = 5000; }
    candidate.memory = [{ phase: "after-load", sizeBytes: 2e9, sizeVramBytes: 1.5e9, offloadFraction: 0.75, source: "api/ps" }];
    candidate.items.forEach((item, index) => { item.correct = index < 18; });
    const result = choose([run], { minTokPerSec: 8, maxTtftMs: 5000, maxMemoryGB: 2, requireFullGpu: true, fullGpuThreshold: 0.75, minAccuracy: 0.6 }, { objective: "speed" });
    expect(result.kind).toBe("pick");
    expect(result.pick).toBe(candidate.candidate.key);
    expect(result.perCandidate[0]).toMatchObject({ tokPerSec: 8, ttftMs: 5000, memoryGB: 2, offload: 0.75, accuracy: 0.6 });
    expect(result.trace.filter((entry) => entry.kind === "filter")).toEqual([]);
  });
  it("records every failing filter with measured, limit, unit and source; none never picks", () => {
    const result = choose([fixture()], { minTokPerSec: 1000, maxTtftMs: 0, maxMemoryGB: 0, fullGpuThreshold: 1, minAccuracy: 1 });
    expect(result.kind).toBe("none");
    expect(result.pick).toBeNull();
    expect(result.runnerUp).toBeNull();
    expect(result.command).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.confidenceReasons[0]).toMatch(/^no recommendation/);
    for (const trace of result.trace.filter((t) => t.kind === "filter")) {
      for (const field of ["measured", "limit", "unit", "source"] as const) expect(trace[field]).not.toBeNull();
    }
    expect(RecommendResultSchema.safeParse(result).success).toBe(true);
  });
  it("missing sampled memory fails explicit memory/full-GPU constraints as not measured", () => {
    const run = fixture();
    for (const candidate of run.candidates) candidate.memory = [];
    const result = choose([run], { maxMemoryGB: 8, requireFullGpu: true });
    expect(result.kind).toBe("none");
    expect(result.trace.filter((t) => t.kind === "filter")).toHaveLength(4);
    expect(result.trace.filter((t) => t.kind === "filter").every((t) => t.measured === "not measured")).toBe(true);
  });
  it("resolves auto per GPU and candidate; explicit true is never skipped", () => {
    const run = fixture();
    run.fingerprint.gpu = { vendor: "unknown", name: null, vramTotalBytes: null, unifiedMemory: null };
    const unknown = choose([run]);
    expect(unknown.kind).toBe("pick");
    expect(unknown.confidenceReasons).toContain("no GPU detected; full-GPU check not applied");
    run.fingerprint.gpu = { vendor: "apple", name: "Apple test", vramTotalBytes: null, unifiedMemory: true };
    expect(resolveFullGpuRule("auto", run.fingerprint, 1).applied).toBe(true);
    for (const candidate of run.candidates) candidate.memory = [];
    const apple = choose([run]);
    expect(apple.kind).toBe("pick");
    expect(apple.confidenceReasons.filter((r) => r.startsWith("unified memory: offload not interpretable"))).toHaveLength(2);
    expect(choose([run], { requireFullGpu: true }).kind).toBe("none");
    expect(resolveFullGpuRule(false, run.fingerprint, null)).toEqual({ applied: false, skipped: "off" });
  });
  it("requires remote acceptance and an explicit GPU rule; remote scopes never merge", () => {
    const run = fixture();
    run.remote = true;
    run.endpointKind = "remote";
    run.fingerprint.source = "remote-unknown";
    run.fingerprint.scopeId = run.runId;
    expect(choose([run]).kind).toBe("refused");
    expect(choose([run], {}, { acceptRemote: true }).message).toContain("choose requireFullGpu true or false");
    const result = choose([run], { requireFullGpu: false }, { acceptRemote: true });
    expect(result.kind).toBe("pick");
    expect(result.confidenceReasons.some((r) => r.startsWith("remote server"))).toBe(true);
    expect(result.baselines.estimateOnly.available).toBe(false);
    const other = structuredClone(run);
    other.runId = "remote-other";
    other.fingerprint.scopeId = other.runId;
    expect(groupRuns([run, other], true)).toHaveLength(2);
  });
  it("keys mock confidence on runtime and independently records an incomplete item bank", () => {
    const run = fixture();
    expect(choose([run]).confidence).toBe("high"); // synthetic local scenario is not mock
    run.runtime = "mock";
    run.endpointKind = "mock";
    run.fingerprint.source = "mock";
    run.fingerprint.scopeId = "mock-v1";
    run.protocol.itemSetComplete = false;
    const result = choose([run]);
    expect(result.confidenceReasons).toContain("mock data: not a measurement");
    expect(result.confidenceReasons).toContain("item bank incomplete (placeholders)");
  });
  it("only pick truncation/unterminated-thinking flags lower confidence; warnings are display-only", () => {
    const run = fixture();
    run.warnings.push("ambiguous unload ownership");
    run.candidates[1]!.items[0]!.flags = ["over_cap"];
    expect(choose([run]).confidence).toBe("high");
    run.candidates[0]!.items[0]!.flags = ["unterminated_think"];
    expect(choose([run]).confidenceReasons.some((r) => r.startsWith("pick's graded text"))).toBe(true);
  });
  it("summarizes repeated confidence reasons while retaining each candidate's evidence", () => {
    const run = fixture();
    const template = run.candidates[0]!;
    run.fingerprint.gpu = { vendor: "apple", name: "Apple test", vramTotalBytes: null, unifiedMemory: true };
    run.candidates = Array.from({ length: 51 }, (_, i) => {
      const candidate = structuredClone(template);
      candidate.candidate.tag = `model-${i}:q4`;
      candidate.candidate.key = `${candidate.candidate.tag}@${candidate.candidate.digest.slice(0, 12)}`;
      candidate.memory = [];
      return candidate;
    });
    const result = choose([run]);
    expect(result.kind).toBe("pick");
    expect(result.confidenceReasons.length).toBeLessThanOrEqual(50);
    expect(result.confidenceReasons.some((r) => r.includes("51 candidates"))).toBe(true);
    expect(result.trace.filter((t) => t.text.startsWith("confidence evidence: unified memory"))).toHaveLength(51);
    expect(RecommendResultSchema.safeParse(result).success).toBe(true);
  });
});
