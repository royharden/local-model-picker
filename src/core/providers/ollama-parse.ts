// Pure parsers for Ollama response bodies (/api/tags, /api/show, /api/ps, /api/version, /api/chat
// NDJSON lines) and the ONE place where runtime units are converted (docs/METHOD.md):
//   ms = ns / 1e6;  tokens/s = count / (ns / 1e9).
// No I/O, no clock: chunk arrival times (`atMs`) and the request start come from the adapter's
// injected monotonic clock. Model names and error text are untrusted data and are only bounded here;
// redaction and terminal sanitising happen in the CLI before anything is stored or printed.
//
// SpeedRepeat validity (Claude §2.5): a repeat is invalid when the stream ended without a done
// chunk, carried an error chunk or a transport failure, had a negative or non-finite numeric field,
// had eval_count or eval_duration <= 0 (no generation rate), or produced no answer content. An
// invalid repeat never becomes a speed of 0. Zero is legitimate elsewhere: load_duration 0 on a warm
// repeat is valid; prompt_eval_count / prompt_eval_duration 0 (a cached prompt) leaves the repeat
// valid with promptTokPerSec null. Ollama serialises these metrics with `omitempty`, so an ABSENT
// load_duration / prompt_eval_count / prompt_eval_duration on a done chunk reads as 0 (assumption
// recorded in docs/DEFERRED-VALIDATION.md; checked against real bodies at activation).
import type { ChatChunk, DoneUsage, ModelDetails, ModelSummary, ProcessEntry, ShowInfo } from "./types.js";
import type { SpeedRepeat } from "../schema/candidate.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Bounds applied while parsing untrusted bodies. */
export const PARSE_LIMITS = {
  maxModels: 500,
  nameChars: 300,
  detailChars: 100,
  errorChars: 500,
  usageFields: 32,
  capabilities: 32,
} as const;

const NS_PER_MS = 1e6;
const NS_PER_S = 1e9;

export function nsToMs(ns: number): number {
  return ns / NS_PER_MS;
}

/** count / seconds; null when either is not positive (never a division by zero). */
export function tokensPerSecond(count: number | null, ns: number | null): number | null {
  if (count === null || ns === null) return null;
  if (!Number.isFinite(count) || !Number.isFinite(ns) || count <= 0 || ns <= 0) return null;
  return count / (ns / NS_PER_S);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function optText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : clip(t, max);
}

function finiteNonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** /api/tags and /api/ps report digests as 64 lowercase hex chars; accept an optional "sha256:" prefix. */
export function normalizeDigest(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{12,128}$/.test(d) ? d : null;
}

export function parseDetails(v: unknown): ModelDetails {
  const d = isRecord(v) ? v : {};
  return {
    family: optText(d["family"], PARSE_LIMITS.detailChars),
    parameterSize: optText(d["parameter_size"], 50),
    quantizationLevel: optText(d["quantization_level"], 50),
    format: optText(d["format"], 50),
  };
}

function modelName(entry: Record<string, unknown>): string | null {
  const name = typeof entry["name"] === "string" ? entry["name"] : entry["model"];
  if (typeof name !== "string" || name.length === 0 || name.length > PARSE_LIMITS.nameChars) return null;
  return name;
}

/** GET /api/tags: `{ models: [{ name, model, digest, size, details }] }`. Strict: one bad entry fails the body. */
export function parseTagsBody(body: unknown): Parsed<ModelSummary[]> {
  if (!isRecord(body) || !Array.isArray(body["models"])) return { ok: false, message: "/api/tags body has no models array" };
  const list = body["models"] as unknown[];
  if (list.length > PARSE_LIMITS.maxModels) return { ok: false, message: `/api/tags lists more than ${PARSE_LIMITS.maxModels} models` };
  const out: ModelSummary[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isRecord(e)) return { ok: false, message: `/api/tags models[${i}] is not an object` };
    const name = modelName(e);
    const digest = normalizeDigest(e["digest"]);
    const size = finiteNonNeg(e["size"]);
    if (name === null) return { ok: false, message: `/api/tags models[${i}] has no usable name` };
    if (digest === null) return { ok: false, message: `/api/tags models[${i}] has no hex digest` };
    if (size === null) return { ok: false, message: `/api/tags models[${i}] has no non-negative size` };
    out.push({ name, digest, sizeBytes: size, details: parseDetails(e["details"]) });
  }
  return { ok: true, value: out };
}

