// Providers-shaped runtime interface (PLAN.md §3, D6). Pure types only: no fetch, clock or process.
// Implemented by cli/providers/ollama.ts (real fetch through the fetch guard) and
// cli/providers/mock.ts (fake fetch serving Ollama-shaped bodies through the same parsers in
// src/core/providers/ollama-parse.ts and ndjson.ts, with an injected monotonic clock).
// Seam owner: S32-INT.

export interface ModelDetails {
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  format: string | null;
}

/** One entry of GET /api/tags. */
export interface ModelSummary {
  /** tag, e.g. "llama3.1:8b-instruct-q4_K_M" (untrusted text) */
  name: string;
  digest: string;
  sizeBytes: number;
  details: ModelDetails;
}

/** POST /api/show (subset used by discovery). */
export interface ShowInfo {
  details: ModelDetails;
  /** e.g. ["completion", "thinking"] when reported; null when the field is absent */
  capabilities: string[] | null;
  contextLength: number | null;
}

/** One entry of GET /api/ps. */
export interface ProcessEntry {
  name: string;
  digest: string;
  sizeBytes: number;
  /** null when size_vram was not reported: missing offload evidence is never CPU-only zero. */
  sizeVramBytes: number | null;
  /** as reported; core never interprets wall-clock times */
  expiresAt: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature: number;
  seed: number;
  num_ctx: number;
  num_predict: number;
}

/**
 * POST /api/chat, always streamed. `think` is never sent (model default, protocol.think "default").
 * Unloading an owned model is a chat request with messages [] and keepAlive 0.
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  options: ChatOptions | null;
  keepAlive: number | string | null;
}

/** Final-chunk usage as received; durations in nanoseconds. null = field absent. */
export interface DoneUsage {
  totalDurationNs: number | null;
  loadDurationNs: number | null;
  promptEvalCount: number | null;
  promptEvalDurationNs: number | null;
  evalCount: number | null;
  evalDurationNs: number | null;
  doneReason: string | null;
  /** every numeric field of the final chunk, unconverted (SpeedRepeat.usageRaw) */
  raw: Record<string, number>;
}

/** Parsed stream events. `atMs` is the adapter's injected monotonic clock reading when the line arrived. */
export type ChatChunk =
  | { type: "thinking"; text: string; atMs: number }
  | { type: "content"; text: string; atMs: number }
  | { type: "done"; usage: DoneUsage; atMs: number }
  | { type: "error"; message: string; atMs: number };

export type ProviderErrorCode =
  | "timeout"
  | "header_timeout"
  | "aborted"
  | "http_status"
  | "redirect"
  | "guard_refused"
  | "oversize_line"
  | "oversize_stream"
  | "malformed"
  | "unreachable";

/** Errors adapters throw or yield; message is redacted and sanitised before display. */
export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
}

/** The one runtime seam. Every call takes an AbortSignal; timeouts follow protocol.caps (D10, D31). */
export interface Runtime {
  readonly kind: "ollama" | "mock";
  /** GET /api/tags */
  listModels(signal: RuntimeSignal): Promise<ModelSummary[]>;
  /** POST /api/show */
  show(tag: string, signal: RuntimeSignal): Promise<ShowInfo>;
  /** POST /api/chat with stream: true; yields parsed chunks, partial lines buffered across reads */
  chatStream(req: ChatRequest, signal: RuntimeSignal): AsyncIterable<ChatChunk>;
  /** GET /api/ps */
  processStatus(signal: RuntimeSignal): Promise<ProcessEntry[]>;
  /** GET /api/version; null when not reported */
  version(signal: RuntimeSignal): Promise<string | null>;
}

/**
 * Minimal AbortSignal shape (named RuntimeSignal), declared here because tsconfig.core.json has no DOM or Node types.
 * Structurally compatible with the DOM/Node AbortSignal.
 */
export interface RuntimeSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}
