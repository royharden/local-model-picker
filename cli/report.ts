import * as path from "node:path";
import { markdownReport } from "../src/core/index.js";
import type { CliContext } from "./context.js";
import { EXIT } from "./context.js";
import { writeTextAtomic } from "./io/write.js";
import { loadSelectionRuns, parseSelectionArgs, selectionResults } from "./recommend.js";

/** Report both original grades and replayed append-only rulings with the same constraints. */
export async function reportCommand(argv: string[], ctx: CliContext): Promise<number> {
  const input = parseSelectionArgs(argv, true);
  const runs = await loadSelectionRuns(input.files, ctx);
  const { original, corrected } = selectionResults(runs, input);
  const text = markdownReport(runs, input.options.applyRulings ? corrected : original, input.constraints, input.options);
  if (input.outDir === undefined && input.mdFile === undefined) ctx.print(text);
  else {
    const saved = await writeTextAtomic(path.resolve(ctx.cwd, input.outDir ?? "."), input.mdFile ?? `report-${runs[0]?.runId ?? "runs"}.md`, text);
    if (!saved.ok) { ctx.printErr(saved.message); return EXIT.failure; }
    ctx.print(`Saved ${saved.path} (${saved.bytes} bytes)`);
  }
  return EXIT.ok;
}