/** POST /api/show: details, capabilities and `<arch>.context_length` from model_info. */
export function parseShowBody(body: unknown): Parsed<ShowInfo> {
  if (!isRecord(body)) return { ok: false, message: "/api/show body is not an object" };
  let capabilities: string[] | null = null;
  const caps = body["capabilities"];
  if (Array.isArray(caps)) {
    capabilities = caps
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .slice(0, PARSE_LIMITS.capabilities)
      .map((c) => clip(c, 50));
  }
  let contextLength: number | null = null;
  const info = body["model_info"];
  if (isRecord(info)) {
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(".context_length") && typeof v === "number" && Number.isInteger(v) && v > 0) {
        contextLength = v;
        break;
      }
    }
  }
  return { ok: true, value: { details: parseDetails(body["details"]), capabilities, contextLength } };
}

/** GET /api/ps: `{ models: [{ name, model, size, size_vram, digest, expires_at }] }`. */
export function parsePsBody(body: unknown): Parsed<ProcessEntry[]> {
  if (!isRecord(body) || !Array.isArray(body["models"])) return { ok: false, message: "/api/ps body has no models array" };
  const list = body["models"] as unknown[];
  if (list.length > PARSE_LIMITS.maxModels) return { ok: false, message: `/api/ps lists more than ${PARSE_LIMITS.maxModels} models` };
  const out: ProcessEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!isRecord(e)) return { ok: false, message: `/api/ps models[${i}] is not an object` };
    const name = modelName(e);
    const digest = normalizeDigest(e["digest"]);
    const size = finiteNonNeg(e["size"]);
    const sizeVram = e["size_vram"] === undefined ? null : finiteNonNeg(e["size_vram"]);
    if (name === null || digest === null || size === null || (e["size_vram"] !== undefined && sizeVram === null)) {
      return { ok: false, message: `/api/ps models[${i}] lacks name, hex digest, size or a valid size_vram` };
    }
    out.push({ name, digest, sizeBytes: size, sizeVramBytes: sizeVram, expiresAt: optText(e["expires_at"], 100) });
  }
  return { ok: true, value: out };
}

/** GET /api/version: `{ version: "0.5.7" }`; null when absent. */
export function parseVersionBody(body: unknown): Parsed<string | null> {
  if (!isRecord(body)) return { ok: false, message: "/api/version body is not an object" };
  return { ok: true, value: optText(body["version"], 50) };
}

const USAGE_FIELDS = {
  totalDurationNs: "total_duration",
  loadDurationNs: "load_duration",
  promptEvalCount: "prompt_eval_count",
  promptEvalDurationNs: "prompt_eval_duration",
  evalCount: "eval_count",
  evalDurationNs: "eval_duration",
} as const;

/** Usage of a done chunk as received. Every top-level numeric field (at most 32, sorted by name) goes to `raw`. */
export function usageFromDone(obj: Record<string, unknown>): DoneUsage {
  const raw: Record<string, number> = {};
  const keys = Object.keys(obj)
    .filter((k) => typeof obj[k] === "number")
    .sort()
    .slice(0, PARSE_LIMITS.usageFields);
  for (const k of keys) raw[k] = obj[k] as number;
  const field = (name: string): number | null => {
    const v = obj[name];
    return typeof v === "number" ? v : null;
  };
  return {
    totalDurationNs: field(USAGE_FIELDS.totalDurationNs),
    loadDurationNs: field(USAGE_FIELDS.loadDurationNs),
    promptEvalCount: field(USAGE_FIELDS.promptEvalCount),
    promptEvalDurationNs: field(USAGE_FIELDS.promptEvalDurationNs),
    evalCount: field(USAGE_FIELDS.evalCount),
    evalDurationNs: field(USAGE_FIELDS.evalDurationNs),
    doneReason: optText(obj["done_reason"], 50),
    raw,
  };
}

/**
 * One /api/chat NDJSON line -> zero or more chunks, in order: thinking, content, done; or a single
 * error chunk for `{ "error": ... }`. A line that is not a JSON object is malformed.
 */
export function parseChatLine(line: string, atMs: number): Parsed<ChatChunk[]> {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ok: false, message: "malformed NDJSON line (not JSON)" };
  }
  if (!isRecord(obj)) return { ok: false, message: "malformed NDJSON line (not an object)" };
  const err = obj["error"];
  if (err !== undefined) {
    const message = typeof err === "string" && err.length > 0 ? clip(err, PARSE_LIMITS.errorChars) : "unspecified runtime error";
    return { ok: true, value: [{ type: "error", message, atMs }] };
  }
  const chunks: ChatChunk[] = [];
  const msg = obj["message"];
  if (isRecord(msg)) {
    const thinking = msg["thinking"];
    if (typeof thinking === "string" && thinking.length > 0) chunks.push({ type: "thinking", text: thinking, atMs });
    const content = msg["content"];
    if (typeof content === "string" && content.length > 0) chunks.push({ type: "content", text: content, atMs });
  }
  if (obj["done"] === true) chunks.push({ type: "done", usage: usageFromDone(obj), atMs });
  return { ok: true, value: chunks };
}

