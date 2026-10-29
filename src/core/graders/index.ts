// Graders: one entry point per item kind, the normalisation order of D9, and the grader version.
// Pure: no I/O, no clock. The CLI captures the answer stream (structured thinking excluded), calls
// prepareAnswer(stream, redactOptions) and then gradeItem(item, raw, truncated); gradeAnswer does both.
import type { RedactOptions } from "../redact/redact.js";
import type { ItemFlag, ItemResult } from "../schema/candidate.js";
import { ITEM_FLAGS } from "../schema/candidate.js";
import type { GraderFixture, Item } from "../schema/items.js";
import { REDACTED_RAW_MAX_CHARS } from "../config/defaults.js";
import { answerText, prepareAnswer } from "./normalize.js";
import { gradeNumeric } from "./numeric.js";
import type { SubGrade } from "./numeric.js";
import { gradeChoice } from "./choice.js";
import { gradeInstruction } from "./ifcheck.js";
import { gradeExtraction } from "./extract.js";

export * from "./normalize.js";
export * from "./numeric.js";
export * from "./choice.js";
export * from "./ifcheck.js";
export * from "./extract.js";
export * from "./naive.js";

/**
 * Bump on ANY change to grading behaviour (normalisation, number grammar, markers, letter patterns,
 * JSON parsing, comparison keys). It is recorded per run and per item result and is part of the
 * comparison-group key (D16), so runs graded differently are never compared.
 */
export const GRADER_VERSION = "graders-v1";

export const GRADER_IDS = {
  numeric: "numeric-v1",
  choice: "choice-v1",
  instruction: "ifcheck-v1",
  extraction: "extract-v1",
} as const;

function subGrade(item: Item, text: string): SubGrade {
  switch (item.kind) {
    case "numeric":
      return gradeNumeric(item, text);
    case "choice":
      return gradeChoice(item, text);
    case "instruction":
      return gradeInstruction(item, text);
    case "extraction":
      return gradeExtraction(item, text);
  }
}

function orderedFlags(flags: Iterable<ItemFlag>): ItemFlag[] {
  const set = new Set(flags);
  return ITEM_FLAGS.filter((f) => set.has(f));
}

/**
 * Grade one prepared answer. `raw` must already be capped, then redacted (prepareAnswer); `truncated`
 * says whether the stream was cut. Returns every ItemResult field. Empty text is always incorrect.
 */
export function gradeItem(item: Item, raw: string, truncated = false): ItemResult {
  if (raw.length > REDACTED_RAW_MAX_CHARS) {
    throw new RangeError(`raw is ${raw.length} chars; the stored bound after cap + redaction is ${REDACTED_RAW_MAX_CHARS}`);
  }
  const visible = answerText(raw);
  const flags: ItemFlag[] = [...visible.flags];
  if (truncated) flags.push("over_cap");
  let extracted: string | null = null;
  let correct = false;
  if (!visible.flags.includes("empty")) {
    const g = subGrade(item, visible.text);
    extracted = g.extracted;
    correct = g.correct;
    if (g.ambiguous) flags.push("ambiguous");
  }
  return {
    itemId: item.id,
    raw,
    truncated,
    flags: orderedFlags(flags),
    extracted,
    correct,
    graderId: GRADER_IDS[item.kind],
    graderVersion: GRADER_VERSION,
  };
}

/** prepareAnswer + gradeItem: from the captured answer stream to an ItemResult. */
export function gradeAnswer(item: Item, answerStream: string, redactOptions: RedactOptions = {}): ItemResult {
  const prepared = prepareAnswer(answerStream, redactOptions);
  return gradeItem(item, prepared.raw, prepared.truncated);
}

/**
 * Consistency of the dev / held-out grader fixtures (used by scripts/eval.ts, which alone loads the
 * held-out file; unit-tested on synthetic inputs). Returns a list of problems; empty means consistent.
 */
export function checkGraderSplit(
  dev: GraderFixture,
  heldout: GraderFixture,
  itemIds: readonly string[],
  expectedSizes: { dev: number; heldout: number } = { dev: 40, heldout: 40 },
): string[] {
  const issues: string[] = [];
  if (dev.split !== "dev") issues.push(`dev file declares split ${dev.split}`);
  if (heldout.split !== "heldout") issues.push(`held-out file declares split ${heldout.split}`);
  if (dev.seed !== heldout.seed) issues.push("dev and held-out record different seeds");
  if (dev.frozenAt !== heldout.frozenAt) issues.push("dev and held-out record different freeze dates");
  if (dev.cases.length !== expectedSizes.dev) issues.push(`dev has ${dev.cases.length} cases, expected ${expectedSizes.dev}`);
  if (heldout.cases.length !== expectedSizes.heldout) {
    issues.push(`held-out has ${heldout.cases.length} cases, expected ${expectedSizes.heldout}`);
  }
  const devIds = new Set(dev.cases.map((c) => c.id));
  for (const c of heldout.cases) if (devIds.has(c.id)) issues.push(`case ${c.id} is in both files`);
  const known = new Set(itemIds);
  for (const c of [...dev.cases, ...heldout.cases]) {
    if (!known.has(c.itemId)) issues.push(`case ${c.id} names unknown item ${c.itemId}`);
  }
  return issues;
}
