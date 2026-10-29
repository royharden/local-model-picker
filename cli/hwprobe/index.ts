// Local hardware probe (Claude §2.7 `probe`; subpath export "./hwprobe"). CPU model and threads, RAM
// total/free, OS platform/release, GPU name + VRAM total/free (nvidia-smi; Apple system_profiler; else
// unknown). Produces the HardwareFingerprint (stable fields only, hashed) and AvailableMemory (changing
// values, NOT hashed). Host name, user name and home paths are never recorded; free text that comes
// from the OS (CPU model, GPU name) is sanitised and redacted with the host/user literals anyway.
// Remote runs never call this (the local probe never describes a server); mock runs use the fixed
// synthetic fingerprint from ./fingerprint.ts and never probe.
import * as nodeOs from "node:os";
import type { AvailableMemory, GpuInfo, HardwareFingerprint, RedactOptions } from "../../src/core/index.js";
import { redact, sanitizeForTerminal } from "../../src/core/index.js";
import type { WallClock } from "../providers/clock.js";
import type { ExecFileLike } from "./exec.js";
import { probeApple } from "./apple.js";
import { probeNvidia } from "./nvidia.js";
import { buildFingerprint, MOCK_HARDWARE, mockFingerprint } from "./fingerprint.js";

export * from "./fingerprint.js";
export * from "./exec.js";
export * from "./nvidia.js";
export * from "./apple.js";

/** The node:os surface the probe reads (injected in tests). */
export interface OsInfo {
  platform(): string;
  release(): string;
  cpus(): ReadonlyArray<{ model: string }>;
  totalmem(): number;
  freemem(): number;
  hostname(): string;
  /** null when the user name cannot be read */
  username(): string | null;
}

export function nodeOsInfo(): OsInfo {
  return {
    platform: () => nodeOs.platform(),
    release: () => nodeOs.release(),
    cpus: () => nodeOs.cpus(),
    totalmem: () => nodeOs.totalmem(),
    freemem: () => nodeOs.freemem(),
    hostname: () => nodeOs.hostname(),
    username: () => {
      try {
        return nodeOs.userInfo().username;
      } catch {
        return null;
      }
    },
  };
}

/** Redaction literals for this machine. Answers get host names only (D37); metadata gets both. */
export function redactionLiterals(info: OsInfo): { answers: RedactOptions; metadata: RedactOptions } {
  let host: string | null = null;
  try {
    host = info.hostname();
  } catch {
    host = null;
  }
  const hostnames = host !== null && host.trim() !== "" ? [host, host.split(".")[0] ?? host] : [];
  let user: string | null = null;
  try { user = info.username(); } catch { user = null; }
  const usernames = user !== null && user.trim() !== "" ? [user] : [];
  return { answers: { hostnames }, metadata: { hostnames, usernames } };
}

export interface ProbeResult {
  fingerprint: HardwareFingerprint;
  availableMemory: AvailableMemory;
  /** redacted, sanitised notes (e.g. "2 NVIDIA GPUs found; only the first is described") */
  warnings: string[];
}

export interface ProbeDeps {
  os: OsInfo;
  exec: ExecFileLike;
  wall: WallClock;
  redaction: RedactOptions;
}

function cleanText(s: string | null | undefined, max: number, redaction: RedactOptions): string | null {
  if (s === null || s === undefined) return null;
  const t = redact(sanitizeForTerminal(s), redaction).replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
}

function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Probe this machine. Never throws for a missing GPU tool; the GPU is then `unknown`. */
export async function probeLocal(deps: ProbeDeps): Promise<ProbeResult> {
  const warnings: string[] = [];
  const platform = cleanText(deps.os.platform(), 50, deps.redaction);
  const release = cleanText(deps.os.release(), 100, deps.redaction) ?? "unknown";
  const cpus = deps.os.cpus();
  const cpuModel = cleanText(cpus[0]?.model, 200, deps.redaction);
  const cpuThreads = cpus.length > 0 ? cpus.length : null;
  const ramBytes = finiteOrNull(deps.os.totalmem());
  const ramFreeBytes = finiteOrNull(deps.os.freemem());

  let gpu: GpuInfo = { vendor: "unknown", name: null, vramTotalBytes: null, unifiedMemory: null };
  let vramFreeBytes: number | null = null;
  let memorySource: AvailableMemory["source"] = "os.freemem";

  if (platform === "darwin") {
    const apple = await probeApple(deps.exec);
    if (apple === null) {
      warnings.push("system_profiler gave no usable GPU description; GPU recorded as unknown");
    } else if (apple.appleSilicon) {
      gpu = { vendor: "apple", name: cleanText(apple.name, 200, deps.redaction), vramTotalBytes: null, unifiedMemory: true };
    } else {
      gpu = { vendor: "unknown", name: cleanText(apple.name, 200, deps.redaction), vramTotalBytes: null, unifiedMemory: null };
      warnings.push("non-Apple GPU on macOS: VRAM is not probed; GPU recorded as unknown vendor");
    }
  } else {
    const nv = await probeNvidia(deps.exec);
    if (nv !== null) {
      gpu = { vendor: "nvidia", name: cleanText(nv.gpu.name, 200, deps.redaction), vramTotalBytes: nv.gpu.vramTotalBytes, unifiedMemory: false };
      vramFreeBytes = nv.gpu.vramFreeBytes;
      memorySource = "nvidia-smi";
      if (nv.gpuCount > 1) warnings.push(`${nv.gpuCount} NVIDIA GPUs found; only the first is described (multi-GPU is out of scope)`);
    } else {
      warnings.push("nvidia-smi not available or unparseable; GPU recorded as unknown (never guessed)");
    }
  }

  const fingerprint = buildFingerprint({
    source: "local-probe",
    scopeId: null,
    cpuModel,
    cpuThreads,
    ramBytes,
    os: platform === null ? null : { platform, release },
    gpu,
  });
  const at = deps.wall.nowIso();
  const availableMemory: AvailableMemory =
    ramFreeBytes === null && vramFreeBytes === null
      ? { vramFreeBytes: null, ramFreeBytes: null, source: "unavailable", at }
      : { vramFreeBytes, ramFreeBytes, source: memorySource, at };
  return { fingerprint, availableMemory, warnings: warnings.map((w) => redact(w, deps.redaction)) };
}

/** The fixed synthetic profile of mock runs (no probing at all). */
export function mockProbe(wall: WallClock): ProbeResult {
  return {
    fingerprint: mockFingerprint(),
    availableMemory: { vramFreeBytes: MOCK_HARDWARE.vramFreeBytes, ramFreeBytes: MOCK_HARDWARE.ramFreeBytes, source: "mock", at: wall.nowIso() },
    warnings: [],
  };
}
