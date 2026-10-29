// Synthetic run-file builders for contract tests. Every value is invented test data, not a measurement.
import { candidateKeyOf, DEFAULT_PROTOCOL_CAPS, REDACTION_VERSION, MOCK_SCOPE_ID, GRADER_VERSION as CORE_GRADER_VERSION } from "../../src/core/index.js";
import type { RunFile, CandidateRun, SpeedRepeat, ItemResult, HardwareFingerprint, Ruling } from "../../src/core/index.js";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const GRADER_VERSION = CORE_GRADER_VERSION;
export const ITEM_IDS = ["num-01", "num-02", "choice-01", "inst-01", "extr-01"];
export const PROMPT_IDS = ["long-gen", "long-prompt", "mixed-chat"];
export const AT = "2026-10-24T15:00:00.000Z";

const GIB = 1024 * 1024 * 1024;

export function localFingerprint(): HardwareFingerprint {
  return {
    source: "local-probe",
    scopeId: null,
    cpuModel: "Synthetic CPU 8-core",
    cpuThreads: 16,
    ramBytes: 32 * GIB,
    os: { platform: "linux", release: "6.8.0" },
    gpu: { vendor: "nvidia", name: "Synthetic GPU 8GB", vramTotalBytes: 8 * GIB, unifiedMemory: false },
    canonical: {
      source: "local-probe",
      scopeId: null,
      cpuModel: "Synthetic CPU 8-core",
      cpuThreads: 16,
      ramGiB: 32,
      platform: "linux",
      gpuVendor: "nvidia",
      gpuName: "Synthetic GPU 8GB",
      vramGiB: 8,
    },
    hash: "0123456789ab",
  };
}

export function mockFingerprint(): HardwareFingerprint {
  return {
    source: "mock",
    scopeId: MOCK_SCOPE_ID,
    cpuModel: "Mock CPU",
    cpuThreads: 8,
    ramBytes: 16 * GIB,
    os: { platform: "mock", release: "1" },
    gpu: { vendor: "nvidia", name: "Mock GPU", vramTotalBytes: 8 * GIB, unifiedMemory: false },
    canonical: {
      source: "mock",
      scopeId: MOCK_SCOPE_ID,
      cpuModel: "Mock CPU",
      cpuThreads: 8,
      ramGiB: 16,
      platform: "mock",
      gpuVendor: "nvidia",
      gpuName: "Mock GPU",
      vramGiB: 8,
    },
    hash: "fedcba987654",
  };
}

export function speedRepeat(promptId: string, repeat: number): SpeedRepeat {
  return {
    promptId,
    repeat,
    valid: true,
    invalidReason: null,
    ttftMs: 120,
    ttfaMs: 120,
    loadMs: repeat === 0 ? 900 : 0,
    promptEvalCount: 30,
    promptEvalMs: 20,
    evalCount: 200,
    evalMs: 5000,
    genTokPerSec: 40,
    promptTokPerSec: 1500,
    thinkingObserved: false,
    usageRaw: { eval_count: 200, eval_duration: 5_000_000_000, load_duration: repeat === 0 ? 900_000_000 : 0 },
  };
}

export function fullSpeedSet(): SpeedRepeat[] {
  const out: SpeedRepeat[] = [];
  for (const p of PROMPT_IDS) for (let r = 0; r <= 3; r++) out.push(speedRepeat(p, r));
  return out;
}

export function itemResult(itemId: string, correct = true): ItemResult {
  return {
    itemId,
    raw: correct ? "Answer: 4" : "Answer: 5",
    truncated: false,
    flags: [],
    extracted: correct ? "4" : "5",
    correct,
    graderId: "numeric",
    graderVersion: GRADER_VERSION,
  };
}

export function measuredCandidate(tag = "llama3.1:8b-instruct-q4_K_M", digest = "0123456789abcdef".repeat(4)): CandidateRun {
  return {
    candidate: {
      key: candidateKeyOf(tag, digest),
      tag,
      digest,
      family: "llama",
      parameterSize: "8.0B",
      quantization: "Q4_K_M",
      sizeBytes: 4_900_000_000,
    },
    status: "measured",
    statusReason: null,
    speed: fullSpeedSet(),
    memory: [{ phase: "after-load", sizeBytes: 5_600_000_000, sizeVramBytes: 5_600_000_000, offloadFraction: 1, source: "api/ps" }],
    nvidiaPeakBytes: null,
    items: ITEM_IDS.map((id) => itemResult(id)),
    wallClockMs: 60_000,
    loadedByRun: true,
  };
}

/** A valid loopback Ollama run with one measured candidate (synthetic test data). */
export function makeRun(): RunFile {
  return {
    schemaVersion: 1,
    runId: "run-2026-10-24-a",
    createdAt: AT,
    tool: { name: "local-model-picker", version: "0.1.0" },
    runtime: "ollama",
    synthetic: true,
    seed: null,
    remote: false,
    endpointKind: "loopback",
    runtimeInfo: { ollamaVersion: "0.5.0" },
    fingerprint: localFingerprint(),
    availableMemory: { vramFreeBytes: 7 * GIB, ramFreeBytes: 20 * GIB, source: "nvidia-smi", at: AT },
    itemSetHash: HASH_A,
    itemIds: [...ITEM_IDS],
    graderVersion: GRADER_VERSION,
    protocol: {
      promptSetHash: HASH_B,
      temperature: 0,
      seed: 42,
      numCtx: 4096,
      numPredict: 512,
      think: "default",
      repeats: 3,
      warmups: 1,
      redactionVersion: REDACTION_VERSION,
      itemSetComplete: true,
      caps: { ...DEFAULT_PROTOCOL_CAPS },
    },
    protocolHash: HASH_C,
    flags: [],
    warnings: [],
    candidates: [measuredCandidate()],
    rulings: [],
  };
}

/** A valid mock run (runtime mock, synthetic, mock fingerprint, endpointKind mock). */
export function makeMockRun(): RunFile {
  const run = makeRun();
  return {
    ...run,
    runId: "run-mock-1",
    runtime: "mock",
    synthetic: true,
    seed: 0x5332,
    endpointKind: "mock",
    runtimeInfo: { ollamaVersion: null },
    fingerprint: mockFingerprint(),
    availableMemory: { vramFreeBytes: 7 * GIB, ramFreeBytes: 12 * GIB, source: "mock", at: AT },
  };
}

export function ruling(seq: number, overrides: Partial<Ruling> = {}): Ruling {
  const c = measuredCandidate();
  return {
    id: `ruling-${seq}`,
    seq,
    previousRulingId: null,
    kind: "grader_override",
    runId: "run-2026-10-24-a",
    candidateKey: c.candidate.key,
    itemId: "num-01",
    originalCorrect: true,
    overrideCorrect: false,
    correctedExtraction: null,
    reason: "the answer line gives 4 but the question asks for 5",
    by: "local-user",
    at: AT,
    ...overrides,
  };
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
