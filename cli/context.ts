// CliContext: every side effect a command may use, injected so tests can pass fakes (fake fetch,
// fake clock, fake execFile, in-memory writer). Commands print ONLY through ctx.print / ctx.printErr,
// which apply sanitizeForTerminal, so untrusted text (model tags, runtime errors) cannot drive the terminal.
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import type { RunFile } from "../src/core/index.js";
import type { MonotonicClock, Timers, WallClock } from "./providers/clock.js";
import type { FetchLike } from "./providers/fetch-guard.js";
import type { ExecFileLike } from "./hwprobe/exec.js";
import type { OsInfo } from "./hwprobe/index.js";
import type { WriteResult } from "./io/write.js";

export const TOOL_NAME = "local-model-picker";
export const TOOL_VERSION = "0.1.0";

export interface CliContext {
  /** one line to stdout (sanitised) */
  print(text: string): void;
  /** one line to stderr (sanitised) */
  printErr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  clock: MonotonicClock;
  wall: WallClock;
  timers: Timers;
  /** network fetch; reached only through the fetch guard (cli/providers/fetch-guard.ts) */
  fetch: FetchLike;
  exec: ExecFileLike;
  os: OsInfo;
  /** aborted on Ctrl-C (first SIGINT) */
  signal: AbortSignal;
  writeRun(run: RunFile, outDir: string): Promise<WriteResult>;
  /** override for data/ (tests) */
  dataDir?: string;
}

/** A command handler: argv after the command name; returns the process exit code. */
export type CommandHandler = (argv: string[], ctx: CliContext) => Promise<number>;

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  interrupted: 130,
} as const;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Options = NonNullable<ParseArgsConfig["options"]>;

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** node:util parseArgs, strict, positionals allowed; parse errors become UsageError. */
export function parseCommandArgs(argv: string[], options: Options): ParsedArgs {
  try {
    const r = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
    return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : "invalid arguments");
  }
}

export function stringOpt(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Shared runtime options: the runtime is chosen ONLY by --runtime (default mock). */
export const RUNTIME_OPTIONS: Options = {
  runtime: { type: "string" },
  host: { type: "string" },
  "allow-remote": { type: "boolean", default: false },
  "mock-seed": { type: "string" },
};

export function parseIntOpt(v: string | undefined, name: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v.trim())) throw new UsageError(`--${name} must be an integer`);
  const n = Number(v.trim());
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}

/** --models a,b,c -> ["a","b","c"]; undefined when not given. */
export function parseModelList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (list.length === 0) throw new UsageError("--models needs at least one tag");
  return [...new Set(list)];
}
