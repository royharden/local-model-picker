// Contract tests for the v1 run file and readRunFile (authored in Dirty Mode; not yet run).
import { describe, it, expect } from "vitest";
import {
  readRunFile,
  serializeRunFile,
  checkRunFileSize,
  utf8ByteLength,
  RUN_FILE_MAX_BYTES,
  RecommendConfigSchema,
  DEFAULT_CONSTRAINTS_QUALITY,
  DEFAULT_SELECTION_OPTIONS,
  HardwareFingerprintSchema,
  RecommendResultSchema,
  MemoryObservationSchema,
  RAW_ANSWER_MAX_CHARS,
  REDACTED_RAW_MAX_CHARS,
  checkRulings,
  redact,
} from "../../src/core/index.js";
import type { RunFile, Result } from "../../src/core/index.js";

type Item = RunFile["candidates"][number]["items"][number];
import { makeRun, makeMockRun, measuredCandidate, ruling, encode, ITEM_IDS, PROMPT_IDS, speedRepeat, itemResult, localFingerprint } from "../helpers/runfile.js";

function read(run: unknown): Result<RunFile> {
  return readRunFile(encode(JSON.stringify(run)));
}

function expectOk(r: Result<RunFile>): RunFile {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.value;
}

function expectError(r: Result<RunFile>, pathPrefix: string, message: RegExp): void {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  const hit = r.errors.some((e) => e.path.startsWith(pathPrefix) && message.test(e.message));
  if (!hit) throw new Error(`no error at ${pathPrefix} matching ${String(message)}; got ${JSON.stringify(r.errors)}`);
}

describe("readRunFile: valid files", () => {
  it("accepts a valid loopback run and round-trips through serializeRunFile", () => {
    const run = makeRun();
    const value = expectOk(readRunFile(encode(serializeRunFile(run))));
    expect(value).toEqual(run);
  });

  it("accepts a valid mock run", () => {
    expectOk(read(makeMockRun()));
  });
});

describe("readRunFile: 10,000,000-byte cap", () => {
  it("accepts a file of exactly 10,000,000 bytes and rejects one byte more", () => {
    const base = serializeRunFile(makeRun());
    const padding = RUN_FILE_MAX_BYTES - utf8ByteLength(base);
    expect(padding).toBeGreaterThan(0);
    // Trailing whitespace is valid JSON, so the padded file differs only in size.
    const exact = encode(base + " ".repeat(padding));
    expect(exact.length).toBe(10_000_000);
    expectOk(readRunFile(exact));

    const over = encode(base + " ".repeat(padding + 1));
    expect(over.length).toBe(10_000_001);
    expectError(readRunFile(over), "", /10000001 bytes; the limit is 10000000 bytes/);
  });

  it("checkRunFileSize counts UTF-8 bytes, not UTF-16 units", () => {
    expect(utf8ByteLength("aé€\u{1F600}")).toBe(1 + 2 + 3 + 4);
    expect(checkRunFileSize("x".repeat(RUN_FILE_MAX_BYTES)).ok).toBe(true);
    const big = checkRunFileSize("x".repeat(RUN_FILE_MAX_BYTES + 1));
    expect(big.ok).toBe(false);
  });
});

describe("readRunFile: malformed input", () => {
  it("rejects invalid UTF-8 and invalid JSON", () => {
    expectError(readRunFile(new Uint8Array([0x7b, 0xff, 0x7d])), "", /not valid UTF-8/);
    expectError(readRunFile(encode("{ not json")), "", /not valid JSON/);
    expectError(readRunFile(encode("[]")), "", /JSON object/);
  });

  it("rejects an unknown schemaVersion with an explicit message", () => {
    expectError(read({ ...makeRun(), schemaVersion: 2 }), "schemaVersion", /unsupported schemaVersion 2/);
    const rest: Record<string, unknown> = { ...makeRun() };
    delete rest["schemaVersion"];
    expectError(read(rest), "schemaVersion", /missing schemaVersion/);
  });

  it("rejects non-finite numbers (JSON overflow) with their path", () => {
    const text = JSON.stringify(makeRun()).replace('"wallClockMs":60000', '"wallClockMs":1e999');
    expect(text).toContain("1e999");
    expectError(readRunFile(encode(text)), "candidates[0].wallClockMs", /non-finite/);
  });

  it("rejects unknown fields (strict objects)", () => {
    expectError(read({ ...makeRun(), extra: true }), "", /Unrecognized key/);
  });
});

