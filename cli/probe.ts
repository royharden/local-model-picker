import { DEFAULT_PROTOCOL_CAPS, redact } from "../src/core/index.js";
import type { CliContext } from "./context.js";
import { EXIT, RUNTIME_OPTIONS, UsageError, parseCommandArgs } from "./context.js";
import { mockProbe, probeLocal, redactionLiterals } from "./hwprobe/index.js";
import { remoteFingerprint } from "./hwprobe/fingerprint.js";
import { runIdFromIso } from "./providers/clock.js";
import { selectRuntime } from "./providers/select.js";
import { describeError } from "./providers/errors.js";

export async function probeCommand(argv: string[], ctx: CliContext): Promise<number> {
  const args = parseCommandArgs(argv, { ...RUNTIME_OPTIONS, json: { type: "boolean", default: false } });
  if (args.positionals.length) throw new UsageError("probe takes no positional arguments");
  const choice = selectRuntime(args.values, ctx, { ...DEFAULT_PROTOCOL_CAPS }, []);
  const redaction = choice.kind === "mock" || choice.remote ? {} : redactionLiterals(ctx.os).metadata;
  for (const note of choice.notes) ctx.printErr(`note: ${note}`);
  const at = ctx.wall.nowIso();
  const result = choice.kind === "mock" ? mockProbe(ctx.wall) : choice.remote ? {
    fingerprint: remoteFingerprint(runIdFromIso(at)),
    availableMemory: { vramFreeBytes: null, ramFreeBytes: null, source: "unavailable" as const, at },
    warnings: ["REMOTE endpoint: local hardware is never probed to describe the server"],
  } : await probeLocal({ os: ctx.os, exec: ctx.exec, wall: ctx.wall, redaction });
  let ollamaVersion: string | null = null;
  if (choice.kind === "ollama") {
    try { ollamaVersion = redact(await choice.runtime.version(ctx.signal) ?? "unknown", redaction); }
    catch (e) { result.warnings.push(redact(`version unavailable: ${describeError(e)}`, redaction)); }
  }
  const output = { runtime: choice.kind, endpointKind: choice.endpointKind, synthetic: choice.kind === "mock", ...result, runtimeInfo: { ollamaVersion } };
  if (args.values["json"] === true) ctx.print(JSON.stringify(output, null, 2));
  else {
    if (choice.kind === "mock") ctx.print("MOCK DATA: fixed synthetic hardware; no machine was probed");
    ctx.print(`Fingerprint: ${result.fingerprint.hash} (${result.fingerprint.source})`);
    ctx.print(`CPU: ${result.fingerprint.cpuModel ?? "unknown"}; threads: ${result.fingerprint.cpuThreads ?? "unknown"}`);
    ctx.print(`GPU: ${result.fingerprint.gpu.name ?? "unknown"}; VRAM: ${result.fingerprint.gpu.vramTotalBytes ?? "unknown"} bytes`);
    ctx.print(`Available memory: ${JSON.stringify(result.availableMemory)}`);
    ctx.print(`Ollama version: ${ollamaVersion ?? "not contacted (mock)"}`);
    for (const warning of result.warnings) ctx.printErr(`warning: ${warning}`);
  }
  return ctx.signal.aborted ? EXIT.interrupted : EXIT.ok;
}
