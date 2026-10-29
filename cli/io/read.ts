// Run-file reader for the CLI: the file size is checked against the 10,000,000-byte cap from stat()
// BEFORE the file is read, then the bytes go through the shared core reader readRunFile (UTF-8, JSON,
// schemaVersion, zod). Also loads the bundled item bank and speed prompts (data/*.v1.json).
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ItemBank, PromptSet, Result, RunFile } from "../../src/core/index.js";
import { ItemBankSchema, PromptSetSchema, readRunFile, RUN_FILE_MAX_BYTES } from "../../src/core/index.js";

export async function readRunFileFromPath(file: string): Promise<Result<RunFile>> {
  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) return { ok: false, errors: [{ path: "", message: "not a regular file" }] };
    size = s.size;
  } catch {
    return { ok: false, errors: [{ path: "", message: "file not found or not readable" }] };
  }
  if (size > RUN_FILE_MAX_BYTES) {
    return { ok: false, errors: [{ path: "", message: `file is ${size} bytes; the limit is ${RUN_FILE_MAX_BYTES} bytes` }] };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch {
    return { ok: false, errors: [{ path: "", message: "file could not be read" }] };
  }
  return readRunFile(bytes);
}

/**
 * Locate a file under data/ next to the package root: works from cli/ under tsx (../data) and from
 * dist-cli/cli/ after build:cli (../../data).
 */
export function resolveDataFile(name: string, override?: string): string {
  if (override !== undefined) return path.join(override, name);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "..", "..", "data", name), path.resolve(here, "..", "..", "..", "data", name)];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0] as string;
}

export interface BundledData {
  bank: ItemBank;
  prompts: PromptSet;
}

async function loadJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

/** Load and validate data/items.v1.json and data/prompts.v1.json. Throws with a readable message. */
export async function loadBundledData(dataDir?: string): Promise<BundledData> {
  const bank = ItemBankSchema.safeParse(await loadJson(resolveDataFile("items.v1.json", dataDir)));
  if (!bank.success) throw new Error(`data/items.v1.json is invalid: ${bank.error.issues[0]?.message ?? "schema error"}`);
  const prompts = PromptSetSchema.safeParse(await loadJson(resolveDataFile("prompts.v1.json", dataDir)));
  if (!prompts.success) throw new Error(`data/prompts.v1.json is invalid: ${prompts.error.issues[0]?.message ?? "schema error"}`);
  return { bank: bank.data, prompts: prompts.data };
}
