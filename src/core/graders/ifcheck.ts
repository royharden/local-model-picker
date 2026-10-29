// Instruction-following checks (IFEval-style originals; IFEval credited as methodology inspiration only).
// Each rule is a parameterised, verifiable check on the visible answer text. `extracted` records what
// was measured, for the audit page:
//   max_words / min_words / bullet_count -> the count as a string
//   include_keywords / exclude_keywords  -> the rule's keywords found, in rule order, joined ", " (null if none)
//   json_keys                            -> the parsed object as compact JSON (null if no object parsed)
//   all_lowercase / all_uppercase / starts_with / ends_with -> null
// JSON per item (`strict` in items.v1.json): strict requires the whole response, after one optional code
// fence, to parse; non-strict accepts the first balanced {...} object even with text around it.
import type { InstructionRule, Item } from "../schema/items.js";
import { clipExtracted } from "./normalize.js";
import type { SubGrade } from "./numeric.js";

type InstructionItem = Extract<Item, { kind: "instruction" }>;

export function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** Whole-word, case-insensitive keyword match. */
export function hasKeyword(text: string, keyword: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(keyword)}(?![A-Za-z0-9])`, "i").test(text);
}

const FENCE = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/;

/** End index of the balanced {...} object starting at `start`, or -1 (string-aware). */
function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Bound on how many "{" positions the non-strict parser tries. */
export const JSON_MAX_ATTEMPTS = 50;

export type JsonParse = { ok: true; value: unknown } | { ok: false };

/** Parse a JSON response, strictly or non-strictly (see header). Never throws. */
export function parseJsonResponse(text: string, strict: boolean): JsonParse {
  if (strict) {
    const t = text.trim();
    const fenced = FENCE.exec(t);
    const body = fenced !== null ? (fenced[1] ?? "") : t;
    try {
      return { ok: true, value: JSON.parse(body) as unknown };
    } catch {
      return { ok: false };
    }
  }
  let from = 0;
  for (let attempt = 0; attempt < JSON_MAX_ATTEMPTS; attempt++) {
    const start = text.indexOf("{", from);
    if (start < 0) break;
    const end = balancedEnd(text, start);
    if (end < 0) break;
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) as unknown };
    } catch {
      from = start + 1;
    }
  }
  return { ok: false };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const BULLET = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+\S/gm;

export function checkInstruction(rule: InstructionRule, text: string): { extracted: string | null; correct: boolean } {
  switch (rule.type) {
    case "max_words": {
      const n = wordCount(text);
      return { extracted: String(n), correct: n <= rule.max };
    }
    case "min_words": {
      const n = wordCount(text);
      return { extracted: String(n), correct: n >= rule.min };
    }
    case "include_keywords": {
      const found = rule.keywords.filter((k) => hasKeyword(text, k));
      return { extracted: found.length > 0 ? found.join(", ") : null, correct: found.length === rule.keywords.length };
    }
    case "exclude_keywords": {
      const found = rule.keywords.filter((k) => hasKeyword(text, k));
      return { extracted: found.length > 0 ? found.join(", ") : null, correct: found.length === 0 };
    }
    case "all_lowercase": {
      const hasLetters = text.toLowerCase() !== text.toUpperCase();
      return { extracted: null, correct: hasLetters && text === text.toLowerCase() };
    }
    case "all_uppercase": {
      const hasLetters = text.toLowerCase() !== text.toUpperCase();
      return { extracted: null, correct: hasLetters && text === text.toUpperCase() };
    }
    case "bullet_count": {
      const n = [...text.matchAll(BULLET)].length;
      return { extracted: String(n), correct: n === rule.count };
    }
    case "starts_with":
      return { extracted: null, correct: text.trim().toLowerCase().startsWith(rule.text.toLowerCase()) };
    case "ends_with":
      return { extracted: null, correct: text.trim().toLowerCase().endsWith(rule.text.toLowerCase()) };
    case "json_keys": {
      const parsed = parseJsonResponse(text, rule.strict);
      if (!parsed.ok || !isPlainObject(parsed.value)) return { extracted: null, correct: false };
      const obj = parsed.value;
      return {
        extracted: clipExtracted(JSON.stringify(obj)),
        correct: rule.keys.every((k) => Object.hasOwn(obj, k)),
      };
    }
  }
}

export function gradeInstruction(item: InstructionItem, text: string): SubGrade {
  const r = checkInstruction(item.rule, text);
  return { extracted: r.extracted, correct: r.correct, ambiguous: false };
}
