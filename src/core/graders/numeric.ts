// Numeric grader (C5, fail-closed, no naive fallback). On the visible answer text:
//   1. explicit final-answer marker ("Answer:", "####", "the answer is"): its LAST occurrence wins when
//      the marker segment (rest of that sentence or line) holds exactly one distinct number;
//   2. otherwise a response containing exactly one distinct normalised number is accepted;
//   3. otherwise a bounded self-correction cue ("wait", "actually", "correction:") takes the first number
//      within SELF_CORRECTION_WINDOW characters after the LAST cue;
//   4. anything else with numbers is `ambiguous` -> incorrect. (The naive baseline takes the last number.)
// This rule was fixed on the dev fixtures before the single held-out run and is not tuned afterwards.
//
// Bounded number grammar (documented in docs/METHOD.md):
//   digits with optional sign, currency ($ € £), thousands commas, decimals, scientific notation (1.2e3),
//   simple fractions a/b (b > 0), and English number words zero..one thousand
//   ("eighteen", "twenty-six", "five hundred forty", "four hundred and sixty", "one thousand").
//   Not covered: "point" decimals, ordinals, words above one thousand (a word phrase directly followed
//   by "hundred"/"thousand"/"million"/... that cannot be read is skipped, never guessed).
import type { Item } from "../schema/items.js";

type NumericItem = Extract<Item, { kind: "numeric" }>;

export interface NumberToken {
  value: number;
  /** start offset in the scanned text */
  index: number;
  /** end offset (exclusive) */
  end: number;
}

const DIGIT_NUMBER =
  /(?<![\w.])([-−]?)([$€£]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?(?:[ \t]*\/[ \t]*(\d+)(?!\d|\.\d))?/g;

/** Numbers written with digits, in text order. */
export function digitNumbers(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(DIGIT_NUMBER)) {
    const sign = m[1] ?? "";
    const int = (m[3] ?? "").replace(/,/g, "");
    let value = Number(int + (m[4] ?? "") + (m[5] ?? ""));
    const den = m[6];
    if (den !== undefined) {
      const d = Number(den);
      if (d === 0) continue;
      value = value / d;
    }
    if (sign !== "") value = -value;
    if (!Number.isFinite(value)) continue;
    const index = m.index ?? 0;
    out.push({ value, index, end: index + m[0].length });
  }
  return out;
}

const SMALL = new Map<string, number>([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7],
  ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14],
  ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19],
]);
const TENS = new Map<string, number>([
  ["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90],
]);
const SCALE_WORDS = new Set(["hundred", "thousand", "million", "billion", "trillion"]);

interface WordTok {
  w: string;
  index: number;
  end: number;
}

const unit = (w: string | undefined): number | undefined => {
  if (w === undefined) return undefined;
  const v = SMALL.get(w);
  return v !== undefined && v >= 1 && v <= 9 ? v : undefined;
};

/** Numbers written as English words zero..one thousand, in text order. */
export function wordNumbers(text: string): NumberToken[] {
  const toks: WordTok[] = [];
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    const index = m.index ?? 0;
    toks.push({ w: m[0].toLowerCase(), index, end: index + m[0].length });
  }
  const adjacent = (a: WordTok, b: WordTok): boolean => /^[ \t-]+$/.test(text.slice(a.end, b.index));
  const out: NumberToken[] = [];
  let i = 0;
  while (i < toks.length) {
    const start = i;
    // word(j): the j-th token if it continues the phrase that starts at `start`
    const word = (j: number): string | undefined => {
      const t = toks[j];
      if (t === undefined) return undefined;
      if (j > start) {
        const prev = toks[j - 1];
        if (prev === undefined || !adjacent(prev, t)) return undefined;
      }
      return t.w;
    };
    let j = start;
    let value = 0;
    let any = false;
    if (word(j) === "one" && word(j + 1) === "thousand") {
      value = 1000;
      j += 2;
      any = true;
    } else {
      const h = unit(word(j));
      if (h !== undefined && word(j + 1) === "hundred") {
        value = h * 100;
        j += 2;
        any = true;
        const after = word(j + 1);
        if (word(j) === "and" && after !== undefined && (TENS.has(after) || (SMALL.get(after) ?? 0) > 0)) j += 1;
      }
      const w = word(j);
      const tens = w === undefined ? undefined : TENS.get(w);
      const small = w === undefined ? undefined : SMALL.get(w);
      if (tens !== undefined) {
        value += tens;
        j += 1;
        any = true;
        const u = unit(word(j));
        if (u !== undefined) {
          value += u;
          j += 1;
        }
      } else if (small !== undefined && !(any && small === 0)) {
        value += small;
        j += 1;
        any = true;
      }
    }
    if (!any) {
      i += 1;
      continue;
    }
    const next = word(j);
    if (next !== undefined && SCALE_WORDS.has(next)) {
      // e.g. "two hundred thousand": outside the bounded grammar; skip the phrase, never guess.
      i = j + 1;
      continue;
    }
    const first = toks[start];
    const last = toks[j - 1];
    if (first !== undefined && last !== undefined) out.push({ value, index: first.index, end: last.end });
    i = j;
  }
  return out;
}

