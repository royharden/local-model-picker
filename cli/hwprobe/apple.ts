// Apple probe via `system_profiler SPDisplaysDataType -json` (Claude §2.7), macOS only. execFile,
// fixed arguments, no shell, 5 s timeout, 1 MB cap. Apple Silicon GPUs use unified memory, so no
// dedicated VRAM figure is invented (vramTotalBytes stays null). Failure -> null (GPU unknown).
import type { ExecFileLike } from "./exec.js";
import { PROBE_EXEC_OPTIONS } from "./exec.js";

export const SYSTEM_PROFILER = "system_profiler";
export const APPLE_QUERY_ARGS: readonly string[] = Object.freeze(["SPDisplaysDataType", "-json"]);

export interface AppleGpu {
  name: string;
  /** true for Apple Silicon (vendor Apple); false for a discrete GPU reported on an Intel Mac */
  appleSilicon: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseSystemProfiler(stdout: string): AppleGpu | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const list = parsed["SPDisplaysDataType"];
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const model = entry["sppci_model"] ?? entry["_name"];
    if (typeof model !== "string" || model.trim() === "") continue;
    const vendor = entry["spdisplays_vendor"];
    const vendorText = typeof vendor === "string" ? vendor : "";
    const appleSilicon = /apple/i.test(vendorText) || /^apple\b/i.test(model.trim());
    return { name: model.trim().slice(0, 200), appleSilicon };
  }
  return null;
}

export async function probeApple(exec: ExecFileLike): Promise<AppleGpu | null> {
  try {
    const r = await exec(SYSTEM_PROFILER, APPLE_QUERY_ARGS, PROBE_EXEC_OPTIONS);
    return parseSystemProfiler(r.stdout);
  } catch {
    return null;
  }
}
