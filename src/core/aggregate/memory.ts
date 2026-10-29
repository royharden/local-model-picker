// Memory aggregation (Claude §2.6 "Memory"). memoryGB = the MAXIMUM observed /api/ps size across
// the candidate's observations / 1e9 (decimal GB). offload = the MINIMUM valid observed
// size_vram / size. These are samples, not guaranteed peaks (LIMITATIONS). No observation means
// "not measured" (null), which fails maxMemoryGB (when set) and an applied requireFullGpu; it is
// never treated as 0.
import type { MemoryObservation } from "../schema/candidate.js";

/** Decimal gigabyte, as labelled in the UI and the trace. */
export const BYTES_PER_GB = 1e9;

export interface MemoryAggregate {
  /** False when the candidate has no /api/ps observation. */
  measured: boolean;
  maxSizeBytes: number | null;
  memoryGB: number | null;
  /** Min valid offloadFraction (size_vram / size); null when no valid observation. */
  offload: number | null;
  observations: number;
}

export function aggregateMemory(memory: readonly MemoryObservation[]): MemoryAggregate {
  let maxSize: number | null = null;
  let minOffload: number | null = null;
  for (const m of memory) {
    if (Number.isFinite(m.sizeBytes) && m.sizeBytes >= 0 && (maxSize === null || m.sizeBytes > maxSize)) maxSize = m.sizeBytes;
    // Derive from the observed byte counts. The stored fraction is checked on import but is
    // redundant; never let a stale cached scalar replace the actual /api/ps observation.
    const valid = Number.isFinite(m.sizeBytes) && m.sizeBytes > 0 && Number.isFinite(m.sizeVramBytes)
      && m.sizeVramBytes >= 0 && m.sizeVramBytes <= m.sizeBytes;
    const f = valid ? m.sizeVramBytes / m.sizeBytes : null;
    if (f !== null && (minOffload === null || f < minOffload)) minOffload = f;
  }
  return {
    measured: maxSize !== null,
    maxSizeBytes: maxSize,
    memoryGB: maxSize === null ? null : maxSize / BYTES_PER_GB,
    offload: minOffload,
    observations: memory.length,
  };
}
