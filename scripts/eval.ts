// The sole held-out loader. Do not run during Dirty Mode or tune graders against its output.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
  DEFAULT_SELECTION_OPTIONS, GraderFixtureSchema, ItemBankSchema, RecommendResultSchema,
  RunFileSchema, checkGraderSplit, compareMethods, defaultConstraints, gradeAnswer, naiveGrade,
  recommend, rejectedFilters, resultsMd, sanitizeForTerminal, signTestOneSided,
  signTestTwoSided, wilson,
} from "../src/core/index.js";
import type {
  Constraints, FilterName, GraderFixture, Item, Method, MethodCase, MethodOutcome,
  RecommendResult, ReferenceRow, RunFile, SelectionOptions,
} from "../src/core/index.js";
import { SIMULATION, simulate } from "./sim.js";

const ROOT = new URL("../", import.meta.url);
const METHODS = ["recommend", "estimate-only", "fastest-only", "accuracy-only"] as const;
type MethodName = (typeof METHODS)[number];
const BASELINES = ["estimateOnly", "fastestOnly", "accuracyOnly"] as const;
interface ExpectedCase {
  name: string;
  options: Partial<SelectionOptions>;
  constraints: Partial<Constraints>;
  expect: {
    kind: RecommendResult["kind"];
    pick: string | null;
    tied: boolean;
    estimateOnly: string;
    fastestOnly: string;
    accuracyOnly: string;
    baselineViolations: Record<(typeof BASELINES)[number], FilterName[]>;
  };
}
interface Scenario { id: string; files: string[]; cases: ExpectedCase[] }
interface CaseInput { result: RecommendResult }
interface GradeResult { extracted: string | null; correct: boolean }
interface GradeSummary {
  method: string;
  cases: number;
  correctnessMatches: number;
  extractionMatches: number;
  combinedMatches: number;
  correctnessAgreement: number;
  extractionAgreement: number;
  combinedAgreement: number;
}

async function json(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relative, ROOT), "utf8")) as unknown;
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function outcome(name: MethodName, result: RecommendResult): MethodOutcome {
  if (name === "recommend") return {
    pick: result.pick, tied: result.tied,
    limitViolations: result.pick === null ? 0 : (rejectedFilters(result).get(result.pick)?.length ?? 0),
  };
  const key = name === "estimate-only" ? "estimateOnly" : name === "fastest-only" ? "fastestOnly" : "accuracyOnly";
  const row = result.baselines[key];
  return { pick: row.pick, limitViolations: row.violations.length, tied: null };
}

function graderRows(fixture: GraderFixture, items: ReadonlyMap<string, Item>) {
  const disagreements: {
    type: "grader-disagreement"; method: string; caseId: string; itemId: string;
    traps: string[]; expected: GradeResult; actual: GradeResult;
    correctnessMatches: boolean; extractionMatches: boolean;
  }[] = [];
  const summaries: GradeSummary[] = [];
  for (const method of ["deterministic", "naive"] as const) {
    let correctnessMatches = 0;
    let extractionMatches = 0;
    let combinedMatches = 0;
    for (const c of fixture.cases) {
      const item = items.get(c.itemId);
      if (item === undefined) throw new Error(`unknown item for grader case ${c.id}`);
      const deterministic = gradeAnswer(item, c.response);
      // Same capped/redacted raw for both; the naive baseline deliberately retains inline thinking.
      const actual = method === "deterministic" ? deterministic : naiveGrade(item, deterministic.raw);
      const correct = actual.correct === c.expectedCorrect;
      const extraction = actual.extracted === c.expectedExtracted;
      correctnessMatches += Number(correct);
      extractionMatches += Number(extraction);
      combinedMatches += Number(correct && extraction);
      if (!correct || !extraction) disagreements.push({
        type: "grader-disagreement", method, caseId: c.id, itemId: c.itemId, traps: c.traps,
        expected: { correct: c.expectedCorrect, extracted: c.expectedExtracted },
        actual: { correct: actual.correct, extracted: actual.extracted },
        correctnessMatches: correct, extractionMatches: extraction,
      });
    }
    const cases = fixture.cases.length;
    summaries.push({ method, cases, correctnessMatches, extractionMatches, combinedMatches,
      correctnessAgreement: correctnessMatches / cases, extractionAgreement: extractionMatches / cases,
      combinedAgreement: combinedMatches / cases });
  }
  return { summaries, disagreements };
}

