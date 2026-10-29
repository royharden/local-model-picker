// Ollama runtime adapter (Runtime seam, src/core/providers/types.ts). Every request goes through the
// fetch guard (literal loopback unless --allow-remote, redirect: "error"), has its own AbortController
// linked to the caller's signal, and is bounded (D10, D31):
//   metadata (/api/tags, /api/show, /api/ps, /api/version): caps.metadataTimeoutMs for the whole
//     request, body capped at caps.streamBytes;
//   generation (/api/chat, streamed): caps.headerTimeoutMs to receive headers, caps.genTimeoutMs for
//     the whole stream, caps.ndjsonLineBytes per line and caps.streamBytes per response, with partial
//     lines buffered across reads (src/core/providers/ndjson.ts).
// The mock runtime (cli/providers/mock.ts) reuses this exact adapter over a fake fetch, so mock data
// flows through the same parsers and timing code.
// `think` is never sent (protocol.think "default"). Never pulls, copies or deletes models.
import type {
  ChatChunk,
  ChatRequest,
  ModelSummary,
  ProcessEntry,
  ProtocolCaps,
  ProviderErrorCode,
  Runtime,
  RuntimeSignal,
  ShowInfo,
  Parsed,
} from "../../src/core/index.js";
import { createLineSplitter, parseChatLine, parsePsBody, parseShowBody, parseTagsBody, parseVersionBody } from "../../src/core/index.js";
import type { MonotonicClock, Timers } from "./clock.js";
import { systemTimers } from "./clock.js";
import { ProviderFailure } from "./errors.js";
import { guardedFetch } from "./fetch-guard.js";
import type { BodyReader, FetchLike, FetchResponseLike } from "./fetch-guard.js";

export interface OllamaRuntimeOptions {
  /** guard-approved base URL (resolveEndpoint) or the mock's fake base */
  baseUrl: string;
  fetch: FetchLike;
  clock: MonotonicClock;
  caps: ProtocolCaps;
  kind?: "ollama" | "mock";
  timers?: Timers;
}

interface AbortTarget {
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

function hasEvents(s: RuntimeSignal): s is RuntimeSignal & AbortTarget {
  const t = s as Partial<AbortTarget>;
  return typeof t.addEventListener === "function" && typeof t.removeEventListener === "function";
}

/** One bounded request: its controller, the reason a local timer fired, and cleanup. */
interface Guarded {
  signal: AbortSignal;
  timedOut(): ProviderErrorCode | null;
  outerAborted(): boolean;
  arm(code: ProviderErrorCode, ms: number): unknown;
  disarm(handle: unknown): void;
  release(): void;
}

function guard(outer: RuntimeSignal, timers: Timers): Guarded {
  const controller = new AbortController();
  let why: ProviderErrorCode | null = null;
  const handles = new Set<unknown>();
  const onAbort = (): void => controller.abort(outer.reason);
  if (outer.aborted) controller.abort(outer.reason);
  else if (hasEvents(outer)) outer.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => why,
    outerAborted: () => outer.aborted,
    arm(code, ms) {
      const h = timers.setTimeout(() => {
        if (why === null) why = code;
        controller.abort(new ProviderFailure(code, `request exceeded ${ms} ms`));
      }, ms);
      handles.add(h);
      return h;
    },
    disarm(h) {
      timers.clearTimeout(h);
      handles.delete(h);
    },
    release() {
      for (const h of handles) timers.clearTimeout(h);
      handles.clear();
      if (hasEvents(outer)) outer.removeEventListener("abort", onAbort);
    },
  };
}

function causeText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur instanceof Error; i++) {
    parts.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  return parts.join(" / ");
}

/** Map anything thrown during a request to a ProviderFailure without leaking the address. */
function toFailure(e: unknown, g: Guarded, what: string): ProviderFailure {
  if (e instanceof ProviderFailure) return e;
  const timed = g.timedOut();
  if (timed !== null) {
    return new ProviderFailure(timed, timed === "header_timeout" ? `${what}: no response headers in time` : `${what}: timed out`);
  }
  if (g.outerAborted()) return new ProviderFailure("aborted", `${what}: interrupted`);
  if (/redirect/i.test(causeText(e))) return new ProviderFailure("redirect", `${what}: redirect refused`);
  return new ProviderFailure("unreachable", `${what}: the Ollama endpoint could not be reached`);
}

