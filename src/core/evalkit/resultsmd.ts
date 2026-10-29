// results/results.md generator. A null cell renders as "pending": results.md ships with every
// numeric cell pending until scripts/eval.ts has actually run (M6); README quotes only it.
import { sanitizeForTerminal } from "../redact/terminal.js";

export type Cell = number | string | null;

/** One method row; nulls render as "pending". ComparisonRow from compare.ts fits this shape. */
export interface MethodSummaryRow {
  method: string;
  cases: number | null;
  expectedPickMatches: number | null;
  limitViolations: number | null;
  tieCases: number | null;
  tieCorrect: number | null;
}

/** Reference rows: statistics references, simulation, grader agreement, wall-clock, cost. */
export interface ReferenceRow {
  name: string;
  value: Cell;
  note?: string;
}

export interface ResultsMdOptions {
  title?: string;
  /** free-text lines placed under the title (seed, trial count, generated-by line) */
  notes?: readonly string[];
}

export const PENDING = "pending";

function escapeCell(s: string): string {
  return sanitizeForTerminal(s)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    // `&` first, so a literal "&lt;" in the input stays visible as text instead of becoming "<".
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n\t]+/g, " ");
}

export function formatCell(v: Cell): string {
  if (v === null) return PENDING;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return PENDING;
    return Number.isInteger(v) ? String(v) : v.toFixed(4);
  }
  return escapeCell(v);
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function resultsMd(
  rows: readonly MethodSummaryRow[],
  baselines: readonly ReferenceRow[],
  options: ResultsMdOptions = {},
): string {
  const out: string[] = [`# ${escapeCell(options.title ?? "Results")}`, ""];
  for (const n of options.notes ?? []) out.push(escapeCell(n), "");
  out.push(
    "Cells marked `pending` have not been produced by `npm run eval` yet. The scenario rows are specification tests of the rule, not an accuracy estimate.",
    "",
    "## Methods on the specification scenarios",
    "",
    table(
      ["Method", "Cases", "Expected-pick matches", "Measured-limit violations", "Tie cases", "Tie correct"],
      rows.map((r) => [
        escapeCell(r.method),
        formatCell(r.cases),
        formatCell(r.expectedPickMatches),
        formatCell(r.limitViolations),
        formatCell(r.tieCases),
        formatCell(r.tieCorrect),
      ]),
    ),
    "",
    "## Reference rows",
    "",
    table(
      ["Row", "Value", "Note"],
      baselines.map((b) => [escapeCell(b.name), formatCell(b.value), b.note === undefined ? "" : escapeCell(b.note)]),
    ),
    "",
  );
  return out.join("\n");
}
