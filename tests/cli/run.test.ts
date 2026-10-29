import { describe, expect, it } from "vitest";
import type { ChatChunk, ProcessEntry, Runtime } from "../../src/core/index.js";
import { DEFAULT_PROTOCOL_CAPS, parseRunFileValue } from "../../src/core/index.js";
import { collectRun, canUnload, runCommand } from "../../cli/run.js";
import { probeCommand } from "../../cli/probe.js";
import { discoverCommand } from "../../cli/discover.js";
import { loadBundledData } from "../../cli/io/read.js";
import { createMockRuntime, MOCK_BASE_URL, MOCK_MODELS } from "../../cli/providers/mock.js";
import { fakeContext } from "./helpers.js";

describe("CLI collector boundaries (runtime deferred)", () => {
  it("default mock dry-run ignores endpoint/key, never generates, probes or writes", async () => {
    const f = fakeContext();
    expect(await runCommand(["--host", "https://anything.invalid"], f.ctx)).toBe(0);
    expect(f.saved).toHaveLength(0); expect(f.probes).toHaveLength(0); expect(f.network).toHaveLength(0);
    expect(f.lines.join("\n")).toContain("Dry-run");
  });
  it("live dry-run sends only /api/tags and never writes or probes", async () => {
    const f = fakeContext();
    const data = await loadBundledData();
    const mock = createMockRuntime({ items: data.bank.items, caps: { ...DEFAULT_PROTOCOL_CAPS } });
    const requests: string[] = [];
    f.ctx.fetch = async (url, init) => { requests.push(new URL(url).pathname); return mock.server.fetch(`${MOCK_BASE_URL}${new URL(url).pathname}`, init); };
    expect(await runCommand(["--runtime", "ollama", "--host", "http://localhost:11434"], f.ctx)).toBe(0);
    expect(requests).toEqual(["/api/tags"]); expect(f.probes).toHaveLength(0); expect(f.saved).toHaveLength(0);
  });
  it("mock probe/discover stay offline and do not read local OS identity", async () => {
    const f = fakeContext();
    expect(await probeCommand(["--json"], f.ctx)).toBe(0);
    expect(await discoverCommand(["--json"], f.ctx)).toBe(0);
    expect(f.probes).toHaveLength(0); expect(f.network).toHaveLength(0);
  });
  it("explicit mock sweep writes schema-valid exact repeats/items with fixed fingerprint", async () => {
    const f = fakeContext();
    expect(await runCommand(["--yes"], f.ctx)).toBe(0);
    const run = f.saved[0]; expect(run).toBeDefined(); if (!run) return;
    expect(parseRunFileValue(run).ok).toBe(true);
    expect(run).toMatchObject({ runtime: "mock", synthetic: true, fingerprint: { source: "mock", scopeId: "mock-v1" } });
    for (const row of run.candidates) { expect(row.status).toBe("measured"); expect(row.speed).toHaveLength(12); expect(row.items).toHaveLength(30); }
    expect(f.probes).toHaveLength(0); expect(f.network).toHaveLength(0);
  });
  it("remote collection has run-scoped unknown hardware and never probes the client", async () => {
    const f = fakeContext(); const data = await loadBundledData();
    const mock = createMockRuntime({ items: data.bank.items, caps: { ...DEFAULT_PROTOCOL_CAPS } });
    f.ctx.clock = mock.clock;
    f.ctx.fetch = (url, init) => mock.server.fetch(`${MOCK_BASE_URL}${new URL(url).pathname}`, init);
    expect(await runCommand(["--yes", "--runtime", "ollama", "--host", "http://example.invalid:11434", "--allow-remote"], f.ctx)).toBe(0);
    expect(f.saved[0]?.fingerprint).toMatchObject({ source: "remote-unknown", scopeId: f.saved[0]?.runId, cpuModel: null, ramBytes: null });
    expect(f.saved[0]?.availableMemory.source).toBe("unavailable"); expect(f.probes).toHaveLength(0);
  });
  it("Ctrl-C preserves completed records and leaves later candidates skipped", async () => {
    const f = fakeContext(); await runCommand(["--yes"], f.ctx);
    const run = f.saved[0]; if (!run) throw new Error("draft missing");
    for (const row of run.candidates) Object.assign(row, { status: "skipped", statusReason: "not started", speed: [], memory: [], items: [], wallClockMs: 0, loadedByRun: false });
    const data = await loadBundledData(); const mock = createMockRuntime({ items: data.bank.items, caps: { ...DEFAULT_PROTOCOL_CAPS } });
    const stop = new AbortController(); const base = mock.runtime;
    const runtime: Runtime = { ...base, async *chatStream(): AsyncGenerator<ChatChunk> { yield { type: "content", text: "partial", atMs: 10 }; stop.abort(); throw new Error("interrupted"); } };
    await collectRun({ run, requestCandidates: run.candidates.map((r) => r.candidate), data, runtime, clock: mock.clock, signal: stop.signal, metadataRedaction: {}, answerRedaction: {}, timers: f.ctx.timers });
    expect(run.flags).toContain("interrupted"); expect(run.candidates[0]?.status).toBe("incomplete"); expect(run.candidates[1]?.status).toBe("skipped");
    expect(parseRunFileValue(run).ok).toBe(true);
  });
  it("unloads only absent-at-start, run-loaded, still-resident exact identity", () => {
    const p = MOCK_MODELS[0]; if (!p) throw new Error("profile missing");
    const candidate = { key: `${p.name}@${p.digest.slice(0, 12)}`, tag: p.name, digest: p.digest, family: p.family, parameterSize: p.parameterSize, quantization: p.quantizationLevel, sizeBytes: p.sizeBytes };
    const resident: ProcessEntry = { name: p.name, digest: p.digest, sizeBytes: 1, sizeVramBytes: 1, expiresAt: null };
    expect(canUnload(candidate, [], true, [resident])).toBe(true);
    expect(canUnload(candidate, [resident], true, [resident])).toBe(false);
    expect(canUnload(candidate, null, true, [resident])).toBe(false);
    expect(canUnload(candidate, [], false, [resident])).toBe(false);
    expect(canUnload(candidate, [], true, [])).toBe(false);
    expect(canUnload(candidate, [], true, [resident, { ...resident, name: "alias" }])).toBe(false);
    expect(canUnload(candidate, [{ ...resident, name: "alias" }], true, [resident])).toBe(false);
  });
});