describe("readRunFile: item ids", () => {
  it("rejects duplicate item ids in itemIds", () => {
    const run = makeRun();
    run.itemIds = [...ITEM_IDS, "num-01"];
    expectError(read(run), "itemIds", /duplicate item id num-01/);
  });

  it("rejects a duplicate item result inside a candidate", () => {
    const run = makeRun();
    const c = run.candidates[0] as RunFile["candidates"][number];
    c.items = [...c.items.slice(0, -1), itemResult("num-01")];
    expectError(read(run), "candidates[0].items", /duplicate item result for num-01/);
  });

  it("rejects a foreign item id", () => {
    const run = makeRun();
    const c = run.candidates[0] as RunFile["candidates"][number];
    c.items = [...c.items.slice(0, -1), itemResult("not-in-bank")];
    expectError(read(run), "candidates[0].items", /not in itemIds/);
  });
});

describe("readRunFile: status-discriminated candidates", () => {
  it("a measured candidate needs one result per item id", () => {
    const run = makeRun();
    const c = run.candidates[0] as RunFile["candidates"][number];
    c.items = c.items.slice(1);
    expectError(read(run), "candidates[0].items", /exactly one result per item id/);
  });

  it("a measured candidate needs the full speed set (3 prompts x (1 warm-up + 3 repeats))", () => {
    const run = makeRun();
    const c = run.candidates[0] as RunFile["candidates"][number];
    c.speed = c.speed.slice(0, 11);
    expectError(read(run), "candidates[0].speed", /full speed set/);
  });

  it("incomplete, failed and skipped candidates validate with a bounded subset and a statusReason", () => {
    const run = makeRun();
    const incomplete = measuredCandidate("qwen2.5:7b-q8_0", "1111222233334444".repeat(4));
    incomplete.status = "incomplete";
    incomplete.statusReason = "interrupted (Ctrl-C) after 2 items";
    incomplete.items = [itemResult("num-01"), itemResult("num-02", false)];
    incomplete.speed = [speedRepeat(PROMPT_IDS[0] as string, 0), speedRepeat(PROMPT_IDS[0] as string, 1)];
    const skipped = measuredCandidate("qwen2.5:7b-q4_0", "5555666677778888".repeat(4));
    skipped.status = "skipped";
    skipped.statusReason = "run interrupted before this candidate";
    skipped.items = [];
    skipped.speed = [];
    skipped.memory = [];
    const failed = measuredCandidate("phi3:mini-q4_K_M", "9999aaaabbbbcccc".repeat(4));
    failed.status = "failed";
    failed.statusReason = "stream ended without a done chunk";
    failed.items = [];
    run.candidates.push(incomplete, skipped, failed);
    expectOk(read(run));
  });

  it("a partial candidate must state its statusReason and never repeat a (prompt, repeat) pair", () => {
    const run = makeRun();
    const c = run.candidates[0] as RunFile["candidates"][number];
    c.status = "incomplete";
    c.statusReason = null;
    expectError(read(run), "candidates[0].statusReason", /statusReason/);

    const run2 = makeRun();
    const c2 = run2.candidates[0] as RunFile["candidates"][number];
    c2.status = "incomplete";
    c2.statusReason = "interrupted";
    c2.speed = [speedRepeat("long-gen", 1), speedRepeat("long-gen", 1)];
    expectError(read(run2), "candidates[0].speed", /duplicate \(promptId, repeat\) pair/);
  });

  it("rejects duplicate candidate keys", () => {
    const run = makeRun();
    run.candidates.push(measuredCandidate());
    expectError(read(run), "candidates", /duplicate candidate key/);
  });

  it("a valid repeat never has a zero generation rate", () => {
    const run = makeRun();
    const c = run.candidates[0] as RunFile["candidates"][number];
    const r = c.speed[1] as RunFile["candidates"][number]["speed"][number];
    r.evalMs = 0;
    expectError(read(run), "candidates[0].speed[1]", /evalMs > 0/);
  });
});