async function readCapped(reader: BodyReader, cap: number, what: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    const v = r.value;
    if (v === undefined) continue;
    total += v.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderFailure("oversize_stream", `${what}: response exceeded ${cap} bytes`);
    }
    parts.push(v);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function decodeJson(bytes: Uint8Array, what: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderFailure("malformed", `${what}: response is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderFailure("malformed", `${what}: response is not JSON`);
  }
}

async function errorBodyMessage(response: FetchResponseLike): Promise<string> {
  if (response.body === null) return "";
  try {
    const bytes = await readCapped(response.body.getReader(), 4096, "error body");
    const body = decodeJson(bytes, "error body") as { error?: unknown };
    return typeof body.error === "string" ? `: ${body.error.slice(0, 300)}` : "";
  } catch {
    return "";
  }
}

function unwrap<T>(p: Parsed<T>): T {
  if (!p.ok) throw new ProviderFailure("malformed", p.message);
  return p.value;
}

function chatBody(req: ChatRequest): string {
  const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
  if (req.options !== null) body["options"] = req.options;
  if (req.keepAlive !== null) body["keep_alive"] = req.keepAlive;
  return JSON.stringify(body);
}

export function createOllamaRuntime(opts: OllamaRuntimeOptions): Runtime {
  const timers = opts.timers ?? systemTimers();
  const request = guardedFetch(opts.fetch, opts.baseUrl);
  const caps = opts.caps;

  async function metadata(path: string, method: "GET" | "POST", body: string | null, signal: RuntimeSignal): Promise<unknown> {
    const what = `${method} ${path}`;
    const g = guard(signal, timers);
    g.arm("timeout", caps.metadataTimeoutMs);
    try {
      const init = body === null
        ? { method, signal: g.signal }
        : { method, signal: g.signal, body, headers: { "content-type": "application/json" } };
      const response = await request(path, init);
      if (!response.ok) {
        throw new ProviderFailure("http_status", `${what}: HTTP ${response.status}${await errorBodyMessage(response)}`);
      }
      if (response.body === null) throw new ProviderFailure("malformed", `${what}: empty response`);
      return decodeJson(await readCapped(response.body.getReader(), caps.streamBytes, what), what);
    } catch (e) {
      throw toFailure(e, g, what);
    } finally {
      g.release();
    }
  }

  async function* chatStream(req: ChatRequest, signal: RuntimeSignal): AsyncGenerator<ChatChunk, void, undefined> {
    const what = "POST /api/chat";
    const g = guard(signal, timers);
    const headerTimer = g.arm("header_timeout", caps.headerTimeoutMs);
    g.arm("timeout", caps.genTimeoutMs);
    let reader: BodyReader | null = null;
    let finished = false;
    try {
      let response: FetchResponseLike;
      try {
        response = await request("/api/chat", {
          method: "POST",
          signal: g.signal,
          body: chatBody(req),
          headers: { "content-type": "application/json" },
        });
      } finally {
        g.disarm(headerTimer);
      }
      if (!response.ok) {
        throw new ProviderFailure("http_status", `${what}: HTTP ${response.status}${await errorBodyMessage(response)}`);
      }
      if (response.body === null) throw new ProviderFailure("malformed", `${what}: empty response`);
      reader = response.body.getReader();
      const splitter = createLineSplitter({ lineBytes: caps.ndjsonLineBytes, streamBytes: caps.streamBytes });
      const emit = function* (lines: string[]): Generator<ChatChunk, boolean, undefined> {
        for (const line of lines) {
          const parsed = parseChatLine(line, opts.clock.nowMs());
          if (!parsed.ok) throw new ProviderFailure("malformed", `${what}: ${parsed.message}`);
          for (const chunk of parsed.value) {
            yield chunk;
            if (chunk.type === "done" || chunk.type === "error") return true;
          }
        }
        return false;
      };
      for (;;) {
        if (g.signal.aborted) throw toFailure(g.signal.reason, g, what);
        const r = await reader.read();
        if (r.done) {
          const last = splitter.end();
          if (last.failure !== null) throw new ProviderFailure(last.failure.code, `${what}: ${last.failure.message}`);
          finished = true;
          yield* emit(last.lines);
          return;
        }
        if (r.value === undefined) continue;
        const step = splitter.push(r.value);
        // A read can contain complete lines (including done) followed by a cap/UTF-8 failure.
        // Fail the observed read before emitting a terminal chunk that could hide that failure.
        if (step.failure !== null) throw new ProviderFailure(step.failure.code, `${what}: ${step.failure.message}`);
        const stop = yield* emit(step.lines);
        if (stop) return;
      }
    } catch (e) {
      throw toFailure(e, g, what);
    } finally {
      if (reader !== null && !finished) await reader.cancel().catch(() => undefined);
      g.release();
    }
  }

  const runtime: Runtime = {
    kind: opts.kind ?? "ollama",
    async listModels(signal: RuntimeSignal): Promise<ModelSummary[]> {
      return unwrap(parseTagsBody(await metadata("/api/tags", "GET", null, signal)));
    },
    async show(tag: string, signal: RuntimeSignal): Promise<ShowInfo> {
      return unwrap(parseShowBody(await metadata("/api/show", "POST", JSON.stringify({ model: tag }), signal)));
    },
    chatStream,
    async processStatus(signal: RuntimeSignal): Promise<ProcessEntry[]> {
      return unwrap(parsePsBody(await metadata("/api/ps", "GET", null, signal)));
    },
    async version(signal: RuntimeSignal): Promise<string | null> {
      return unwrap(parseVersionBody(await metadata("/api/version", "GET", null, signal)));
    },
  };
  return runtime;
}
