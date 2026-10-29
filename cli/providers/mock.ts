// Mock runtime (Claude §2.7, R8; PLAN.md M4 acceptance 5). A fake `fetch` that serves Ollama-shaped
// JSON and NDJSON bodies, paired with a ManualClock the fake advances deterministically. The mock is
// wrapped by the REAL adapter (cli/providers/ollama.ts), so mock data flows through the same NDJSON
// splitter, the same parsers (src/core/providers/ollama-parse.ts) and the same TTFT/TTFA logic.
// It never touches the network, a process or the file system.
//
// Determinism: every stream is seeded by (seed, tag, prompt key, call index), so repeats of the same
// prompt differ slightly (a few percent) but the whole run is reproducible. Item answers are a seeded
// mix of canned right and wrong answers per model (fixed per tag and item), so accuracy differs
// between mock quants. Lines are sometimes split across reads to exercise partial-line buffering.
// Every value produced here is SYNTHETIC; mock runs are stamped runtime "mock", synthetic true.
import type { Item, ProtocolCaps, Runtime } from "../../src/core/index.js";
import { mulberry32 } from "../../src/core/index.js";
import type { ManualClock, Timers } from "./clock.js";
import { createManualClock } from "./clock.js";
import type { BodyReader, FetchInit, FetchLike, FetchResponseLike } from "./fetch-guard.js";
import { createOllamaRuntime } from "./ollama.js";

export const MOCK_BASE_URL = "http://mock.invalid";
export const MOCK_DEFAULT_SEED = 0x5332;
const CREATED_AT = "2026-01-01T00:00:00.000000000Z";

export interface MockModelProfile {
  name: string;
  /** 64 lowercase hex; first 12 chars distinct per model (candidate key) */
  digest: string;
  sizeBytes: number;
  family: string;
  parameterSize: string;
  quantizationLevel: string;
  genTokPerSec: number;
  promptTokPerSec: number;
  /** cold load time on the first request after the model was absent */
  loadMs: number;
  /** probability that a canned item answer is the right one */
  accuracy: number;
  /** /api/ps size once loaded */
  residentBytes: number;
  /** /api/ps size_vram / size once loaded */
  vramFraction: number;
  /** emits structured message.thinking before the answer */
  thinking: boolean;
}

/** Three synthetic quants of one synthetic model (the q8_0 does not fit fully in the mock 8 GiB GPU). */
export const MOCK_MODELS: readonly MockModelProfile[] = [
  {
    name: "mock-llama:8b-instruct-q8_0",
    digest: "80".repeat(32),
    sizeBytes: 8_540_000_000,
    family: "llama",
    parameterSize: "8.0B",
    quantizationLevel: "Q8_0",
    genTokPerSec: 22,
    promptTokPerSec: 900,
    loadMs: 3200,
    accuracy: 0.83,
    residentBytes: 9_400_000_000,
    vramFraction: 0.91,
    thinking: false,
  },
  {
    name: "mock-llama:8b-instruct-q4_K_M",
    digest: "40".repeat(32),
    sizeBytes: 4_920_000_000,
    family: "llama",
    parameterSize: "8.0B",
    quantizationLevel: "Q4_K_M",
    genTokPerSec: 41,
    promptTokPerSec: 1500,
    loadMs: 1900,
    accuracy: 0.8,
    residentBytes: 5_650_000_000,
    vramFraction: 1,
    thinking: false,
  },
  {
    name: "mock-llama:8b-instruct-q2_K",
    digest: "20".repeat(32),
    sizeBytes: 3_180_000_000,
    family: "llama",
    parameterSize: "8.0B",
    quantizationLevel: "Q2_K",
    genTokPerSec: 55,
    promptTokPerSec: 1800,
    loadMs: 1500,
    accuracy: 0.5,
    residentBytes: 3_900_000_000,
    vramFraction: 1,
    thinking: false,
  },
];

