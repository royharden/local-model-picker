// Run-file writer (Claude §2.5/§2.7; PLAN.md M4 acceptance 4). Writes ONLY inside the chosen output
// directory (--out, default ./out), atomically (same-directory synced temp + no-clobber hard link), never over
// an existing file, and only after the run validates against the zod schema and its serialised bytes
// pass the 10,000,000-byte cap. Over the cap or invalid: nothing is written, the reason is returned.
import { link, mkdir, open, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { RunFile, ValidationIssue } from "../../src/core/index.js";
import { RUN_FILE_MAX_BYTES, checkRunFileSize, parseRunFileValue, serializeRunFile } from "../../src/core/index.js";

export type WriteResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; message: string; issues: ValidationIssue[] };

/** A bare file name: no separators, no "..", no drive letters, printable, bounded. */
export function isSafeFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !name.includes("..") &&
    path.basename(name) === name
  );
}

/** Resolve `fileName` inside `outDir`; null when it would escape the directory. */
export function targetInside(outDir: string, fileName: string): string | null {
  if (!isSafeFileName(fileName)) return null;
  const dir = path.resolve(outDir);
  const target = path.resolve(dir, fileName);
  const rel = path.relative(dir, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  return target;
}

function errorCode(e: unknown): string | null {
  if (e === null || typeof e !== "object" || !("code" in e)) return null;
  return typeof e.code === "string" ? e.code : null;
}

/**
 * Publish a fully written, synced temp file with link(), which atomically refuses an existing target.
 * A preflight stat plus rename can replace a concurrent writer's destination. Hard-link publication
 * has no such gap and no rename fallback: unsupported filesystems fail without publishing anything.
 */
export async function writeTextAtomic(outDir: string, fileName: string, text: string): Promise<WriteResult> {
  if (Buffer.byteLength(text, "utf8") > RUN_FILE_MAX_BYTES) return { ok: false, message: `output exceeds ${RUN_FILE_MAX_BYTES} bytes; nothing written`, issues: [] };
  const target = targetInside(outDir, fileName);
  if (target === null) return { ok: false, message: `refusing to write "${fileName.slice(0, 80)}": not a plain file name inside the output directory`, issues: [] };
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let tempOwned = false;
  let publishing = false;
  try {
    await mkdir(dir, { recursive: true });
    handle = await open(temp, "wx");
    tempOwned = true;
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    publishing = true;
    await link(temp, target);
  } catch (e) {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (tempOwned) await rm(temp, { force: true }).catch(() => undefined);
    const code = errorCode(e);
    if (publishing && code === "EEXIST") return { ok: false, message: `refusing to overwrite existing ${path.basename(target)}`, issues: [] };
    if (publishing && code !== null && ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EPERM"].includes(code)) {
      return { ok: false, message: `atomic no-overwrite publication requires same-filesystem hard-link support (${code}); destination not published`, issues: [] };
    }
    return { ok: false, message: `write failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`, issues: [] };
  }
  // Publication already succeeded. Cleanup failure must not misreport a saved file as unwritten.
  await rm(temp, { force: true }).catch(() => undefined);
  return { ok: true, path: target, bytes: Buffer.byteLength(text, "utf8") };
}

/** File name of a run: `<runId>.json` (runId is "run-<timestamp>"). */
export function runFileName(run: RunFile): string {
  return `${run.runId}.json`;
}

/** Validate (zod), serialise, size-check, then write atomically. */
export async function writeRunFile(run: RunFile, outDir: string): Promise<WriteResult> {
  const valid = parseRunFileValue(run);
  if (!valid.ok) return { ok: false, message: "the run did not validate against the run-file schema; nothing was written", issues: valid.errors };
  const text = serializeRunFile(valid.value);
  const size = checkRunFileSize(text);
  if (!size.ok) return { ok: false, message: size.message, issues: [] };
  return writeTextAtomic(outDir, runFileName(run), text);
}
