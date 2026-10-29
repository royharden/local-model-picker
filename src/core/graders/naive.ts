// Naive baseline graders, for the grader-agreement comparison in scripts/eval.ts only (never used to
// score a run). They read `raw` as stored, WITHOUT think-block removal, the way a quick regex scorer would:
//   numeric     -> the last number written with digits
//   choice      -> the first standalone capital letter A-D
//   extraction  -> substring: the expected value (or every expected JSON value) appears in the text
//   instruction -> substring/count checks on the whole raw text (keywords as substrings, JSON keys as `"key"`)
import type { Item } from "../schema/items.js";
import { compareKey } from "./normalize.js";
import { canonicalNumber, digitNumbers, expectedNumber, numbersEqual } from "./numeric.js";
import { wordCount } from "./ifcheck.js";

export interface NaiveGrade {
  extracted: string | null;
  correct: boolean;
}

export const NAIVE_GRADER_ID = "naive-v1";

export function naiveGrade(item: Item, raw: string): NaiveGrade {
  switch (item.kind) {
    case "numeric": {
      const nums = digitNumbers(raw);
      const last = nums[nums.length - 1];
      if (last === undefined) return { extracted: null, correct: false };
      const want = expectedNumber(item);
      return { extracted: canonicalNumber(last.value), correct: want !== null && numbersEqual(last.value, want) };
    }
    case "choice": {
      const m = /(?<![A-Za-z0-9])([A-D])(?![A-Za-z0-9])/.exec(raw);
      const letter = m?.[1] ?? null;
      return { extracted: letter, correct: letter === item.answer };
    }
    case "extraction": {
      const hay = compareKey(raw);
      const values = typeof item.answer === "string" ? [item.answer] : Object.values(item.answer);
      const all = values.length > 0 && values.every((v) => hay.includes(compareKey(v)));
      return { extracted: all && typeof item.answer === "string" ? item.answer : null, correct: all };
    }
    case "instruction": {
      const rule = item.rule;
      const lower = raw.toLowerCase();
      switch (rule.type) {
        case "max_words":
          return { extracted: String(wordCount(raw)), correct: wordCount(raw) <= rule.max };
        case "min_words":
          return { extracted: String(wordCount(raw)), correct: wordCount(raw) >= rule.min };
        case "include_keywords":
          return { extracted: null, correct: rule.keywords.every((k) => lower.includes(k.toLowerCase())) };
        case "exclude_keywords":
          return { extracted: null, correct: rule.keywords.every((k) => !lower.includes(k.toLowerCase())) };
        case "all_lowercase":
          return { extracted: null, correct: raw === raw.toLowerCase() };
        case "all_uppercase":
          return { extracted: null, correct: raw === raw.toUpperCase() };
        case "bullet_count":
          return { extracted: null, correct: (raw.match(/^[ \t]*[-*]/gm) ?? []).length === rule.count };
        case "starts_with":
          return { extracted: null, correct: lower.trim().startsWith(rule.text.toLowerCase()) };
        case "ends_with":
          return { extracted: null, correct: lower.trim().endsWith(rule.text.toLowerCase()) };
        case "json_keys":
          return { extracted: null, correct: rule.keys.every((k) => raw.includes(`"${k}"`)) };
      }
    }
  }
}
