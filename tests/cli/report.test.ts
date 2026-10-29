// Authored for later activation; Dirty Mode does not execute these tests.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP } from "../../cli/index.js";
import { parseSelectionArgs } from "../../cli/recommend.js";
import { reportCommand } from "../../cli/report.js";
import { fakeContext } from "./helpers.js";

const runPath = fileURLToPath(new URL("../../fixtures/runs/s01-q2-accuracy-collapse.json", import.meta.url));

describe("report --md filename", () => {
  it("accepts the planned invocation and documents its output-directory rule", () => {
    expect(parseSelectionArgs(["run.json", "--md", "out.md"], true)).toMatchObject({ mdFile: "out.md", outDir: undefined });
    expect(parseSelectionArgs(["run.json", "--md", "out.md", "--out", "reports"], true)).toMatchObject({ mdFile: "out.md", outDir: "reports" });
    expect(HELP).toContain("--md report.md");
    expect(HELP).toContain("plain filename inside --out (default cwd)");
  });

  it("rejects filename escapes before importing input or writing output", () => {
    for (const file of ["", "../escape.md", "..\\escape.md", "/escape.md", "C:\\escape.md", "nested/report.md", "a..b.md"]) {
      expect(() => parseSelectionArgs(["run.json", "--md", file], true)).toThrow("plain filename");
    }
  });

  it("writes exactly --md in cwd or --out, with bounded no-overwrite publication", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lmp-report-md-"));
    try {
      const f = fakeContext();
      f.ctx.cwd = dir;
      expect(await reportCommand([runPath, "--md", "out.md"], f.ctx)).toBe(0);
      const first = await readFile(path.join(dir, "out.md"), "utf8");
      expect(first.length).toBeGreaterThan(0);
      expect(await readdir(dir)).toEqual(["out.md"]);
      expect(await reportCommand([runPath, "--md", "custom.md", "--out", "reports"], f.ctx)).toBe(0);
      expect(await readFile(path.join(dir, "reports", "custom.md"), "utf8")).toBe(first);
      expect(await readdir(path.join(dir, "reports"))).toEqual(["custom.md"]);
      expect(await reportCommand([runPath, "--md", "out.md"], f.ctx)).toBe(1);
      expect(f.errors.join("\n")).toContain("refusing to overwrite");
      expect(await readFile(path.join(dir, "out.md"), "utf8")).toBe(first);
      expect(f.probes).toHaveLength(0); expect(f.network).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