/** FNV-1a 32-bit hash of a string (seed derivation only). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function wrongNumber(answer: string): string {
  const n = Number(answer.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n + 1) : "0";
}

const LETTERS = ["A", "B", "C", "D"] as const;

/** A canned answer to one item, aiming to be right or wrong. The real grader decides what it scores. */
export function mockAnswer(item: Item, right: boolean): string {
  switch (item.kind) {
    case "numeric":
      return `Working through the steps briefly.\nAnswer: ${right ? item.answer : wrongNumber(item.answer)}`;
    case "choice": {
      const idx = LETTERS.indexOf(item.answer);
      const letter = right ? item.answer : (LETTERS[(idx + 1) % 4] ?? "A");
      return `Considering each option.\nAnswer: ${letter}`;
    }
    case "extraction":
      if (item.format === "json") return right ? JSON.stringify(item.answer) : "I could not find the requested fields.";
      return `Answer: ${right ? String(item.answer) : "unknown"}`;
    case "instruction": {
      const r = item.rule;
      switch (r.type) {
        case "max_words":
          return right ? "short reply here" : Array.from({ length: r.max + 5 }, (_, i) => `word${i}`).join(" ");
        case "min_words":
          return right ? Array.from({ length: r.min + 5 }, (_, i) => `word${i}`).join(" ") : "too short";
        case "include_keywords":
          return right ? `This reply mentions ${r.keywords.join(" and ")}.` : "This reply mentions nothing relevant.";
        case "exclude_keywords":
          return right ? "A neutral reply." : `A reply about ${r.keywords[0] ?? "it"}.`;
        case "all_lowercase":
          return right ? "an all lowercase reply" : "A Mixed Case Reply";
        case "all_uppercase":
          return right ? "AN ALL UPPERCASE REPLY" : "not upper case";
        case "bullet_count": {
          const n = right ? r.count : r.count + 1;
          return Array.from({ length: n }, (_, i) => `- point ${i + 1}`).join("\n");
        }
        case "starts_with":
          return right ? `${r.text} and then the rest of the reply.` : "Something else first.";
        case "ends_with":
          return right ? `Here is the reply ${r.text}` : "Here is the reply.";
        case "json_keys":
          return right ? JSON.stringify(Object.fromEntries(r.keys.map((k) => [k, "value"]))) : "no json here";
      }
    }
  }
  return "";
}

/** Split text into stream tokens (word plus its following whitespace). */
function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

interface Piece {
  bytes: Uint8Array;
  advanceMs: number;
}

export interface MockRequestLog {
  method: string;
  path: string;
  model: string | null;
  /** /api/chat with at least one message (an inference request) */
  inference: boolean;
}

export interface MockServer {
  fetch: FetchLike;
  clock: ManualClock;
  /** every request received, in order */
  log: MockRequestLog[];
  /** tags currently resident (as /api/ps would list them) */
  resident(): string[];
}

export interface MockServerOptions {
  seed?: number;
  items: readonly Item[];
  profiles?: readonly MockModelProfile[];
  /** tags resident before the run (they must never be unloaded by the run) */
  preloaded?: readonly string[];
  clock?: ManualClock;
}

