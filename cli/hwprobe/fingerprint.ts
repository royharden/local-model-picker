// Fingerprint hashing (Claude §2.5, D6): hash = first 12 hex of sha256 over the canonical JSON of the
// sanitised, stable fields { source, scopeId, cpuModel, cpuThreads, ramGiB, platform, gpuVendor,
// gpuName, vramGiB }. Free memory, host name, user name and paths are never part of it. Also the
// canonical-JSON + sha256 helpers used for protocolHash, itemSetHash and promptSetHash.
import { createHash } from "node:crypto";
import type { CanonicalFingerprint, GpuInfo, HardwareFingerprint } from "../../src/core/index.js";
import { MOCK_SCOPE_ID, roundGiB } from "../../src/core/index.js";

/**
 * Canonical JSON: object keys sorted (code-unit order) at every level, no whitespace, arrays in order.
 * Only JSON values are accepted; undefined object members are dropped as JSON.stringify drops them.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown, depth: number): string => {
    if (depth > 64) throw new RangeError("canonicalJson: nesting deeper than 64");
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new RangeError("canonicalJson: non-finite number");
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map((x) => walk(x, depth + 1)).join(",")}]`;
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(obj[k], depth + 1)}`).join(",")}}`;
    }
    throw new TypeError(`canonicalJson: unsupported value of type ${typeof v}`);
  };
  return walk(value, 0);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the canonical JSON of a value (protocolHash, itemSetHash, promptSetHash). */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const FINGERPRINT_HASH_CHARS = 12;

export interface FingerprintFields {
  source: HardwareFingerprint["source"];
  scopeId: string | null;
  cpuModel: string | null;
  cpuThreads: number | null;
  ramBytes: number | null;
  os: { platform: string; release: string } | null;
  gpu: GpuInfo;
}

export function canonicalOf(f: FingerprintFields): CanonicalFingerprint {
  return {
    source: f.source,
    scopeId: f.scopeId,
    cpuModel: f.cpuModel,
    cpuThreads: f.cpuThreads,
    ramGiB: roundGiB(f.ramBytes),
    platform: f.os === null ? null : f.os.platform,
    gpuVendor: f.gpu.vendor,
    gpuName: f.gpu.name,
    vramGiB: roundGiB(f.gpu.vramTotalBytes),
  };
}

export function fingerprintHash(canonical: CanonicalFingerprint): string {
  return sha256Hex(canonicalJson(canonical)).slice(0, FINGERPRINT_HASH_CHARS);
}

export function buildFingerprint(f: FingerprintFields): HardwareFingerprint {
  const canonical = canonicalOf(f);
  return {
    source: f.source,
    scopeId: f.scopeId,
    cpuModel: f.cpuModel,
    cpuThreads: f.cpuThreads,
    ramBytes: f.ramBytes,
    os: f.os,
    gpu: f.gpu,
    canonical,
    hash: fingerprintHash(canonical),
  };
}

const GIB = 1024 * 1024 * 1024;

/** Mock GPU total and free memory (synthetic profile; feeds the estimate-only baseline in mock runs). */
export const MOCK_HARDWARE = {
  cpuModel: "Mock CPU 8-core (synthetic)",
  cpuThreads: 16,
  ramBytes: 32 * GIB,
  os: { platform: "mock", release: MOCK_SCOPE_ID },
  gpuName: "Mock GPU 8 GB (synthetic)",
  vramTotalBytes: 8 * GIB,
  vramFreeBytes: 7.5 * GIB,
  ramFreeBytes: 20 * GIB,
} as const;

/** The fixed synthetic mock fingerprint: identical on every machine, so mock samples always group together. */
export function mockFingerprint(): HardwareFingerprint {
  return buildFingerprint({
    source: "mock",
    scopeId: MOCK_SCOPE_ID,
    cpuModel: MOCK_HARDWARE.cpuModel,
    cpuThreads: MOCK_HARDWARE.cpuThreads,
    ramBytes: MOCK_HARDWARE.ramBytes,
    os: { ...MOCK_HARDWARE.os },
    gpu: { vendor: "nvidia", name: MOCK_HARDWARE.gpuName, vramTotalBytes: MOCK_HARDWARE.vramTotalBytes, unifiedMemory: false },
  });
}

/** A remote server is never described by the local probe: no local fields, scoped to its own run (C1). */
export function remoteFingerprint(runId: string): HardwareFingerprint {
  return buildFingerprint({
    source: "remote-unknown",
    scopeId: runId,
    cpuModel: null,
    cpuThreads: null,
    ramBytes: null,
    os: null,
    gpu: { vendor: "unknown", name: null, vramTotalBytes: null, unifiedMemory: null },
  });
}