/** The answer stream: concatenated content chunks. Structured thinking is excluded (D9 step 0). */
export function collectAnswerText(chunks: readonly ChatChunk[]): string {
  let out = "";
  for (const c of chunks) if (c.type === "content") out += c.text;
  return out;
}

export interface AnswerStart {
  /** non-whitespace answer text remains after inline thinking is removed */
  started: boolean;
  /** the content contains an inline think block or an orphan closing tag */
  inlineThink: boolean;
}

const CLOSED_THINK = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const THINK_OPEN = /<think\b[^>]*>/i;
const THINK_CLOSE = /<\/think\s*>/gi;

interface AnswerOffset {
  /** UTF-16 offset in the original concatenated content, not in the stripped answer */
  offset: number | null;
  inlineThink: boolean;
}

/**
 * Locate the first retained answer character under the grader's D39 rules: remove closed blocks,
 * discard everything through the last remaining (orphan) close, then cut at an unclosed open.
 * Retain source spans while removing blocks, so a repeated word in reasoning cannot steal the
 * answer's timestamp. Joining spans before examining orphan/open tags also matches answerText's
 * replacement order. Speed timing uses the full bounded stream, not the eval answer's raw cap.
 */
function retainedAnswerOffset(content: string): AnswerOffset {
  const spans: { start: number; end: number }[] = [];
  let next = 0;
  let inlineThink = false;
  for (const block of content.matchAll(CLOSED_THINK)) {
    const start = block.index ?? 0;
    if (start > next) spans.push({ start: next, end: start });
    next = start + block[0].length;
    inlineThink = true;
  }
  if (next < content.length) spans.push({ start: next, end: content.length });
  const visible = spans.map((span) => content.slice(span.start, span.end)).join("");
  let from = 0;
  for (const close of visible.matchAll(THINK_CLOSE)) {
    from = (close.index ?? 0) + close[0].length;
    inlineThink = true;
  }
  const open = THINK_OPEN.exec(visible.slice(from));
  const to = open === null ? visible.length : from + open.index;
  if (open !== null) inlineThink = true;
  const answer = visible.slice(from, to);
  const first = answer.search(/\S/);
  if (first < 0) return { offset: null, inlineThink };
  const lead = answer.slice(first);
  // A leading tag may still be arriving across content chunks. Do not count its prefix as an answer.
  if ((lead.length < 6 && "<think".startsWith(lead.toLowerCase())) || /^<think\b[^>]*$/i.test(lead)) {
    return { offset: null, inlineThink };
  }
  const visibleOffset = from + first;
  let skipped = 0;
  for (const span of spans) {
    const length = span.end - span.start;
    if (visibleOffset < skipped + length) return { offset: span.start + visibleOffset - skipped, inlineThink };
    skipped += length;
  }
  return { offset: null, inlineThink };
}

/**
 * Whether the content received so far retains visible answer text. This result is provisional:
 * a later orphan `</think>` can identify all earlier content as reasoning (D39).
 */
export function answerStart(contentSoFar: string): AnswerStart {
  const answer = retainedAnswerOffset(contentSoFar);
  return { started: answer.offset !== null, inlineThink: answer.inlineThink };
}

/** Everything the adapter observed for one streamed generation. */
export interface StreamCapture {
  /** monotonic clock reading taken immediately before the request was sent */
  startMs: number;
  chunks: readonly ChatChunk[];
  /** redacted transport failure text (timeout, oversize, malformed, unreachable ...) or null */
  transportError: string | null;
}

export interface StreamTiming {
  /** first non-empty thinking-or-content chunk, ms after start */
  ttftMs: number | null;
  /** first non-whitespace retained answer character, ms after start (D39) */
  ttfaMs: number | null;
  thinkingObserved: boolean;
  done: DoneUsage | null;
  errorMessage: string | null;
}

