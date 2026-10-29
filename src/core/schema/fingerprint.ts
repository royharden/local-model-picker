// HardwareFingerprint and AvailableMemory (Claude §2.5, D2).
// The hash itself (first 12 hex of sha256 over the canonical JSON) is computed in the CLI with
// node:crypto (cli/hwprobe/fingerprint.ts); core only checks that `canonical` agrees with the
// descriptive fields and compares strings. `canonical` is kept beside the short hash so a
// collision is visible.
import { z } from "zod";
import { nonNegNumber, posInt, isoUtc } from "./common.js";
import { MOCK_SCOPE_ID } from "../config/defaults.js";

export const FINGERPRINT_SOURCES = ["local-probe", "remote-unknown", "mock"] as const;
export const GPU_VENDORS = ["nvidia", "apple", "unknown"] as const;

const BYTES_PER_GIB = 1024 * 1024 * 1024;

/** Rounded GiB used in the canonical (hashed) fingerprint; null stays null (unknown is never 0). */
export function roundGiB(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / BYTES_PER_GIB);
}

export const GpuInfoSchema = z
  .object({
    vendor: z.enum(GPU_VENDORS),
    name: z.string().min(1).max(200).nullable(),
    vramTotalBytes: nonNegNumber.nullable(),
    unifiedMemory: z.boolean().nullable(),
  })
  .strict();

/** The sanitised fields that were hashed. No hostname, user, path, IP or free memory. */
export const CanonicalFingerprintSchema = z
  .object({
    source: z.enum(FINGERPRINT_SOURCES),
    scopeId: z.string().min(1).max(200).nullable(),
    cpuModel: z.string().min(1).max(200).nullable(),
    cpuThreads: posInt.nullable(),
    ramGiB: z.number().int().nonnegative().nullable(),
    platform: z.string().min(1).max(50).nullable(),
    gpuVendor: z.enum(GPU_VENDORS),
    gpuName: z.string().min(1).max(200).nullable(),
    vramGiB: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const HardwareFingerprintSchema = z
  .object({
    source: z.enum(FINGERPRINT_SOURCES),
    scopeId: z.string().min(1).max(200).nullable(),
    cpuModel: z.string().min(1).max(200).nullable(),
    cpuThreads: posInt.nullable(),
    ramBytes: nonNegNumber.nullable(),
    os: z
      .object({ platform: z.string().min(1).max(50), release: z.string().min(1).max(100) })
      .strict()
      .nullable(),
    gpu: GpuInfoSchema,
    canonical: CanonicalFingerprintSchema,
    hash: z.string().regex(/^[0-9a-f]{12}$/, "fingerprint hash is the first 12 lowercase hex chars of sha256"),
  })
  .strict()
  .superRefine((fp, ctx) => {
    const c = fp.canonical;
    const mismatch = (field: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["canonical", field], message });
    };
    if (c.source !== fp.source) mismatch("source", "canonical.source must equal source");
    if (c.scopeId !== fp.scopeId) mismatch("scopeId", "canonical.scopeId must equal scopeId");
    if (c.cpuModel !== fp.cpuModel) mismatch("cpuModel", "canonical.cpuModel must equal cpuModel");
    if (c.cpuThreads !== fp.cpuThreads) mismatch("cpuThreads", "canonical.cpuThreads must equal cpuThreads");
    if (c.ramGiB !== roundGiB(fp.ramBytes)) mismatch("ramGiB", "canonical.ramGiB must be ramBytes rounded to whole GiB");
    if (c.platform !== (fp.os === null ? null : fp.os.platform)) mismatch("platform", "canonical.platform must equal os.platform");
    if (c.gpuVendor !== fp.gpu.vendor) mismatch("gpuVendor", "canonical.gpuVendor must equal gpu.vendor");
    if (c.gpuName !== fp.gpu.name) mismatch("gpuName", "canonical.gpuName must equal gpu.name");
    if (c.vramGiB !== roundGiB(fp.gpu.vramTotalBytes)) mismatch("vramGiB", "canonical.vramGiB must be gpu.vramTotalBytes rounded to whole GiB");

    // Scope rules (C1): local probes have no scope, mock uses the fixed synthetic scope,
    // remote-unknown is scoped to its own run (checked against runId in RunFileSchema).
    if (fp.source === "local-probe" && fp.scopeId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "local-probe fingerprints have scopeId null" });
    }
    if (fp.source === "mock" && fp.scopeId !== MOCK_SCOPE_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: `mock fingerprints have scopeId "${MOCK_SCOPE_ID}"` });
    }
    if (fp.source === "remote-unknown") {
      if (fp.scopeId === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "remote-unknown fingerprints are scoped to their runId" });
      }
      // The local probe never describes a remote server.
      const local =
        fp.cpuModel !== null || fp.cpuThreads !== null || fp.ramBytes !== null || fp.os !== null ||
        fp.gpu.vendor !== "unknown" || fp.gpu.name !== null || fp.gpu.vramTotalBytes !== null || fp.gpu.unifiedMemory !== null;
      if (local) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: "remote-unknown fingerprints carry no local CPU/RAM/OS/GPU fields" });
      }
    }
    // Apple unified memory: no invented dedicated VRAM figure.
    if (fp.gpu.vendor === "apple" && fp.gpu.vramTotalBytes !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gpu", "vramTotalBytes"], message: "Apple GPUs record vramTotalBytes null (unified memory)" });
    }
  });

export type GpuInfo = z.infer<typeof GpuInfoSchema>;
export type CanonicalFingerprint = z.infer<typeof CanonicalFingerprintSchema>;
export type HardwareFingerprint = z.infer<typeof HardwareFingerprintSchema>;
export type FingerprintSource = (typeof FINGERPRINT_SOURCES)[number];
export type GpuVendor = (typeof GPU_VENDORS)[number];

/**
 * Free memory captured at probe time, separate from the fingerprint (it changes between runs).
 * `mock` is added to Claude's source list so the synthetic mock profile can feed the
 * estimate-only baseline without pretending to be an OS measurement.
 */
export const AVAILABLE_MEMORY_SOURCES = ["nvidia-smi", "os.freemem", "unavailable", "mock"] as const;

export const AvailableMemorySchema = z
  .object({
    vramFreeBytes: nonNegNumber.nullable(),
    ramFreeBytes: nonNegNumber.nullable(),
    source: z.enum(AVAILABLE_MEMORY_SOURCES),
    at: isoUtc,
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.source === "unavailable" && (m.vramFreeBytes !== null || m.ramFreeBytes !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["source"], message: 'source "unavailable" requires both free-memory values to be null' });
    }
  });

export type AvailableMemory = z.infer<typeof AvailableMemorySchema>;
export type AvailableMemorySource = (typeof AVAILABLE_MEMORY_SOURCES)[number];