/** Every number in the text (digits and words), in text order. */
export function parseNumbers(text: string): NumberToken[] {
  return [...digitNumbers(text), ...wordNumbers(text)].sort((a, b) => a.index - b.index);
}

/** Canonical string of a number: integers exactly, others to 12 significant digits. */
export function canonicalNumber(n: number): string {
  if (Object.is(n, -0)) return "0";
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

function distinct(tokens: readonly NumberToken[]): NumberToken[] {
  const seen = new Map<string, NumberToken>();
  for (const t of tokens) {
    const k = canonicalNumber(t.value);
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

export function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
}

const NUMERIC_MARKER = /####|\banswer\s*[:：]|\bthe\s+(?:final\s+)?answer\s+is\b\s*[:：]?|\bfinal\s+answer\s+is\b\s*[:：]?/gi;
const CUE = /\b(?:wait|actually)\b|\bcorrection\s*:/gi;
export const SELF_CORRECTION_WINDOW = 60;

/** The marker segment: after the marker, skipping blank space and emphasis, up to the end of that sentence or line. */
export function markerSegment(text: string, end: number): string {
  const rest = text.slice(end).replace(/^[\s*_]+/, "");
  const stop = rest.search(/\n|[.!?;](?=\s|$)/);
  return stop >= 0 ? rest.slice(0, stop) : rest;
}

export type NumericRule = "marker" | "single" | "self-correction" | "ambiguous" | "none";

export interface NumericExtraction {
  value: number | null;
  rule: NumericRule;
}

/** Steps 1-4 above on visible answer text. */
export function extractNumeric(text: string): NumericExtraction {
  let lastMarkerEnd = -1;
  for (const m of text.matchAll(NUMERIC_MARKER)) lastMarkerEnd = (m.index ?? 0) + m[0].length;
  if (lastMarkerEnd >= 0) {
    const seg = markerSegment(text, lastMarkerEnd);
    if (!/^not\b/i.test(seg)) {
      const nums = distinct(parseNumbers(seg));
      const only = nums[0];
      if (nums.length === 1 && only !== undefined) return { value: only.value, rule: "marker" };
    }
  }
  const all = parseNumbers(text);
  const uniq = distinct(all);
  const single = uniq[0];
  if (uniq.length === 1 && single !== undefined) return { value: single.value, rule: "single" };
  let lastCueEnd = -1;
  for (const m of text.matchAll(CUE)) lastCueEnd = (m.index ?? 0) + m[0].length;
  if (lastCueEnd >= 0) {
    const after = all.find((t) => t.index >= lastCueEnd && t.index < lastCueEnd + SELF_CORRECTION_WINDOW);
    if (after !== undefined) return { value: after.value, rule: "self-correction" };
  }
  return { value: null, rule: uniq.length === 0 ? "none" : "ambiguous" };
}

/** The item's expected value: its answer must read as exactly one number. */
export function expectedNumber(item: NumericItem): number | null {
  const nums = distinct(parseNumbers(item.answer));
  const only = nums[0];
  return nums.length === 1 && only !== undefined ? only.value : null;
}

export interface SubGrade {
  extracted: string | null;
  correct: boolean;
  ambiguous: boolean;
}

export function gradeNumeric(item: NumericItem, text: string): SubGrade {
  const got = extractNumeric(text);
  const expected = expectedNumber(item);
  if (got.value === null) return { extracted: null, correct: false, ambiguous: got.rule === "ambiguous" };
  return {
    extracted: canonicalNumber(got.value),
    correct: expected !== null && numbersEqual(got.value, expected),
    ambiguous: false,
  };
}
