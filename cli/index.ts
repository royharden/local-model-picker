#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { sanitizeForTerminal, redact } from "../src/core/index.js";
import type { CliContext, CommandHandler } from "./context.js";
import { EXIT, UsageError } from "./context.js";
import { discoverCommand } from "./discover.js";
import { probeCommand } from "./probe.js";
import { runCommand } from "./run.js";
import { recommendCommand } from "./recommend.js";
import { reportCommand } from "./report.js";
import { nodeExecFile, nodeOsInfo, redactionLiterals } from "./hwprobe/index.js";
import { writeRunFile } from "./io/write.js";
import { systemClock, systemTimers, systemWallClock } from "./providers/clock.js";
import { describeError } from "./providers/errors.js";

export const HELP = `Local Model Picker — construction complete; runtime unverified
Commands:
  probe [--json] [--runtime mock|ollama]
  discover [--models tag,...] [--json] [--runtime mock|ollama]
  run [--yes] [--models tag,...] [--out dir] [--runtime mock|ollama]
      [--seed integer] [--num-ctx integer] [--num-predict integer]
      [--timeout-gen seconds] [--mock-seed integer]
  recommend files... [--json] [--objective quality|speed] [--group key]
      [--constraint k=v ...] [--allow-mixed-hardware] [--accept-remote]
      [--ignore-rulings]
  report files... [--md report.md] [--out dir] [selection options as above]
      --md is a plain filename inside --out (default cwd); without --md/--out prints stdout.
Live endpoints: --host URL (or OLLAMA_HOST), --allow-remote for non-loopback.
Runtime defaults to mock. A host/key never selects live inference.
run without --yes performs no inference and writes nothing.
Constraints: minTokPerSec, maxTtftMs, maxMemoryGB, requireFullGpu,
fullGpuThreshold, minAccuracy, alpha, spreadThreshold. Use null to clear
maxMemoryGB/minAccuracy; speed requires minAccuracy. GPU: true|false|auto.
Original and human-corrected grades are both shown. No suggested command is executed.`;

export function createDefaultContext(signal: AbortSignal): CliContext {
  return {
    print: (text) => process.stdout.write(`${sanitizeForTerminal(text)}\n`),
    printErr: (text) => process.stderr.write(`${sanitizeForTerminal(text)}\n`),
    env: process.env, cwd: process.cwd(), signal,
    clock: systemClock(), wall: systemWallClock(), timers: systemTimers(),
    fetch: (url, init) => fetch(url, init), exec: nodeExecFile(), os: nodeOsInfo(), writeRun: writeRunFile,
  };
}

const handlers: Record<string, CommandHandler> = { probe: probeCommand, discover: discoverCommand, run: runCommand, recommend: recommendCommand, report: reportCommand };

/** Injectable dispatcher; importing this module never executes a command or installs signals. */
export async function dispatch(argv: string[], ctx: CliContext): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "help" || command === "-h") { ctx.print(HELP); return EXIT.ok; }
  const handler = handlers[command];
  if (handler === undefined) { ctx.printErr("unknown command; use --help"); return EXIT.usage; }
  if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) { ctx.print(HELP); return EXIT.ok; }
  try { return await handler(argv.slice(1), ctx); }
  catch (e) {
    const literals = redactionLiterals(ctx.os).metadata;
    ctx.printErr(redact(`error: ${describeError(e)}`, literals));
    return ctx.signal.aborted ? EXIT.interrupted : e instanceof UsageError ? EXIT.usage : EXIT.failure;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const interrupt = (): void => { if (!controller.signal.aborted) controller.abort(new Error("interrupted by Ctrl-C")); };
  process.on("SIGINT", interrupt); // repeated Ctrl-C keeps the partial-file write alive
  try { return await dispatch(argv, createDefaultContext(controller.signal)); }
  finally { process.removeListener("SIGINT", interrupt); }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, () => { process.stderr.write("CLI failed before initialization\n"); process.exitCode = EXIT.failure; });
}