export function createMockServer(opts: MockServerOptions): MockServer {
  const seed = opts.seed ?? MOCK_DEFAULT_SEED;
  const profiles = opts.profiles ?? MOCK_MODELS;
  const clock = opts.clock ?? createManualClock(0);
  const encoder = new TextEncoder();
  const byPrompt = new Map<string, Item>();
  for (const item of opts.items) byPrompt.set(item.prompt, item);
  const resident = new Set<string>(opts.preloaded ?? []);
  const calls = new Map<string, number>();
  const log: MockRequestLog[] = [];

  const profileOf = (name: unknown): MockModelProfile | undefined => profiles.find((p) => p.name === name);

  const reader = (pieces: Piece[], signal: AbortSignal): BodyReader => {
    let i = 0;
    let cancelled = false;
    return {
      async read() {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        if (cancelled || i >= pieces.length) return { done: true };
        const p = pieces[i] as Piece;
        i += 1;
        clock.advance(p.advanceMs);
        return { done: false, value: p.bytes };
      },
      async cancel() {
        cancelled = true;
      },
    };
  };

  const respond = (status: number, pieces: Piece[], signal: AbortSignal): FetchResponseLike => ({
    status,
    ok: status >= 200 && status < 300,
    body: { getReader: () => reader(pieces, signal) },
  });

  const json = (status: number, value: unknown, signal: AbortSignal): FetchResponseLike =>
    respond(status, [{ bytes: encoder.encode(JSON.stringify(value)), advanceMs: 2 }], signal);

  const details = (p: MockModelProfile): Record<string, unknown> => ({
    format: "gguf",
    family: p.family,
    families: [p.family],
    parameter_size: p.parameterSize,
    quantization_level: p.quantizationLevel,
  });

  const psBody = (): unknown => ({
    models: [...resident].flatMap((name) => {
      const p = profileOf(name);
      if (p === undefined) return [];
      return [
        {
          name: p.name,
          model: p.name,
          size: p.residentBytes,
          digest: p.digest,
          details: details(p),
          expires_at: "2026-01-01T00:05:00.000Z",
          size_vram: Math.round(p.residentBytes * p.vramFraction),
        },
      ];
    }),
  });

  const chat = (body: Record<string, unknown>, signal: AbortSignal): FetchResponseLike => {
    const p = profileOf(body["model"]);
    if (p === undefined) return json(404, { error: `model "${String(body["model"]).slice(0, 100)}" not found, try pulling it first` }, signal);
    const messages = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ role?: unknown; content?: unknown }>) : [];
    const line = (v: unknown): Uint8Array => encoder.encode(`${JSON.stringify(v)}\n`);
    if (messages.length === 0) {
      const unload = body["keep_alive"] === 0;
      if (unload) resident.delete(p.name);
      else resident.add(p.name);
      const done = { model: p.name, created_at: CREATED_AT, message: { role: "assistant", content: "" }, done_reason: unload ? "unload" : "load", done: true };
      return respond(200, [{ bytes: line(done), advanceMs: unload ? 5 : p.loadMs }], signal);
    }
    const cold = !resident.has(p.name);
    resident.add(p.name);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const item = byPrompt.get(userText);
    const promptKey = item !== undefined ? `item:${item.id}` : `prompt:${hash32(userText)}`;
    const callKey = `${p.name}|${promptKey}`;
    const callIndex = calls.get(callKey) ?? 0;
    calls.set(callKey, callIndex + 1);
    const rand = mulberry32(hash32(`${seed}|${p.name}|${promptKey}|${callIndex}`));
    const jitter = (): number => 1 + (rand() - 0.5) * 0.06;

    const options = (body["options"] ?? {}) as { num_predict?: unknown };
    const numPredict = typeof options.num_predict === "number" && options.num_predict > 0 ? Math.floor(options.num_predict) : 128;
    let answer: string[];
    let doneReason = "stop";
    if (item !== undefined) {
      const right = mulberry32(hash32(`${seed}|${p.name}|item|${item.id}`))() < p.accuracy;
      answer = tokens(mockAnswer(item, right));
    } else {
      answer = Array.from({ length: numPredict }, (_, i) => `tok${i % 97} `);
      doneReason = "length";
    }
    const thinking = p.thinking ? Array.from({ length: 24 }, (_, i) => `think${i} `) : [];
    const budget = Math.max(0, numPredict - thinking.length);
    if (answer.length > budget) {
      answer = answer.slice(0, budget);
      doneReason = "length";
    }

    const promptChars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
    const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
    const loadMs = cold ? p.loadMs * jitter() : 0.2;
    const promptMs = (promptTokens / p.promptTokPerSec) * 1000 * jitter();
    const perTokenMs = 1000 / (p.genTokPerSec * jitter());

    const pieces: Piece[] = [];
    const pushLine = (v: unknown, advanceMs: number): void => {
      const bytes = line(v);
      // about one line in seven arrives split across two reads (partial-line buffering)
      if (bytes.length > 4 && rand() < 1 / 7) {
        const cut = 1 + Math.floor(rand() * (bytes.length - 2));
        pieces.push({ bytes: bytes.slice(0, cut), advanceMs });
        pieces.push({ bytes: bytes.slice(cut), advanceMs: 0 });
      } else {
        pieces.push({ bytes, advanceMs });
      }
    };
    let first = true;
    const stepMs = (): number => {
      if (first) {
        first = false;
        return loadMs + promptMs + perTokenMs;
      }
      return perTokenMs;
    };
    for (const t of thinking) pushLine({ model: p.name, created_at: CREATED_AT, message: { role: "assistant", content: "", thinking: t }, done: false }, stepMs());
    for (const t of answer) pushLine({ model: p.name, created_at: CREATED_AT, message: { role: "assistant", content: t }, done: false }, stepMs());
    const evalCount = thinking.length + answer.length;
    const evalNs = Math.round(evalCount * perTokenMs * 1e6);
    const loadNs = Math.round(loadMs * 1e6);
    const promptNs = Math.round(promptMs * 1e6);
    pushLine(
      {
        model: p.name,
        created_at: CREATED_AT,
        message: { role: "assistant", content: "" },
        done_reason: doneReason,
        done: true,
        total_duration: loadNs + promptNs + evalNs,
        load_duration: loadNs,
        prompt_eval_count: promptTokens,
        prompt_eval_duration: promptNs,
        eval_count: evalCount,
        eval_duration: evalNs,
      },
      first ? loadMs + promptMs : 1,
    );
    return respond(200, pieces, signal);
  };

  const fetch: FetchLike = async (url: string, init: FetchInit) => {
    if (init.signal.aborted) throw init.signal.reason ?? new Error("aborted");
    const path = url.startsWith(MOCK_BASE_URL) ? url.slice(MOCK_BASE_URL.length) : url;
    let body: Record<string, unknown> = {};
    if (typeof init.body === "string") {
      try {
        const parsed: unknown = JSON.parse(init.body);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        return json(400, { error: "invalid JSON body" }, init.signal);
      }
    }
    const model = typeof body["model"] === "string" ? body["model"] : null;
    const messages = body["messages"];
    log.push({ method: init.method, path, model, inference: path === "/api/chat" && Array.isArray(messages) && messages.length > 0 });
    if (init.method === "GET" && path === "/api/version") return json(200, { version: "0.0.0-mock" }, init.signal);
    if (init.method === "GET" && path === "/api/tags") {
      return json(
        200,
        {
          models: profiles.map((p) => ({
            name: p.name,
            model: p.name,
            modified_at: CREATED_AT,
            size: p.sizeBytes,
            digest: p.digest,
            details: details(p),
          })),
        },
        init.signal,
      );
    }
    if (init.method === "GET" && path === "/api/ps") return json(200, psBody(), init.signal);
    if (init.method === "POST" && path === "/api/show") {
      const p = profileOf(model);
      if (p === undefined) return json(404, { error: "model not found" }, init.signal);
      return json(
        200,
        {
          license: "synthetic mock model",
          details: details(p),
          model_info: { "general.architecture": p.family, [`${p.family}.context_length`]: 8192 },
          capabilities: p.thinking ? ["completion", "thinking"] : ["completion"],
        },
        init.signal,
      );
    }
    if (init.method === "POST" && path === "/api/chat") return chat(body, init.signal);
    return json(404, { error: "not found" }, init.signal);
  };

  return { fetch, clock, log, resident: () => [...resident] };
}

export interface MockRuntime {
  runtime: Runtime;
  clock: ManualClock;
  server: MockServer;
}

/** The mock runtime: the real Ollama adapter over the mock server's fake fetch and manual clock. */
export function createMockRuntime(opts: MockServerOptions & { caps: ProtocolCaps; timers?: Timers }): MockRuntime {
  const server = createMockServer(opts);
  const runtime = createOllamaRuntime({
    baseUrl: MOCK_BASE_URL,
    fetch: server.fetch,
    clock: server.clock,
    caps: opts.caps,
    kind: "mock",
    ...(opts.timers !== undefined ? { timers: opts.timers } : {}),
  });
  return { runtime, clock: server.clock, server };
}
