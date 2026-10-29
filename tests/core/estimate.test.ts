import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUANT_ORDER, RunFileSchema, estimateBudget, parseParameterSize, quantRank, walkdown } from "../../src/core/index.js";
import type { Candidate, RunFile } from "../../src/core/index.js";

const fixture = (): RunFile => RunFileSchema.parse(JSON.parse(readFileSync(new URL("../../fixtures/runs/s01-q2-accuracy-collapse.json", import.meta.url), "utf8")));
const candidate = (key: string, quantization: string | null, parameterSize: string | null, sizeBytes: number, tag = "model:tag"): Candidate => ({ ...fixture().candidates[0]!.candidate, key, quantization, parameterSize, sizeBytes, tag });

describe("installed-only weights walk-down", () => {
  it("pins all seven quant levels, including Q4_0, and rejects unknown metadata", () => {
    expect(QUANT_ORDER).toEqual(["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q4_0", "Q3_K_M", "Q2_K"]);
    expect(quantRank("q4_0")).toBe(4);
    expect(quantRank("IQ4_XS")).toBeNull();
    expect(parseParameterSize("500M")).toBe(0.5);
    expect(parseParameterSize("1.5b")).toBe(1.5);
    expect(parseParameterSize("unknown")).toBeNull();
    const result = walkdown([candidate("missing", "Q4_K_M", null, 1), candidate("quant", "IQ4_XS", "8B", 1)], { available: true, bytes: 10, source: "vramFreeBytes" });
    expect(result.pick).toBeNull();
    expect(result.excluded).toHaveLength(2);
  });
  it("walks down per exact model and parameterSize, then favors the largest model", () => {
    const candidates = [
      candidate("a-q8", "Q8_0", "8B", 9), candidate("a-q4", "Q4_K_M", "8B", 5),
      candidate("b-q8", "Q8_0", "3B", 4, "other:tag"),
      candidate("c-q4", "Q4_K_M", "14B", 7, "larger:tag"),
    ];
    const result = walkdown(candidates, { available: true, bytes: 7, source: "ramFreeBytes" });
    expect(result.models.find((m) => m.model === "model")?.pick).toBe("a-q4");
    expect(result.pick?.key).toBe("c-q4"); // inclusive sizeBytes <= budget
    expect(result.label).toBe("llmfit-style installed-only weights estimate");
  });
  it("breaks cross-model parameter ties by quant then key, without mutating candidates", () => {
    const candidates = [candidate("z", "Q4_K_M", "8B", 1), candidate("b", "Q8_0", "8B", 1, "other:tag"), candidate("a", "Q8_0", "8B", 1, "third:tag")];
    const before = JSON.stringify(candidates);
    expect(walkdown(candidates, { available: true, bytes: 1, source: "ramFreeBytes" }).pick?.key).toBe("a");
    expect(JSON.stringify(candidates)).toBe(before);
    expect(walkdown(candidates, { available: true, bytes: 0, source: "ramFreeBytes" }).reason).toContain("no candidate");
  });
  it("uses free VRAM on discrete NVIDIA and free RAM on CPU/Apple, never totals", () => {
    const run = fixture();
    const input = { fingerprint: run.fingerprint, availableMemory: run.availableMemory, remote: false, mixedHardware: false };
    expect(estimateBudget(input)).toEqual({ available: true, bytes: run.availableMemory.vramFreeBytes, source: "vramFreeBytes" });
    run.availableMemory.vramFreeBytes = null;
    expect(estimateBudget(input).available).toBe(false);
    run.fingerprint.gpu.vendor = "apple";
    run.fingerprint.gpu.unifiedMemory = true;
    expect(estimateBudget(input)).toEqual({ available: true, bytes: run.availableMemory.ramFreeBytes, source: "ramFreeBytes" });
    run.availableMemory.ramFreeBytes = null;
    expect(estimateBudget(input).available).toBe(false);
    run.fingerprint.gpu.vendor = "unknown";
    expect(estimateBudget(input).available).toBe(false);
    expect(estimateBudget({ ...input, remote: true }).available).toBe(false);
    expect(estimateBudget({ ...input, mixedHardware: true }).available).toBe(false);
    expect(walkdown([], { available: false, reason: "free memory unknown" })).toMatchObject({ available: false, pick: null, reason: "free memory unknown" });
  });
});
