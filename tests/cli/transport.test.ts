import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROTOCOL_CAPS } from "../../src/core/index.js";
import type { FetchLike } from "../../cli/providers/fetch-guard.js";
import { createOllamaRuntime } from "../../cli/providers/ollama.js";
import { createManualClock } from "../../cli/providers/clock.js";

const request = { model: "fixture:latest", messages: [{ role: "user" as const, content: "test" }], options: null, keepAlive: null };
const collect = async (runtime: ReturnType<typeof createOllamaRuntime>, signal = new AbortController().signal): Promise<void> => { for await (const _chunk of runtime.chatStream(request, signal)) { /* consume */ } };
function runtime(fetch: FetchLike, caps = { ...DEFAULT_PROTOCOL_CAPS }): ReturnType<typeof createOllamaRuntime> {
  return createOllamaRuntime({ baseUrl: "http://127.0.0.1:11434", fetch, clock: createManualClock(), caps });
}
const abortWait: FetchLike = (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); });

afterEach(() => { vi.useRealTimers(); });
describe("bounded transport", () => {
  it("metadata and response-header deadlines abort requests", async () => {
    vi.useFakeTimers();
    const metadata = expect(runtime(abortWait).listModels(new AbortController().signal)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10_001); await metadata;
    const headers = expect(collect(runtime(abortWait))).rejects.toMatchObject({ code: "header_timeout" });
    await vi.advanceTimersByTimeAsync(30_001); await headers;
  });
  it("generation deadline covers stalled body reads after headers", async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = async (_url, init) => ({ ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); }), cancel: async () => undefined }) } });
    const pending = expect(collect(runtime(fetch))).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(300_001); await pending;
  });
  it("caller cancellation aborts an active request", async () => {
    const controller = new AbortController(); const pending = expect(collect(runtime(abortWait), controller.signal)).rejects.toMatchObject({ code: "aborted" });
    controller.abort(); await pending;
  });
  it("adapter applies NDJSON caps to fake-fetch bytes", async () => {
    const fetch: FetchLike = async () => { let done = false; return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode("x".repeat(262_145)) }; }, cancel: async () => undefined }) } }; };
    await expect(collect(runtime(fetch))).rejects.toMatchObject({ code: "oversize_line" });
  });
  it("rejects an oversized trailing line even when the same read contains done", async () => {
    // Regression: emit(done) used to return before inspecting the splitter failure from this read.
    const body = new TextEncoder().encode('{"message":{"content":"42"}}\n{"done":true,"eval_count":1,"eval_duration":1000000000}\n' + "x".repeat(DEFAULT_PROTOCOL_CAPS.ndjsonLineBytes + 1));
    expect(body.byteLength).toBeLessThan(DEFAULT_PROTOCOL_CAPS.streamBytes);
    const cancel = vi.fn(async () => undefined);
    const fetch: FetchLike = async () => {
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: body }; }, cancel }) } };
    };
    await expect(collect(runtime(fetch))).rejects.toMatchObject({ code: "oversize_line" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects malformed UTF-8 after done in the same read", async () => {
    const prefix = new TextEncoder().encode('{"message":{"content":"42"}}\n{"done":true}\n');
    const body = new Uint8Array(prefix.length + 2);
    body.set(prefix); body.set([0xff, 0x0a], prefix.length);
    const fetch: FetchLike = async () => {
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: body }; }, cancel: async () => undefined }) } };
    };
    await expect(collect(runtime(fetch))).rejects.toMatchObject({ code: "malformed" });
  });
});
