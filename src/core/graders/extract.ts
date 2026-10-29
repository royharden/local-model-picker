// Extraction grader: exact normalised match.
// text items: the value after the LAST "Answer:" / "the answer is" marker (rest of that line); with no
//   marker, a single-line response is the value; a multi-line response without a marker is ambiguous.
//   Compared by compareKey (trim, wrapping quotes/emphasis and trailing period dropped, whitespace
//   collapsed, NFKC, lower case). `extracted` is the cleaned value with its case kept.
// json items: parsed strictly or non-strictly per the item's `strict`; the object must have exactly the
//   expected keys, and each value must be a string, number or boolean whose compareKey equals the
//   expected value's. `extracted` is the parsed object as compact JSON.
import type { Item } from "../schema/items.js";
import { cleanValue, clipExtracted, compareKey } from "./normalize.js";
import { isPlainObject, parseJsonResponse } from "./ifcheck.js";
import type { SubGrade } from "./numeric.js";

type ExtractionItem = Extract<Item, { kind: "extraction" }>;

const TEXT_MARKER = /\b(?:final\s+)?answer\s*[:：]|\bthe\s+answer\s+is\b\s*[:：]?/gi;

export interface TextExtraction {
  value: string | null;
  ambiguous: boolean;
}

export function extractText(text: string): TextExtraction {
  let lastEnd = -1;
  for (const m of text.matchAll(TEXT_MARKER)) lastEnd = (m.index ?? 0) + m[0].length;
  let candidate: string;
  if (lastEnd >= 0) {
    const rest = text.slice(lastEnd).replace(/^\s+/, "");
    const nl = rest.indexOf("\n");
    candidate = nl >= 0 ? rest.slice(0, nl) : rest;
  } else {
    const t = text.trim();
    if (t.includes("\n")) return { value: null, ambiguous: true };
    candidate = t;
  }
  const value = cleanValue(candidate);
  return { value: value === "" ? null : value, ambiguous: false };
}

function scalarKey(v: unknown): string | null {
  if (typeof v === "string") return compareKey(v);
  if (typeof v === "number" && Number.isFinite(v)) return compareKey(String(v));
  if (typeof v === "boolean") return String(v);
  return null;
}

export function gradeExtraction(item: ExtractionItem, text: string): SubGrade {
  const expected = item.answer;
  if (item.format === "text" || typeof expected === "string") {
    const got = extractText(text);
    const want = typeof expected === "string" ? compareKey(expected) : null;
    return {
      extracted: clipExtracted(got.value),
      correct: got.value !== null && want !== null && compareKey(got.value) === want,
      ambiguous: got.ambiguous,
    };
  }
  const parsed = parseJsonResponse(text, item.strict ?? false);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { extracted: null, correct: false, ambiguous: false };
  const obj = parsed.value;
  const wantKeys = Object.keys(expected);
  const gotKeys = Object.keys(obj);
  const sameKeys = gotKeys.length === wantKeys.length && wantKeys.every((k) => Object.hasOwn(obj, k));
  const valuesMatch = sameKeys && wantKeys.every((k) => scalarKey(obj[k]) === compareKey(expected[k] ?? ""));
  return { extracted: clipExtracted(JSON.stringify(obj)), correct: sameKeys && valuesMatch, ambiguous: false };
}
