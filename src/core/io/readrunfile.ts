// readRunFile(bytes): the one import path for run files, shared by the CLI (cli/io/read.ts) and the
// viewer (file input). Order: size cap -> UTF-8 decode -> JSON.parse -> nesting/non-finite scan ->
// explicit schemaVersion check -> zod RunFileSchema. Writers use serializeRunFile + checkRunFileSize.
// Seam owner: S32-INT.
import { RunFileSchema, RUN_SCHEMA_VERSION } from "../schema/runfile.js";
import type { RunFile } from "../schema/runfile.js";
import { RUN_FILE_MAX_BYTES } from "../config/defaults.js";

/**
 * Minimal local declaration of the WHATWG TextDecoder. tsconfig.core.json uses lib ES2022 with
 * types [] (no DOM, no Node), which does not type TextDecoder, although every target runtime
 * (Node >= 20.11, browsers) provides it as a global. Declared at module scope so it cannot clash
 * with the DOM/Node declarations seen by tsconfig.app.json and tsconfig.test.json.
 */
declare const TextDecoder: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): { decode(input: Uint8Array): string };
};

export interface ValidationIssue {
  /** dotted path such as "candidates[0].items[3].itemId"; "" for the whole file */
  path: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: ValidationIssue[] };

/** At most this many issues are returned; a final entry says how many were omitted. */
export const MAX_REPORTED_ISSUES = 50;
/** Deeper JSON is rejected before schema validation (a run file is about 6 levels deep). */
export const MAX_JSON_DEPTH = 64;

function fail<T>(path: string, message: string): Result<T> {
  return { ok: false, errors: [{ path, message }] };
}

export function formatPath(path: readonly (string | number)[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out === "" ? p : `.${p}`;
  }
  return out;
}

function capIssues(issues: ValidationIssue[]): ValidationIssue[] {
  if (issues.length <= MAX_REPORTED_ISSUES) return issues;
  const omitted = issues.length - MAX_REPORTED_ISSUES;
  return [...issues.slice(0, MAX_REPORTED_ISSUES), { path: "", message: `${omitted} more issue(s) not shown` }];
}

/**
 * Iterative scan for non-finite numbers (JSON overflow such as 1e999 parses to Infinity) and for
 * nesting deeper than MAX_JSON_DEPTH. Paths are rebuilt only for reported problems.
 */
function scanParsed(root: unknown): ValidationIssue[] {
  interface Node {
    value: unknown;
    depth: number;
    parent: Node | null;
    key: string | number | null;
  }
  const pathOf = (n: Node): string => {
    const parts: (string | number)[] = [];
    for (let c: Node | null = n; c !== null && c.key !== null; c = c.parent) parts.push(c.key);
    return formatPath(parts.reverse());
  };
  const issues: ValidationIssue[] = [];
  const stack: Node[] = [{ value: root, depth: 0, parent: null, key: null }];
  while (stack.length > 0 && issues.length <= MAX_REPORTED_ISSUES) {
    const node = stack.pop() as Node;
    const v = node.value;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) issues.push({ path: pathOf(node), message: "non-finite number (for example a JSON overflow like 1e999)" });
      continue;
    }
    if (v === null || typeof v !== "object") continue;
    if (node.depth >= MAX_JSON_DEPTH) {
      issues.push({ path: pathOf(node), message: `nesting deeper than ${MAX_JSON_DEPTH} levels` });
      continue;
    }
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], depth: node.depth + 1, parent: node, key: i });
    } else {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) stack.push({ value: x, depth: node.depth + 1, parent: node, key: k });
    }
  }
  return issues;
}

/** Validate an already-parsed value (used by readRunFile; also usable on in-memory objects). */
export function parseRunFileValue(parsed: unknown): Result<RunFile> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("", "a run file is a JSON object");
  }
  const scan = scanParsed(parsed);
  if (scan.length > 0) return { ok: false, errors: capIssues(scan) };
  const version = (parsed as Record<string, unknown>)["schemaVersion"];
  if (version === undefined) return fail("schemaVersion", "missing schemaVersion");
  if (version !== RUN_SCHEMA_VERSION) {
    const shown = JSON.stringify(version) ?? String(version);
    return fail(
      "schemaVersion",
      `unsupported schemaVersion ${shown.slice(0, 40)}; this tool reads schemaVersion ${RUN_SCHEMA_VERSION}`,
    );
  }
  const r = RunFileSchema.safeParse(parsed);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: capIssues(r.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message }))) };
}

/** Import a run file from raw bytes. The 10,000,000-byte cap is checked before decoding or parsing. */
export function readRunFile(bytes: Uint8Array): Result<RunFile> {
  if (bytes.length > RUN_FILE_MAX_BYTES) {
    return fail("", `file is ${bytes.length} bytes; the limit is ${RUN_FILE_MAX_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("", "file is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message.slice(0, 200) : "parse error";
    return fail("", `file is not valid JSON: ${detail}`);
  }
  return parseRunFileValue(parsed);
}

/** Canonical on-disk form: 2-space JSON plus a trailing newline. */
export function serializeRunFile(run: RunFile): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

/** UTF-8 byte length of a string without TextEncoder (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else n += 3;
  }
  return n;
}

export type SizeCheck = { ok: true; bytes: number } | { ok: false; bytes: number; message: string };

/** Writers call this on the serialised text before every write; over the cap nothing may be written. */
export function checkRunFileSize(text: string): SizeCheck {
  const bytes = utf8ByteLength(text);
  if (bytes > RUN_FILE_MAX_BYTES) {
    return {
      ok: false,
      bytes,
      message: `run file would be ${bytes} bytes; the limit is ${RUN_FILE_MAX_BYTES} bytes. Nothing was written; pass fewer --models.`,
    };
  }
  return { ok: true, bytes };
}