export function streamTiming(cap: StreamCapture): StreamTiming {
  let ttft: number | null = null;
  let ttfa: number | null = null;
  let thinkingObserved = false;
  let content = "";
  let done: DoneUsage | null = null;
  let errorMessage: string | null = null;
  const since = (at: number): number => Math.max(0, at - cap.startMs);
  for (const c of cap.chunks) {
    if (c.type === "thinking") {
      if (c.text.trim() !== "") {
        thinkingObserved = true;
        if (ttft === null) ttft = since(c.atMs);
      }
    } else if (c.type === "content") {
      content += c.text;
      if (ttft === null && c.text.trim() !== "") ttft = since(c.atMs);
    } else if (c.type === "done") {
      if (done === null) done = c.usage;
    } else if (errorMessage === null) {
      errorMessage = c.message;
    }
  }
  // Final content decides visibility: a late orphan close must revoke provisional answer timing.
  // Map the retained source offset back to its arrival chunk; TTFT still records the first token.
  const answer = retainedAnswerOffset(content);
  thinkingObserved ||= answer.inlineThink;
  if (answer.offset !== null) {
    let end = 0;
    for (const c of cap.chunks) {
      if (c.type !== "content") continue;
      end += c.text.length;
      if (answer.offset < end) { ttfa = since(c.atMs); break; }
    }
  }
  return { ttftMs: ttft, ttfaMs: ttfa, thinkingObserved, done, errorMessage };
}

/** Why a captured stream cannot be used at all (transport failure, error chunk, missing done); null when usable. */
export function streamFailure(cap: StreamCapture): string | null {
  const t = streamTiming(cap);
  if (cap.transportError !== null) return cap.transportError;
  if (t.errorMessage !== null) return `runtime error: ${t.errorMessage}`;
  if (t.done === null) return "stream ended without a done chunk";
  return null;
}

const MAX_REASON = 500;

function nonNegOrNull(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v >= 0 ? v : null;
}

function nonNegIntOrNull(v: number | null): number | null {
  return v !== null && Number.isInteger(v) && v >= 0 ? v : null;
}

/** usageRaw as stored: finite values only, at most 32 fields. */
function storedUsage(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(raw).sort().slice(0, PARSE_LIMITS.usageFields)) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Build the stored SpeedRepeat for one speed prompt repeat (repeat 0 = warm-up). */
export function buildSpeedRepeat(promptId: string, repeat: number, cap: StreamCapture): SpeedRepeat {
  const t = streamTiming(cap);
  const reasons: string[] = [];
  if (cap.transportError !== null) reasons.push(cap.transportError);
  if (t.errorMessage !== null) reasons.push(`runtime error: ${t.errorMessage}`);

  let loadNs: number | null = null;
  let promptCount: number | null = null;
  let promptNs: number | null = null;
  let evalCount: number | null = null;
  let evalNs: number | null = null;
  const done = t.done;
  if (done === null) {
    reasons.push("stream ended without a done chunk");
  } else {
    for (const [k, v] of Object.entries(done.raw)) {
      if (!Number.isFinite(v) || v < 0) reasons.push(`usage field ${clip(k, 64)} is negative or non-finite`);
    }
    // omitempty: absent load / prompt-eval metrics are zero; absent eval metrics mean no generation rate.
    loadNs = nonNegOrNull(done.loadDurationNs ?? 0);
    promptCount = nonNegIntOrNull(done.promptEvalCount ?? 0);
    promptNs = nonNegOrNull(done.promptEvalDurationNs ?? 0);
    evalCount = nonNegIntOrNull(done.evalCount);
    evalNs = nonNegOrNull(done.evalDurationNs);
    if (done.promptEvalCount !== null && promptCount === null) reasons.push("prompt_eval_count is not a non-negative integer");
    if (evalCount === null || evalCount <= 0) reasons.push("eval_count is missing or zero (no generation rate)");
    if (evalNs === null || evalNs <= 0) reasons.push("eval_duration is missing or zero (no generation rate)");
  }
  if (t.ttfaMs === null) reasons.push("no answer content");

  const valid = reasons.length === 0;
  const reasonText = reasons.join("; ");
  return {
    promptId,
    repeat,
    valid,
    invalidReason: valid ? null : clip(reasonText, MAX_REASON),
    ttftMs: t.ttftMs,
    ttfaMs: t.ttfaMs,
    loadMs: loadNs === null ? null : nsToMs(loadNs),
    promptEvalCount: promptCount,
    promptEvalMs: promptNs === null ? null : nsToMs(promptNs),
    evalCount,
    evalMs: evalNs === null ? null : nsToMs(evalNs),
    genTokPerSec: tokensPerSecond(evalCount, evalNs),
    promptTokPerSec: tokensPerSecond(promptCount, promptNs),
    thinkingObserved: t.thinkingObserved,
    usageRaw: done === null ? null : storedUsage(done.raw),
  };
}
