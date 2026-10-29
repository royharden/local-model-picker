import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_FILE_MAX_BYTES, readRunFile } from "../../src/core/index.js";
import { isSafeFileName, targetInside, writeRunFile, writeTextAtomic } from "../../cli/io/write.js";
import { runCommand } from "../../cli/run.js";
import { estimateRunFileBytes } from "../../cli/plan.js";
import { fakeContext } from "./helpers.js";

describe("atomic bounded output", () => {
  it("refuses path escape and validates a plain output filename", () => {
    for (const name of ["../escape.json", "..\\escape.json", "C:\\escape.json", "/escape.json", "x/y.json", "a..b.json"]) {
      expect(isSafeFileName(name)).toBe(false); expect(targetInside("out", name)).toBeNull();
    }
    expect(targetInside("out", "run-safe.json")).toBe(path.resolve("out", "run-safe.json"));
  });
  it("estimates size and warns before a long sweep that cannot be saved", () => {
    expect(estimateRunFileBytes(64, 30, 8000)).toBeGreaterThan(RUN_FILE_MAX_BYTES);
    expect(estimateRunFileBytes(3, 30, 8000)).toBeLessThan(RUN_FILE_MAX_BYTES);
  });
  it("round-trips a collected run atomically, leaving no temp files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lmp-io-test-"));
    try {
      const f = fakeContext(); await runCommand(["--yes"], f.ctx);
      const run = f.saved[0]; if (!run) throw new Error("run missing");
      const written = await writeRunFile(run, dir); expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(readRunFile(await readFile(written.path)).ok).toBe(true);
      expect(await readdir(dir)).toEqual([`${run.runId}.json`]);
      expect((await writeRunFile(run, dir)).ok).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("checks serialized byte cap before creating a file or directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lmp-cap-test-"));
    try {
      const missing = path.join(dir, "not-created");
      expect((await writeTextAtomic(missing, "huge.md", "x".repeat(RUN_FILE_MAX_BYTES + 1))).ok).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
