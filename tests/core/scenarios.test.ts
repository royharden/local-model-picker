// Frozen expectations predate the recommender. Authored in Dirty Mode; runtime execution deferred.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELECTION_OPTIONS, RecommendResultSchema, RunFileSchema, defaultConstraints,
  recommend, rejectedFilters,
} from "../../src/core/index.js";
import type { Constraints, FilterName, SelectionOptions } from "../../src/core/index.js";

interface Expected {
  kind: "pick" | "none" | "refused";
  pick: string | null;
  runnerUp: string | null;
  noiseSet: string[];
  tied: boolean;
  confidence: "high" | "low";
  confidenceReasons: string[];
  rejected: Record<string, FilterName[]>;
  unmeasured: string[];
  superseded: string[];
  groupsAvailable: number;
  command: string | null;
  clearlyFaster: boolean | null;
  humanCorrected: string[];
  latencyMetric?: Record<string, string>;
  qualityTraceMentions?: Record<string, string>;
  estimateOnly: string;
  fastestOnly: string;
  accuracyOnly: string;
  baselineViolations: Record<"estimateOnly" | "fastestOnly" | "accuracyOnly", FilterName[]>;
}
interface Scenario {
  id: string;
  files: string[];
  cases: { name: string; options: Partial<SelectionOptions>; constraints: Partial<Constraints>; expect: Expected }[];
}
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const scenarios = (readJson("../../fixtures/expected.json") as { scenarios: Scenario[] }).scenarios;

describe("14 frozen recommender scenarios", () => {
  it("retains all fourteen independent traps and high-confidence controls", () => {
    expect(scenarios.map((s) => s.id)).toEqual(Array.from({ length: 14 }, (_, i) => `s${String(i + 1).padStart(2, "0")}`));
    expect(scenarios.some((s) => s.cases.some((c) => c.expect.confidence === "high"))).toBe(true);
  });
  for (const scenario of scenarios) {
    for (const testCase of scenario.cases) {
      it(`${scenario.id}: ${testCase.name}`, () => {
        const runs = scenario.files.map((file) => RunFileSchema.parse(readJson(`../../fixtures/runs/${file}`)));
        for (const run of runs) {
          expect(run.runtime).toBe("ollama");
          expect(run.synthetic).toBe(true);
          expect(run.endpointKind).toBe("loopback");
          expect(run.fingerprint.source).toBe("local-probe");
          expect(run.protocol.itemSetComplete).toBe(true);
        }
        const options = { ...DEFAULT_SELECTION_OPTIONS, ...testCase.options };
        const constraints = { ...defaultConstraints(options.objective), ...testCase.constraints };
        const result = recommend(runs, constraints, options);
        expect(RecommendResultSchema.safeParse(result).success).toBe(true);
        const e = testCase.expect;
        for (const field of ["kind", "pick", "runnerUp", "tied", "confidence", "command"] as const) expect(result[field]).toEqual(e[field]);
        // noiseSet is a set; its presentation order is not part of the decision contract.
        expect([...result.noiseSet].sort()).toEqual([...e.noiseSet].sort());
        expect(result.confidenceReasons).toHaveLength(e.confidenceReasons.length);
        for (const prefix of e.confidenceReasons) expect(result.confidenceReasons.some((reason) => reason.startsWith(prefix))).toBe(true);
        expect(Object.fromEntries(rejectedFilters(result))).toEqual(e.rejected);
        for (const kind of ["unmeasured", "superseded"] as const) {
          expect([...new Set(result.trace.filter((t) => t.kind === kind).map((t) => t.candidateKey))].sort()).toEqual([...e[kind]].sort());
        }
        expect(result.groupsAvailable).toHaveLength(e.groupsAvailable);
        expect(result.speedComparison?.clearlyFaster ?? null).toBe(e.clearlyFaster);
        expect(result.perCandidate.filter((c) => c.humanCorrected).map((c) => c.key).sort()).toEqual([...e.humanCorrected].sort());
        for (const [candidate, metric] of Object.entries(e.latencyMetric ?? {})) {
          expect(result.perCandidate.find((c) => c.key === candidate)?.latencyMetric).toBe(metric);
        }
        for (const [candidate, text] of Object.entries(e.qualityTraceMentions ?? {})) {
          expect(result.trace.some((t) => t.kind === "quality" && t.candidateKey === candidate && t.text.includes(text))).toBe(true);
        }
        for (const name of ["estimateOnly", "fastestOnly", "accuracyOnly"] as const) {
          const baseline = result.baselines[name];
          expect(baseline.pick ?? "unavailable").toBe(e[name]);
          expect(baseline.available).toBe(e[name] !== "unavailable");
          expect(baseline.violations).toEqual(e.baselineViolations[name]);
        }
      });
    }
  }
});
