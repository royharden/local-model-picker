// Authored for later activation; Dirty Mode does not execute these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatChunk, StreamCapture } from "../../src/core/index.js";
import { buildSpeedRepeat, collectAnswerText, createLineSplitter, nsToMs, parseChatLine, parsePsBody, parseShowBody, parseTagsBody, parseVersionBody, streamTiming, tokensPerSecond } from "../../src/core/index.js";

const fixtures = JSON.parse(readFileSync(new URL("../../fixtures/ollama/chat-cases.json", import.meta.url), "utf8")) as { synthetic: boolean; cases: { id: string; valid: boolean; lines: string[] }[] };
const metadata = JSON.parse(readFileSync(new URL("../../fixtures/ollama/metadata.json", import.meta.url), "utf8")) as Record<string, unknown>;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function capture(lines: string[]): StreamCapture {
  const chunks: ChatChunk[] = [];
  lines.forEach((line, index) => { const p = parseChatLine(line, 100 + (index + 1) * 10); if (!p.ok) throw new Error(p.message); chunks.push(...p.value); });
  return { startMs: 100, chunks, transportError: null };
}

describe("synthetic Ollama contracts", () => {
  it("labels fixtures and parses metadata without inventing missing offload", () => {
    expect(fixtures.synthetic).toBe(true);
    expect(metadata["synthetic"]).toBe(true);
    expect(parseTagsBody(metadata["tags"]).ok).toBe(true);
    expect(parseShowBody(metadata["show"]).ok).toBe(true);
    expect(parseVersionBody(metadata["version"])).toEqual({ ok: true, value: "0.0.0-fixture" });
    const ps = parsePsBody(metadata["psMissingVram"]);
    expect(ps.ok && ps.value[0]?.sizeVramBytes).toBeNull();
    const full = parsePsBody(metadata["ps"]);
    expect(full.ok && full.value[0]?.sizeVramBytes).toBe(5_600_000_000);
  });
  for (const c of fixtures.cases) it(`repeat validity: ${c.id}`, () => {
    const repeat = buildSpeedRepeat("fixture", 1, capture(c.lines));
    expect(repeat.valid).toBe(c.valid);
    if (c.id === "warm-zero-load") expect(repeat.loadMs).toBe(0);
    if (c.id === "cached-prompt") expect(repeat.promptTokPerSec).toBeNull();
    if (c.valid) expect(repeat.genTokPerSec).toBe(20);
  });
  it("converts nanoseconds exactly once", () => {
    expect(nsToMs(2_500_000)).toBe(2.5);
    expect(tokensPerSecond(20, 1_000_000_000)).toBe(20);
    expect(tokensPerSecond(20, 0)).toBeNull();
  });
  it("separates structured thinking and answer latency", () => {
    const cap = capture(["{\"message\":{\"thinking\":\"not an answer\"}}", "{\"message\":{\"content\":\"Answer: 42\"}}"]);
    expect(collectAnswerText(cap.chunks)).toBe("Answer: 42");
    expect(streamTiming(cap)).toMatchObject({ ttftMs: 10, ttfaMs: 20, thinkingObserved: true });
  });
  it("buffers a split inline think tag until an answer arrives", () => {
    const cap = capture(["<thi", "nk>wrong", "</think>", "42"].map((content) => JSON.stringify({ message: { content } })));
    expect(streamTiming(cap)).toMatchObject({ ttfaMs: 40, thinkingObserved: true });
  });
  it("revises provisional answer timing when an orphan close arrives later", () => {
    // Regression: reasoning was latched as the answer at 10 ms and a later close was ignored.
    const cap = capture(["reasoning about 42", "</think>", "Answer: 42"].map((content) => JSON.stringify({ message: { content } })));
    expect(streamTiming(cap)).toMatchObject({ ttftMs: 10, ttfaMs: 30, thinkingObserved: true });
  });
  it("handles every orphan-close chunk boundary and waits for non-whitespace retained answer", () => {
    const close = "</think>";
    for (let cut = 1; cut < close.length; cut++) {
      const cap = capture(["reasoning", close.slice(0, cut), close.slice(cut), " \t", "Answer: 42"].map((content) => JSON.stringify({ message: { content } })));
      expect(streamTiming(cap)).toMatchObject({ ttftMs: 10, ttfaMs: 50, thinkingObserved: true });
    }
  });
  it("invalidates reasoning-only speed repeats terminated by an orphan close", () => {
    for (const pieces of [["reasoning", "</think>"], ["reasoning", "</thi", "nk> \n"]]) {
      const cap = capture([...pieces.map((content) => JSON.stringify({ message: { content } })), '{"done":true,"eval_count":20,"eval_duration":1000000000}']);
      const repeat = buildSpeedRepeat("fixture", 1, cap);
      expect(repeat).toMatchObject({ valid: false, ttftMs: 10, ttfaMs: null, thinkingObserved: true });
      expect(repeat.invalidReason).toContain("no answer content");
    }
  });
  it("maps retained answer spans to arrival chunks after the last orphan close", () => {
    const cases = [
      { pieces: ["42 reasoning", "</think> 42"], ttfaMs: 20 },
      { pieces: ["thought", "</think>provisional", "</THINK >", "42"], ttfaMs: 40 },
      { pieces: ["<think>wrong</think>", "42", "<think>later thought</think>"], ttfaMs: 20 },
      { pieces: ["<think>wrong</think>", " ", "42<think>unfinished"], ttfaMs: 30 },
    ];
    for (const c of cases) {
      const cap = capture(c.pieces.map((content) => JSON.stringify({ message: { content } })));
      expect(streamTiming(cap)).toMatchObject({ ttftMs: 10, ttfaMs: c.ttfaMs, thinkingObserved: true });
    }
  });
  it("invalidates nonfinite and fractional token counts without schema-invalid saved metrics", () => {
    for (const usage of ["1e999", "-1", "1.5", "0"]) {
      const cap = capture(["{\"message\":{\"content\":\"42\"}}", `{\"done\":true,\"eval_count\":${usage},\"eval_duration\":1000000000}`]);
      expect(buildSpeedRepeat("fixture", 1, cap).valid).toBe(false);
    }
  });
  it("buffers every byte boundary including multibyte UTF-8 and no final newline", () => {
    const body = bytes('{"message":{"content":"café"}}\n{"done":true}');
    for (let cut = 0; cut <= body.length; cut++) {
      const splitter = createLineSplitter({ lineBytes: 1000, streamBytes: 2000 });
      const steps = [splitter.push(body.slice(0, cut)), splitter.push(body.slice(cut)), splitter.end()];
      expect(steps.every((step) => step.failure === null)).toBe(true);
      expect(steps.flatMap((step) => step.lines)).toEqual(['{"message":{"content":"café"}}', '{"done":true}']);
    }
  });
  it("enforces line and whole-stream byte caps and malformed UTF-8", () => {
    expect(createLineSplitter({ lineBytes: 3, streamBytes: 100 }).push(bytes("1234")).failure?.code).toBe("oversize_line");
    expect(createLineSplitter({ lineBytes: 10, streamBytes: 3 }).push(bytes("12\n3")).failure?.code).toBe("oversize_stream");
    expect(createLineSplitter({ lineBytes: 10, streamBytes: 20 }).push(new Uint8Array([0xff, 0x0a])).failure?.code).toBe("malformed");
    expect(parseChatLine("not json", 0).ok).toBe(false);
  });
});
