import type { RunFile } from "../../src/core/index.js";
import type { CliContext } from "../../cli/context.js";
import { createManualClock, fixedWallClock, systemTimers } from "../../cli/providers/clock.js";

export function fakeContext(controller = new AbortController()): { ctx: CliContext; lines: string[]; errors: string[]; saved: RunFile[]; probes: string[]; network: string[] } {
  const lines: string[] = [], errors: string[] = [], saved: RunFile[] = [], probes: string[] = [], network: string[] = [];
  const unexpectedOs = (): never => { probes.push("os"); throw new Error("unexpected local probe"); };
  const ctx: CliContext = {
    cwd: process.cwd(), env: { OLLAMA_HOST: "http://remote.invalid:11434", OLLAMA_API_KEY: "never-selects-live" },
    print: (s) => { lines.push(s); }, printErr: (s) => { errors.push(s); },
    clock: createManualClock(), wall: fixedWallClock("2026-10-24T12:00:00.000Z"), timers: systemTimers(), signal: controller.signal,
    fetch: async (url) => { network.push(url); throw new Error("unexpected real network"); },
    exec: async (file) => { probes.push(file); throw new Error("unexpected process"); },
    os: { platform: unexpectedOs, release: unexpectedOs, cpus: unexpectedOs, totalmem: unexpectedOs, freemem: unexpectedOs, hostname: unexpectedOs, username: unexpectedOs },
    writeRun: async (run, outDir) => { saved.push(structuredClone(run)); return { ok: true, path: `${outDir}/${run.runId}.json`, bytes: 100 }; },
  };
  return { ctx, lines, errors, saved, probes, network };
}
