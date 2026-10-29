import * as path from "node:path";
import type { Constraints, RunFile, SelectionOptions } from "../src/core/index.js";
import { ConstraintsSchema, SelectionOptionsSchema, defaultConstraints, recommend } from "../src/core/index.js";
import type { CliContext } from "./context.js";
import { EXIT, UsageError, parseCommandArgs, stringOpt } from "./context.js";
import { readRunFileFromPath } from "./io/read.js";
import { isSafeFileName } from "./io/write.js";

export interface SelectionInput {
  files: string[];
  constraints: Constraints;
  options: SelectionOptions;
  json: boolean;
  outDir: string | undefined;
  /** Report --md is a plain filename inside outDir (cwd when outDir is omitted). */
  mdFile: string | undefined;
}

/** Repeated --constraint k=v is explicit; no eval, property paths or implicit numeric coercion. */
export function parseSelectionArgs(argv: string[], report = false): SelectionInput {
  const ordinary: string[] = [];
  const overrides: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--constraint") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new UsageError("--constraint needs k=v");
      overrides.push(next);
    } else if (token.startsWith("--constraint=")) overrides.push(token.slice(13));
    else ordinary.push(token);
  }
  const parsed = parseCommandArgs(ordinary, { objective: { type: "string" }, group: { type: "string" }, "allow-mixed-hardware": { type: "boolean", default: false }, "accept-remote": { type: "boolean", default: false }, "ignore-rulings": { type: "boolean", default: false }, ...(report ? { out: { type: "string" }, md: { type: "string" } } : { json: { type: "boolean", default: false } }) });
  if (!parsed.positionals.length) throw new UsageError(`${report ? "report" : "recommend"} needs at least one run-file path`);
  const mdFile = stringOpt(parsed.values["md"]);
  if (mdFile !== undefined && !isSafeFileName(mdFile)) throw new UsageError("--md needs a plain filename (for example report.md); choose its directory with --out, default cwd");
  const objective = stringOpt(parsed.values["objective"]) ?? "quality";
  if (objective !== "quality" && objective !== "speed") throw new UsageError("--objective must be quality or speed");
  const constraints: Constraints = defaultConstraints(objective);
  const mutable = constraints as unknown as Record<string, unknown>;
  for (const override of overrides) {
    const equal = override.indexOf("=");
    const key = override.slice(0, equal);
    const text = override.slice(equal + 1);
    if (equal <= 0 || !Object.hasOwn(constraints, key)) throw new UsageError("unknown constraint; use minTokPerSec, maxTtftMs, maxMemoryGB, requireFullGpu, fullGpuThreshold, minAccuracy, alpha or spreadThreshold");
    if (key === "requireFullGpu") {
      if (text !== "true" && text !== "false" && text !== "auto") throw new UsageError("requireFullGpu must be true, false or auto");
      mutable[key] = text === "auto" ? "auto" : text === "true";
    } else if (text === "null" && (key === "maxMemoryGB" || key === "minAccuracy")) mutable[key] = null;
    else {
      if (text.trim() === "" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new UsageError(`constraint ${key} needs a finite number`);
      mutable[key] = Number(text);
    }
  }
  const valid = ConstraintsSchema.safeParse(constraints);
  if (!valid.success) throw new UsageError(`invalid constraint: ${valid.error.issues[0]?.message ?? "schema error"}`);
  if (objective === "speed" && constraints.minAccuracy === null) throw new UsageError("speed objective requires an explicit minAccuracy (proposed default 0.6)");
  const options: SelectionOptions = SelectionOptionsSchema.parse({ objective, groupKey: stringOpt(parsed.values["group"]) ?? null, allowMixedHardware: parsed.values["allow-mixed-hardware"] === true, acceptRemote: parsed.values["accept-remote"] === true, applyRulings: parsed.values["ignore-rulings"] !== true });
  return { files: parsed.positionals, constraints, options, json: parsed.values["json"] === true, outDir: stringOpt(parsed.values["out"]), mdFile };
}

export async function loadSelectionRuns(files: readonly string[], ctx: CliContext): Promise<RunFile[]> {
  const runs: RunFile[] = [];
  for (const file of files) {
    const parsed = await readRunFileFromPath(path.resolve(ctx.cwd, file));
    if (!parsed.ok) throw new UsageError(`cannot import run file: ${parsed.errors.map((e) => `${e.path}: ${e.message}`).slice(0, 5).join("; ")}`);
    if (runs.some((r) => r.runId === parsed.value.runId)) throw new UsageError("duplicate runId in input files; pass each run only once");
    runs.push(parsed.value);
  }
  return runs;
}

export function selectionResults(runs: RunFile[], input: SelectionInput): { original: ReturnType<typeof recommend>; corrected: ReturnType<typeof recommend> } {
  return {
    original: recommend(runs, input.constraints, { ...input.options, applyRulings: false }),
    corrected: recommend(runs, input.constraints, { ...input.options, applyRulings: true }),
  };
}

export async function recommendCommand(argv: string[], ctx: CliContext): Promise<number> {
  const input = parseSelectionArgs(argv);
  const runs = await loadSelectionRuns(input.files, ctx);
  const results = selectionResults(runs, input);
  if (input.json) ctx.print(JSON.stringify({ constraints: input.constraints, options: input.options, ...results }, null, 2));
  else {
    if (runs.some((run) => run.runtime === "mock")) ctx.print("MOCK DATA: synthetic evidence, not a measurement");
    if (runs.some((run) => run.remote)) ctx.print(`REMOTE evidence; requireFullGpu=${input.constraints.requireFullGpu}; acceptRemote=${input.options.acceptRemote}`);
    ctx.print(`Constraints (proposed defaults unless supplied): ${JSON.stringify(input.constraints)}`);
    for (const [label, result] of [["Original", results.original], ["Human-corrected", results.corrected]] as const) {
      ctx.print(`${label}: ${result.message}`);
      ctx.print(`Pick: ${result.pick ?? "none"}; runner-up: ${result.runnerUp ?? "none"}; confidence: ${result.confidence}`);
      if (result.tied) ctx.print("Tied within noise: failure to distinguish quality, not proof of equivalence");
      for (const reason of result.confidenceReasons) ctx.print(`  confidence: ${reason}`);
      for (const trace of result.trace) ctx.print(`  ${trace.candidateKey ?? "group"}: ${trace.text}`);
      for (const group of result.groupsAvailable) ctx.print(`  available group: ${group.key}`);
      ctx.print(`Baselines: ${JSON.stringify(result.baselines)}`);
      if (result.command !== null) ctx.print(`Suggested command (text only): ${result.command}`);
    }
  }
  return (input.options.applyRulings ? results.corrected : results.original).kind === "refused" ? EXIT.failure : EXIT.ok;
}