describe("readRunFile: runtime / remote flag consistency", () => {
  it("runtime mock requires synthetic, a mock fingerprint and endpointKind mock", () => {
    expectError(read({ ...makeMockRun(), synthetic: false }), "synthetic", /synthetic true/);
    expectError(read({ ...makeMockRun(), endpointKind: "loopback" }), "endpointKind", /endpointKind mock/);
    expectError(read({ ...makeMockRun(), fingerprint: localFingerprint() }), "fingerprint", /fingerprint.source mock/);
  });

  it("a remote run needs a remote-unknown fingerprint scoped to its runId", () => {
    const run = makeRun();
    const remote = {
      ...run,
      remote: true,
      endpointKind: "remote",
      availableMemory: { vramFreeBytes: null, ramFreeBytes: null, source: "unavailable", at: run.createdAt },
      fingerprint: {
        source: "remote-unknown",
        scopeId: run.runId,
        cpuModel: null,
        cpuThreads: null,
        ramBytes: null,
        os: null,
        gpu: { vendor: "unknown", name: null, vramTotalBytes: null, unifiedMemory: null },
        canonical: {
          source: "remote-unknown",
          scopeId: run.runId,
          cpuModel: null,
          cpuThreads: null,
          ramGiB: null,
          platform: null,
          gpuVendor: "unknown",
          gpuName: null,
          vramGiB: null,
        },
        hash: "aaaabbbbcccc",
      },
    };
    expectOk(read(remote));
    const wrongScope = { ...remote, fingerprint: { ...remote.fingerprint, scopeId: "other-run", canonical: { ...remote.fingerprint.canonical, scopeId: "other-run" } } };
    expectError(read(wrongScope), "fingerprint.scopeId", /scopeId equal to runId/);
    expectError(read({ ...run, remote: true, endpointKind: "remote" }), "fingerprint.source", /remote-unknown/);
  });

  it("the canonical fingerprint must agree with its descriptive fields", () => {
    const fp = localFingerprint();
    fp.canonical.ramGiB = 31;
    expect(HardwareFingerprintSchema.safeParse(fp).success).toBe(false);
  });
});