function statistics() {
  // Rational references are exact; Wilson endpoints are hand-computed rounded references
  // documented in tests/core/evalkit.test.ts. They are not calculated by the function under test.
  const rows = [
    { name: "sign one-sided 7:1", actual: signTestOneSided(7, 1), expected: 9 / 256, tolerance: 1e-12 },
    { name: "sign two-sided 7:1", actual: signTestTwoSided(7, 1), expected: 18 / 256, tolerance: 1e-12 },
    { name: "sign one-sided 0:0", actual: signTestOneSided(0, 0), expected: 1, tolerance: 1e-12 },
    { name: "sign one-sided 5:0", actual: signTestOneSided(5, 0), expected: 1 / 32, tolerance: 1e-12 },
  ];
  for (const [k, lo, hi] of [[0, 0, 0.11351], [15, 0.33154, 0.66846], [27, 0.74379, 0.96540], [30, 0.88649, 1]]) {
    if (k === undefined || lo === undefined || hi === undefined) throw new Error("missing Wilson reference");
    const interval = wilson(k, 30);
    rows.push({ name: `Wilson ${k}/30 lower`, actual: interval.lo, expected: lo, tolerance: 0.00002 });
    rows.push({ name: `Wilson ${k}/30 upper`, actual: interval.hi, expected: hi, tolerance: 0.00002 });
  }
  return rows.map((r) => ({ type: "statistics-reference", ...r, difference: Math.abs(r.actual - r.expected),
    matches: Math.abs(r.actual - r.expected) <= r.tolerance }));
}

