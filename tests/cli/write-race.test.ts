// Authored regression sources only; do not execute while Dirty Mode is active.
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeTextAtomic } from "../../cli/io/write.js";

// Keep real disk operations, but permit a deterministic competing write at the publication boundary.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});

describe("atomic no-overwrite publication", () => {
  it("preserves a destination created after the temp file is complete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lmp-publish-race-"));
    try {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(link).mockImplementationOnce(async (source, target) => {
        // A different process wins exactly when the old stat-then-rename implementation was unsafe.
        await writeFile(target, "concurrent owner's bytes", { flag: "wx" });
        await actual.link(source, target);
      });
      const result = await writeTextAtomic(dir, "report.md", "this writer's bytes");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("refusing to overwrite");
      expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("concurrent owner's bytes");
      expect(await readdir(dir)).toEqual(["report.md"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("allows exactly one of eight concurrent same-name writers to publish", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lmp-concurrent-write-"));
    try {
      const texts = Array.from({ length: 8 }, (_, index) => `writer-${index}`);
      const results = await Promise.all(texts.map((text) => writeTextAtomic(dir, "report.md", text)));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const winner = results.findIndex((result) => result.ok);
      expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe(texts[winner]);
      expect(await readdir(dir)).toEqual(["report.md"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("fails explicitly without a rename fallback when hard links are unsupported", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lmp-no-hardlinks-"));
    try {
      vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("links unavailable"), { code: "ENOTSUP" }));
      const result = await writeTextAtomic(dir, "report.md", "complete bytes");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("hard-link support");
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
