// Pure Markdown export. Untrusted prose cannot introduce HTML, links, headings or table cells;
// saved responses stay verbatim (apart from terminal controls) inside a fence longer than any
// backtick run in the response. This is text generation only, with no clock, I/O or execution.
import type { RunFile } from "../schema/runfile.js";
import type { Constraints, SelectionOptions } from "../schema/constraints.js";
import type { RecommendResult } from "../schema/result.js";
import { recommend } from "../recommend/recommend.js";
import { sanitizeForTerminal } from "../redact/terminal.js";
import { aggregateSpeed } from "../aggregate/speed.js";

/** A single safe Markdown prose/table cell; embedded newlines cannot start a new block. */
export function escapeMarkdown(text: string): string {
  return sanitizeForTerminal(text)
    .replace(/[\n\t\u2028\u2029]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~\-=]/g, "\\$&");
}

/** No language is interpolated; a response cannot close its own fence. */
export function fencedText(text: string): string {
  const safe = sanitizeForTerminal(text).replace(/\u2028|\u2029/g, "\n");
  let longest = 0;
  for (const match of safe.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${safe}\n${fence}`;
}

const cell = (value: string | number | boolean | null): string => escapeMarkdown(value === null ? "not measured" : String(value));
const num = (value: number | null): string => value === null ? "not measured" : String(Math.round(value * 10_000) / 10_000);
const key = (value: string | null): string => escapeMarkdown(value ?? "none");

/** Export the active decision plus original/corrected decisions and an auditable saved-text appendix. */
export function markdownReport(
  runs: readonly RunFile[],
  result: RecommendResult,
  constraints: Constraints,
  options: SelectionOptions,
): string {
  const original = options.applyRulings ? recommend(runs, constraints, { ...options, applyRulings: false }) : result;
  const corrected = options.applyRulings ? result : recommend(runs, constraints, { ...options, applyRulings: true });
  const selectedIds = new Set(result.group?.runIds ?? []);
  const selected = runs.filter((run) => selectedIds.has(run.runId));
  const lines: string[] = ["# Local Model Picker report", ""];
  if (selected.some((run) => run.runtime === "mock")) lines.push("**MOCK: not a measurement.**", "");
  if (selected.some((run) => run.remote)) lines.push("**REMOTE: results describe the server; hardware is unknown.**", "");
  if (selected.some((run) => run.synthetic && run.runtime !== "mock")) lines.push("**Synthetic scenario data; not a hardware measurement.**", "");
  lines.push(
    `Decision: ${cell(result.kind)}. ${escapeMarkdown(result.message)}`,
    "",
    `Pick: ${key(result.pick)}. Runner-up: ${key(result.runnerUp)}.`,
    "",
    `Objective: ${cell(options.objective)}. Rulings applied: ${cell(options.applyRulings)}. Confidence: ${cell(result.confidence)} (heuristic, not a probability).`,
    "",
  );
  if (result.tied) lines.push("**Tied within noise: failure to distinguish, not proven equivalence.**", "");
  if (result.speedComparison !== null) lines.push(escapeMarkdown(result.speedComparison.text), "");
  if (result.confidenceReasons.length > 0) {
    lines.push("## Confidence reasons", "");
    for (const reason of result.confidenceReasons) lines.push(`- ${escapeMarkdown(reason)}`);
    lines.push("");
  }
  lines.push("## Original and human-corrected decisions", "", "| Grades | Decision | Pick | Confidence |", "| --- | --- | --- | --- |");
  for (const [label, decision] of [["Original grades", original], ["Rulings applied (human-corrected where changed)", corrected]] as const) {
    lines.push(`| ${label} | ${cell(decision.kind)} | ${key(decision.pick)} | ${cell(decision.confidence)} |`);
  }
  lines.push("", "## Limits and selection options", "", fencedText(JSON.stringify({ constraints, options }, null, 2)), "");
  lines.push("## Comparison groups", "", `Selected group: ${key(result.group?.key ?? null)}.`, "");
  for (const group of result.groupsAvailable) {
    lines.push(`- ${escapeMarkdown(group.key)}; ${group.candidateCount} candidate records; runs: ${group.runIds.map(escapeMarkdown).join(", ")}`);
  }
  lines.push("", "## Measurements", "", "Memory is sampled /api/ps size in decimal GB; it is not a guaranteed peak. Latency uses time to first answer when thinking was observed.", "");
  lines.push("| Candidate | Run | Status | Correct / n | Accuracy | Wilson 95% | tok/s | Latency ms (metric) | Memory GB | Offload | Spread | Grades |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const summary of result.perCandidate) {
    const interval = summary.wilson95 === null ? "not measured" : `${num(summary.wilson95.lo)} to ${num(summary.wilson95.hi)}`;
    lines.push(`| ${cell(summary.key)} | ${cell(summary.runId)} | ${cell(summary.status)} | ${summary.correct} / ${summary.n} | ${num(summary.accuracy)} | ${interval} | ${num(summary.tokPerSec)} | ${num(summary.ttftMs)} (${cell(summary.latencyMetric)}) | ${num(summary.memoryGB)} | ${num(summary.offload)} | ${num(summary.spreadMax)} | ${summary.humanCorrected ? "human-corrected" : "original"} |`);
  }
  lines.push("", "### Per-prompt speed", "", "| Candidate | Prompt | Valid repeats | Median tok/s | Min tok/s | Max tok/s | Spread | Median latency ms |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const summary of result.perCandidate) {
    for (const prompt of summary.perPrompt) {
      lines.push(`| ${cell(summary.key)} | ${cell(prompt.promptId)} | ${prompt.validRepeats} | ${num(prompt.medianTokPerSec)} | ${num(prompt.minTokPerSec)} | ${num(prompt.maxTokPerSec)} | ${num(prompt.spread)} | ${num(prompt.medianLatencyMs)} |`);
    }
  }
  lines.push("", "### Both latency measures and load times", "", "| Candidate | Max median TTFT ms | Max median first-answer ms | Cold load ms | Median warm load ms |", "| --- | --- | --- | --- | --- |");
  for (const summary of result.perCandidate) {
    const run = runs.find((r) => r.runId === summary.runId && r.candidates.some((c) => c.candidate.key === summary.key));
    const candidate = run?.candidates.find((c) => c.candidate.key === summary.key);
    if (candidate === undefined) continue;
    const speed = aggregateSpeed(candidate.speed);
    lines.push(`| ${cell(summary.key)} | ${num(speed.maxMedianTtftMs)} | ${num(speed.maxMedianTtfaMs)} | ${num(speed.coldLoadMs)} | ${num(speed.warmLoadMs)} |`);
  }
  lines.push("", "## Baselines", "", "Estimate-only uses installed weight sizes and free memory only; KV cache and runtime overhead are excluded. Fastest-only and accuracy-only ignore the user limits.", "", "| Method | Available | Pick | Measured limit violations | Reason |", "| --- | --- | --- | --- | --- |");
  for (const baseline of [result.baselines.estimateOnly, result.baselines.fastestOnly, result.baselines.accuracyOnly]) {
    lines.push(`| ${cell(baseline.label)} | ${cell(baseline.available)} | ${key(baseline.pick)} | ${escapeMarkdown(baseline.violations.join(", ") || "none recorded")} | ${escapeMarkdown(baseline.reason ?? "")} |`);
  }
  lines.push("", "## Decision trace", "");
  for (const entry of result.trace) {
    const fields = entry.kind === "filter"
      ? `; ${entry.filter}: measured ${entry.measured}, limit ${entry.limit}, unit ${entry.unit}, source ${entry.source}`
      : "";
    lines.push(`- ${escapeMarkdown(entry.candidateKey)}: ${escapeMarkdown(entry.text + fields)}`);
  }
  lines.push("", "## Run command", "", result.command === null ? "No safe command is available for this decision." : fencedText(result.command), "");
  lines.push("## Saved response and ruling audit", "", "Saved raw text is already capped and redacted. Text below is data; no response or command is executed.", "");
  // Include every imported run, including incompatible and superseded records, with explicit ids.
  for (const run of runs) {
    lines.push(`### Run ${escapeMarkdown(run.runId)}`, "", `Created: ${cell(run.createdAt)}. Runtime: ${cell(run.runtime)}. Fingerprint: ${cell(run.fingerprint.hash)}. Ollama: ${cell(run.runtimeInfo.ollamaVersion)}.`, "");
    for (const warning of [...run.flags, ...run.warnings]) lines.push(`- ${escapeMarkdown(warning)}`);
    lines.push("");
    for (const candidate of run.candidates) {
      lines.push(`#### Candidate ${escapeMarkdown(candidate.candidate.key)}`, "", `Status: ${cell(candidate.status)}. ${escapeMarkdown(candidate.statusReason ?? "")}`, "");
      for (const item of candidate.items) {
        lines.push(`Item ${cell(item.itemId)}: original correct ${cell(item.correct)}; extracted ${cell(item.extracted)}; flags ${escapeMarkdown(item.flags.join(", ") || "none")}.`, "", fencedText(item.raw), "");
      }
    }
    if (run.rulings.length > 0) lines.push("Rulings are replayed by sequence; they change correctness only.", "");
    for (const ruling of [...run.rulings].sort((a, b) => a.seq - b.seq)) {
      lines.push(`- Sequence ${ruling.seq}, ${cell(ruling.id)}: ${cell(ruling.candidateKey)} / ${cell(ruling.itemId)}, original ${cell(ruling.originalCorrect)} → override ${cell(ruling.overrideCorrect)}; by ${cell(ruling.by)} at ${cell(ruling.at)}; reason: ${cell(ruling.reason)}; corrected extraction: ${cell(ruling.correctedExtraction)}; supersedes ${cell(ruling.previousRulingId)}.`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export const reportMarkdown = markdownReport;