export async function evaluate(): Promise<void> {
  // A nonempty JSONL is a durable execution marker. No automatic repeated held-out scoring.
  // If execution was interrupted before saving it, stop for review rather than retrying silently.
  let previousBytes = 0;
  try { previousBytes = (await stat(new URL("results/results.jsonl", ROOT))).size; }
  catch (error: unknown) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  assert(previousBytes === 0, "results.jsonl already contains an execution; held-out reruns require a separate documented audit decision, not this command");
  const bank = ItemBankSchema.parse(await json("data/items.v1.json"));
  const dev = GraderFixtureSchema.parse(await json("fixtures/graders/dev.v1.json"));
  // Only this file loads held-out responses; construction and ordinary tests never execute it.
  const heldout = GraderFixtureSchema.parse(await json("fixtures/graders/heldout.v1.json"));
  const splitIssues = checkGraderSplit(dev, heldout, bank.items.map((i) => i.id));
  if (dev.seed !== 0x5332 || heldout.seed !== 0x5332) splitIssues.push("expected recorded seed 0x5332");
  assert(splitIssues.length === 0, `grader split inconsistent: ${splitIssues.join("; ")}`);
  const graders = graderRows(heldout, new Map(bank.items.map((i) => [i.id, i])));
  const expected = await json("fixtures/expected.json") as { scenarios: Scenario[] };
  assert(Array.isArray(expected.scenarios) && expected.scenarios.length === 14, "expected fourteen frozen scenarios");
  assert(new Set(expected.scenarios.map((s) => s.id)).size === 14, "scenario ids must be unique");
  const cases: MethodCase<CaseInput>[] = [];
  const scenarioDetails: object[] = [];
  const runData = new Map<string, RunFile>();
  const baselineContractMisses: object[] = [];
  const unknownCompliance: object[] = [];
  for (const scenario of expected.scenarios) {
    const runs: RunFile[] = [];
    for (const file of scenario.files) {
      assert(path.basename(file) === file && !file.includes(".."), "scenario filename must be a basename");
      const run = RunFileSchema.parse(await json(`fixtures/runs/${file}`));
      runs.push(run);
      runData.set(file, run); // s07 has two files; option/ruling variants do not duplicate timing rows.
    }
    for (const c of scenario.cases) {
      const id = `${scenario.id}/${c.name}`;
      const options = { ...DEFAULT_SELECTION_OPTIONS, ...c.options };
      const constraints = { ...defaultConstraints(options.objective), ...c.constraints };
      const result = RecommendResultSchema.parse(recommend(runs, constraints, options));
      cases.push({ id, input: { result }, expectedPick: c.expect.pick, expectedTied: c.expect.tied });
      scenarioDetails.push({ type: "scenario-decision", caseId: id, scenario: scenario.id, constraints, options,
        expectedKind: c.expect.kind, actualKind: result.kind, kindMatches: result.kind === c.expect.kind,
        expectedPick: c.expect.pick, actualPick: result.pick, baselines: result.baselines });
      for (const key of BASELINES) {
        const actual = result.baselines[key];
        const want = c.expect[key] === "unavailable" ? null : c.expect[key];
        const violationsMatch = JSON.stringify(actual.violations) === JSON.stringify(c.expect.baselineViolations[key]);
        if (actual.pick !== want || !violationsMatch) baselineContractMisses.push({
          type: "baseline-contract-miss", caseId: id, method: actual.method, expectedPick: want,
          actualPick: actual.pick, expectedViolations: c.expect.baselineViolations[key], actualViolations: actual.violations,
        });
        if (actual.pick !== null && result.perCandidate.find((p) => p.key === actual.pick)?.status !== "measured") {
          unknownCompliance.push({ type: "unknown-compliance", caseId: id, method: actual.method,
            pick: actual.pick, reason: actual.reason ?? "pick lacks an eligible measurement" });
        }
      }
    }
  }
  assert(cases.length === 17, "expected seventeen expanded option/ruling cases across fourteen scenarios");
  const methods: Method<CaseInput>[] = METHODS.map((name) => ({ name, run: ({ result }) => outcome(name, result) }));
  const comparison = compareMethods(methods, cases);
  const refs = statistics();
  const simulation = simulate();
  const timing = [...runData].flatMap(([file, run]) => run.candidates.map((candidate) => ({
    type: "run-cost-time", file, runId: run.runId, candidate: candidate.candidate.key,
    runtime: run.runtime, synthetic: run.synthetic, wallClockMs: candidate.wallClockMs,
    apiCostUsd: 0, costBasis: "local Ollama/mock has no billed API calls; excludes hardware, power and user time",
    timingBasis: run.synthetic ? "synthetic authored fixture value, not measured hardware wall-clock" : "collector run-file value",
  })));
  const references: ReferenceRow[] = [
    { name: "grader split issues", value: splitIssues.length, note: "Explicit hand assignment, not seededSplit; schema-valid, disjoint, matching seed/freeze, known items, 40/40." },
    ...graders.summaries.flatMap((r) => [
      { name: `${r.method} held-out correctness agreement`, value: r.correctnessAgreement, note: `${r.correctnessMatches}/${r.cases}; proposed correctness target >= .95, not an extraction target.` },
      { name: `${r.method} held-out extraction agreement`, value: r.extractionAgreement, note: `${r.extractionMatches}/${r.cases}; exact nullable expected extraction.` },
      { name: `${r.method} held-out combined agreement`, value: r.combinedAgreement, note: "Both correctness and extraction must match." },
    ]),
    { name: "baseline fixture contract misses", value: baselineContractMisses.length, note: "Separate from agreement with the expected recommender pick." },
    { name: "unknown baseline compliance cases", value: unknownCompliance.length, note: "Unmeasured estimate picks: zero known violations does not establish compliance." },
    ...comparison.map((r) => ({ name: `${r.method} tied outputs`, value: r.perCase.filter((c) => c.tied === true).length,
      note: r.method === "recommend" ? "Number of true tie flags across the expanded cases." : "No tie flag is implemented by this baseline; not a tie-detection success." })),
    ...refs.map((r) => ({ name: r.name, value: r.actual, note: `Hand reference ${r.expected}; tolerance ${r.tolerance}; matches=${r.matches}` })),
    ...simulation.flatMap((r) => Object.entries({ falseTie: r.falseTie, wrongDirectionSignificantWin: r.wrongDirectionSignificantWin,
      nullFalseDifference: r.nullFalseDifference, nullUnresolved: r.nullUnresolved })
      .filter(([, f]) => f !== null).map(([name, f]) => ({ name: `simulation ${r.trueA}/${r.trueB}: ${name}`,
        value: f?.rate ?? null, note: `count=${f?.count}; MCSE=${f?.mcse}; trials=${r.trials}; synthetic independent Bernoulli` }))),
    ...timing.map((r) => ({ name: `${r.file}: ${r.candidate} wall-clock ms`, value: r.wallClockMs, note: r.timingBasis })),
    { name: "API cost USD", value: 0, note: "No paid API in evaluation; excludes compute, electricity and time. Per-candidate rows are in JSONL." },
  ];
  let markdown = resultsMd(comparison, references, { notes: [
    "Produced by scripts/eval.ts from frozen synthetic fixtures, not a live case study. Case study: not yet measured.",
    "Fourteen specification scenarios expand to seventeen option/ruling cases; every method has the same case denominator. Expected-pick matches compare every method to the frozen recommender target, including null for none/refused.",
    "Baselines have no statistical tie flag: tieCases and tieCorrect are zero observations, not evidence of correct tie handling. recommend tieCases counts all stated true/false flags, not just tied outputs.",
    "Measured-limit violations count failing active filters, not violating picks. No pick contributes zero; unavailable methods and unmeasured estimate compliance must be read separately.",
    "Grader labels are builder-written; all disagreements (correctness OR extraction), expected values and actual values are named below and in JSONL. No grader is changed by this script.",
    "Simulation: mulberry32 seed 0x5332, 10000 trials per pair, 30 independent Bernoulli items per candidate, true pairs .65/.62, .65/.55, .65/.65, alpha .05, strict p < alpha. One stream in pair/trial/item order; draw A then B.",
    "Simulation chooses the observed leader post hoc (A on an observed tie). At positive true gaps, falseTie is non-rejection and wrongDirectionSignificantWin is a significant B win. At the null, nullFalseDifference is any significant direction and nullUnresolved is non-rejection. MCSE=sqrt(rate*(1-rate)/trials). Independence omits shared difficulty and correlation; these are not real paired power or equivalence estimates.",
  ] });
  const named: ReferenceRow[] = graders.disagreements.map((d) => ({
    name: `${d.method}: ${d.caseId} (${d.itemId})`, value: JSON.stringify(d.actual),
    note: `expected=${JSON.stringify(d.expected)}; traps=${d.traps.join(", ")}`,
  }));
  markdown += resultsMd([], named, { title: "Named held-out disagreements" });
  markdown += resultsMd([], comparison.flatMap((r) => r.perCase.map((c) => ({
    name: `${r.method}: ${c.caseId}`, value: c.pick ?? "no pick",
    note: `expected=${c.expectedPick ?? "no pick"}; match=${c.match}; violations=${c.limitViolations}; tied=${String(c.tied)}; tieCorrect=${String(c.tieCorrect)}`,
  }))), { title: "Per-case method decisions" });
  const records = [
    { type: "evaluation-metadata", schemaVersion: 1, generatedAt: new Date().toISOString(), synthetic: true,
      scenarioCount: expected.scenarios.length, expandedCases: cases.length, itemBankComplete: bank.complete,
      split: { seed: dev.seed, frozenAt: dev.frozenAt, dev: dev.cases.length, heldout: heldout.cases.length, issues: splitIssues },
      simulation: SIMULATION, caseStudy: "not yet measured" },
    ...graders.summaries.map((r) => ({ type: "grader-summary", ...r })), ...graders.disagreements,
    ...comparison.map((r) => ({ type: "method-summary", ...r })), ...scenarioDetails,
    ...baselineContractMisses, ...unknownCompliance, ...refs,
    ...simulation.map((r) => ({ type: "simulation", ...r })), ...timing,
  ];
  // All calculations finish before replacing the two generated artifacts. They are not a transaction;
  // a filesystem interruption can leave mismatched files: rerun only under the held-out policy.
  await mkdir(new URL("results/", ROOT), { recursive: true });
  await writeFile(new URL("results/results.md", ROOT), markdown, "utf8");
  await writeFile(new URL("results/results.jsonl", ROOT), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const correctness = graders.summaries.find((r) => r.method === "deterministic")?.correctnessAgreement ?? 0;
  const naive = graders.summaries.find((r) => r.method === "naive")?.correctnessAgreement ?? 0;
  const recommended = comparison.find((r) => r.method === "recommend");
  const failed = correctness < 0.95 || naive >= correctness || refs.some((r) => !r.matches) ||
    baselineContractMisses.length > 0 || recommended === undefined || recommended.expectedPickMatches !== cases.length ||
    recommended.limitViolations !== 0 || recommended.tieCorrect !== cases.length ||
    scenarioDetails.some((r) => "kindMatches" in r && r.kindMatches === false);
  process.stdout.write("Wrote results/results.md and results/results.jsonl; synthetic evidence only. Inspect named misses; retain frozen held-out labels.\n");
  if (failed) { process.stderr.write("One or more proposed evaluation targets were missed; inspect the generated records.\n"); process.exitCode = 1; }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--confirm-heldout") {
    process.stderr.write("After Dirty Mode closes and one held-out run is authorized: npm run eval -- --confirm-heldout\nNo held-out fixture loaded. Preserve the frozen set and do not tune against misses.\n");
    process.exitCode = 2;
  } else evaluate().catch((error: unknown) => {
    process.stderr.write(`${sanitizeForTerminal(error instanceof Error ? error.message : "evaluation failed")}\n`);
    process.exitCode = 1;
  });
}