describe("readRunFile: rulings", () => {
  it("accepts strictly increasing seq with a valid previousRulingId chain", () => {
    const run = makeRun();
    run.rulings = [ruling(1), ruling(2, { previousRulingId: "ruling-1", overrideCorrect: true })];
    expectOk(read(run));
  });

  it("rejects a duplicate or decreasing seq", () => {
    const dup = makeRun();
    dup.rulings = [ruling(1), ruling(1, { id: "ruling-1b" })];
    expectError(read(dup), "rulings[1].seq", /strictly increasing/);
    const dec = makeRun();
    dec.rulings = [ruling(2), ruling(1)];
    expectError(read(dec), "rulings[1].seq", /strictly increasing/);
  });

  it("rejects dangling references", () => {
    const foreignRun = makeRun();
    foreignRun.rulings = [ruling(1, { runId: "some-other-run" })];
    expectError(read(foreignRun), "rulings[0].runId", /this file is run/);

    const noCandidate = makeRun();
    noCandidate.rulings = [ruling(1, { candidateKey: "ghost:latest@000000000000" })];
    expectError(read(noCandidate), "rulings[0].candidateKey", /not in this run/);

    const noItem = makeRun();
    noItem.rulings = [ruling(1, { itemId: "missing-item" })];
    expectError(read(noItem), "rulings[0].itemId", /no result/);

    const noPrev = makeRun();
    noPrev.rulings = [ruling(1, { previousRulingId: "never-existed" })];
    expectError(read(noPrev), "rulings[0].previousRulingId", /earlier ruling/);
  });

  it("rejects a reason outside 1..500 characters", () => {
    const run = makeRun();
    run.rulings = [ruling(1, { reason: "" })];
    expectError(read(run), "rulings[0].reason", /.+/);
    run.rulings = [ruling(1, { reason: "x".repeat(501) })];
    expectError(read(run), "rulings[0].reason", /.+/);
  });

  it("rejects a ruling whose originalCorrect differs from the item's graded correct", () => {
    // num-01 is graded correct: true in makeRun.
    const run = makeRun();
    run.rulings = [ruling(1, { originalCorrect: false, overrideCorrect: true })];
    expectError(read(run), "rulings[0].originalCorrect", /graded correct/);

    const gradedWrong = makeRun();
    const c = gradedWrong.candidates[0] as RunFile["candidates"][number];
    c.items = c.items.map((r) => (r.itemId === "num-01" ? itemResult("num-01", false) : r));
    gradedWrong.rulings = [ruling(1, { originalCorrect: false, overrideCorrect: true })];
    expectOk(read(gradedWrong));
    gradedWrong.rulings = [ruling(1)];
    expectError(read(gradedWrong), "rulings[0].originalCorrect", /graded correct/);
  });

  it("checkRulings reads graded correctness from RulingContext.correctByCandidate", () => {
    const key = measuredCandidate().candidate.key;
    const issues = checkRulings([ruling(1)], {
      runId: "run-2026-10-24-a",
      correctByCandidate: new Map([[key, new Map([["num-01", false]])]]),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["rulings", 0, "originalCorrect"]);
    const agree = checkRulings([ruling(1)], {
      runId: "run-2026-10-24-a",
      correctByCandidate: new Map([[key, new Map([["num-01", true]])]]),
    });
    expect(agree).toEqual([]);
  });
});

describe("readRunFile: stored raw after redaction (D9)", () => {
  it("accepts an 8,000-char capped answer that redaction (::1 -> <ipv6>) makes longer than 8,000", () => {
    const capped = "::1 " + "z".repeat(RAW_ANSWER_MAX_CHARS - 4);
    expect(capped.length).toBe(RAW_ANSWER_MAX_CHARS);
    const raw = redact(capped);
    expect(raw.startsWith("<ipv6> ")).toBe(true);
    expect(raw.length).toBe(RAW_ANSWER_MAX_CHARS + 3);
    const run = makeRun();
    const first = (run.candidates[0] as RunFile["candidates"][number]).items[0] as Item;
    first.raw = raw;
    first.truncated = true;
    first.flags = ["over_cap"];
    expectOk(read(run));
  });

  it("rejects stored raw beyond REDACTED_RAW_MAX_CHARS and beyond 4 x a smaller protocol.caps.rawChars", () => {
    const run = makeRun();
    const first = (run.candidates[0] as RunFile["candidates"][number]).items[0] as Item;
    first.raw = "z".repeat(REDACTED_RAW_MAX_CHARS + 1);
    expectError(read(run), "candidates[0].items[0].raw", /at most|exceeds/);

    const small = makeRun();
    small.protocol.caps.rawChars = 1000;
    const item = (small.candidates[0] as RunFile["candidates"][number]).items[0] as Item;
    item.raw = "z".repeat(4000);
    expectOk(read(small));
    item.raw = "z".repeat(4001);
    expectError(read(small), "candidates[0].items[0].raw", /exceeds 4 x protocol\.caps\.rawChars/);
  });
});

describe("memory observations: offloadFraction consistency", () => {
  const obs = (sizeBytes: number, sizeVramBytes: number, offloadFraction: number | null): unknown => ({
    phase: "after-load",
    sizeBytes,
    sizeVramBytes,
    offloadFraction,
    source: "api/ps",
  });
  const valid = (o: unknown): boolean => MemoryObservationSchema.safeParse(o).success;

  it("offloadFraction equals sizeVramBytes / sizeBytes (within 1e-9) when sizeBytes > 0 and sizeVramBytes <= sizeBytes", () => {
    expect(valid(obs(10, 5, 0.5))).toBe(true);
    expect(valid(obs(3, 1, 1 / 3))).toBe(true);
    expect(valid(obs(3, 1, 1 / 3 + 1e-12))).toBe(true);
    expect(valid(obs(10, 10, 1))).toBe(true);
    expect(valid(obs(10, 0, 0))).toBe(true);
    expect(valid(obs(10, 5, 0.4))).toBe(false);
    expect(valid(obs(3, 1, 1 / 3 + 1e-6))).toBe(false);
    expect(valid(obs(10, 5, null))).toBe(false);
  });

  it("offloadFraction is null when sizeBytes is 0 or sizeVramBytes > sizeBytes", () => {
    expect(valid(obs(0, 0, null))).toBe(true);
    expect(valid(obs(0, 0, 0))).toBe(false);
    expect(valid(obs(10, 12, null))).toBe(true);
    expect(valid(obs(10, 12, 1))).toBe(false);
  });

  it("an inconsistent observation in a run file is reported at its path", () => {
    const run = makeRun();
    const m = (run.candidates[0] as RunFile["candidates"][number]).memory[0] as RunFile["candidates"][number]["memory"][number];
    m.offloadFraction = 0.5;
    expectError(read(run), "candidates[0].memory[0].offloadFraction", /sizeVramBytes \/ sizeBytes/);
  });
});

describe("timestamps (isoUtc field ranges)", () => {
  it("accepts in-range UTC timestamps and rejects out-of-range month, day, hour, minute or second", () => {
    expectOk(read({ ...makeRun(), createdAt: "2026-12-31T23:59:59.999Z" }));
    expectOk(read({ ...makeRun(), createdAt: "2026-01-01T00:00:00.000Z" }));
    for (const bad of [
      "2026-13-01T00:00:00.000Z",
      "2026-00-10T00:00:00.000Z",
      "2026-10-32T00:00:00.000Z",
      "2026-10-00T00:00:00.000Z",
      "2026-10-24T24:00:00.000Z",
      "2026-10-24T23:60:00.000Z",
      "2026-10-24T23:59:60.000Z",
    ]) {
      expectError(read({ ...makeRun(), createdAt: bad }), "createdAt", /UTC timestamp/);
    }
  });
});

describe("constraints and results", () => {
  it("the speed objective requires minAccuracy", () => {
    const bad = RecommendConfigSchema.safeParse({
      constraints: { ...DEFAULT_CONSTRAINTS_QUALITY, minAccuracy: null },
      options: { ...DEFAULT_SELECTION_OPTIONS, objective: "speed" },
    });
    expect(bad.success).toBe(false);
    const good = RecommendConfigSchema.safeParse({
      constraints: { ...DEFAULT_CONSTRAINTS_QUALITY, minAccuracy: 0.6 },
      options: { ...DEFAULT_SELECTION_OPTIONS, objective: "speed" },
    });
    expect(good.success).toBe(true);
  });

  it("a none result is low confidence with a reason and has no pick", () => {
    const row = (method: "estimate-only" | "fastest-only" | "accuracy-only") => ({
      method,
      label: method,
      available: false,
      pick: null,
      reason: "no candidates",
      violations: [],
    });
    const base = {
      kind: "none" as const,
      group: null,
      groupsAvailable: [],
      message: "No candidate meets your limits",
      pick: null,
      runnerUp: null,
      tied: false,
      noiseSet: [],
      confidence: "low" as const,
      confidenceReasons: ["no candidate meets the limits"],
      speedComparison: null,
      perCandidate: [],
      trace: [],
      baselines: { estimateOnly: row("estimate-only"), fastestOnly: row("fastest-only"), accuracyOnly: row("accuracy-only") },
      command: null,
    };
    expect(RecommendResultSchema.safeParse(base).success).toBe(true);
    expect(RecommendResultSchema.safeParse({ ...base, confidence: "high" }).success).toBe(false);
    expect(RecommendResultSchema.safeParse({ ...base, pick: "x@000000000000" }).success).toBe(false);
  });
});
