// NVIDIA probe via nvidia-smi (Claude §2.7). execFile only, fixed argument array, no shell, 5 s
// timeout, 1 MB output cap. Missing tool, timeout, non-zero exit or unparseable output -> null
// (the caller records the GPU as unknown, never guessed). nvidia-smi reports MiB with nounits.
import type { ExecFileLike } from "./exec.js";
import { PROBE_EXEC_OPTIONS } from "./exec.js";

export const NVIDIA_SMI = "nvidia-smi";
export const NVIDIA_QUERY_ARGS: readonly string[] = Object.freeze([
  "--query-gpu=name,memory.total,memory.free,driver_version",
  "--format=csv,noheader,nounits",
]);

const MIB = 1024 * 1024;

export interface NvidiaGpu {
  name: string;
  vramTotalBytes: number;
  vramFreeBytes: number;
  driverVersion: string | null;
}

export interface NvidiaProbe {
  /** first GPU (multi-GPU is out of scope; the count is reported as a warning) */
  gpu: NvidiaGpu;
  gpuCount: number;
}

function mib(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const bytes = Number(t) * MIB;
  return Number.isFinite(bytes) ? bytes : null;
}

/** Parse `name, total, free, driver` CSV lines; a GPU name may itself contain commas. */
export function parseNvidiaSmi(stdout: string): NvidiaProbe | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const gpus: NvidiaGpu[] = [];
  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length < 4) continue;
    const driver = (parts[parts.length - 1] ?? "").trim();
    const free = mib(parts[parts.length - 2]);
    const total = mib(parts[parts.length - 3]);
    const name = parts.slice(0, parts.length - 3).join(",").trim();
    if (name === "" || total === null || free === null || free > total) continue;
    gpus.push({ name: name.slice(0, 200), vramTotalBytes: total, vramFreeBytes: free, driverVersion: driver === "" ? null : driver.slice(0, 50) });
  }
  const first = gpus[0];
  return first === undefined ? null : { gpu: first, gpuCount: gpus.length };
}

export async function probeNvidia(exec: ExecFileLike): Promise<NvidiaProbe | null> {
  try {
    const r = await exec(NVIDIA_SMI, NVIDIA_QUERY_ARGS, PROBE_EXEC_OPTIONS);
    return parseNvidiaSmi(r.stdout);
  } catch {
    return null;
  }
}
