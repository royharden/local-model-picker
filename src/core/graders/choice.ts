// Multiple-choice grader (fail-closed). On the visible answer text, letters are upper-case A-D only.
//   1. Marker letters: "Answer: B", "The answer is (C)", "**Answer:** D". If any marker letter exists,
//      only marker letters count: one distinct letter -> that letter; two different -> ambiguous.
//   2. Otherwise asserted letters from "(B)", "B." / "B)" at line start, or a response that is a lone letter;
//      a letter preceded by a negation ("not (B)", "isn't (C)", "never (A)") is excluded.
//      One distinct letter -> that letter; two different -> ambiguous; none -> no answer.
// "The answer is not B" asserts nothing (the marker needs the letter right after it).
import type { Item } from "../schema/items.js";
import type { SubGrade } from "./numeric.js";

type ChoiceItem = Extract<Item, { kind: "choice" }>;
export type ChoiceLetter = "A" | "B" | "C" | "D";

const MARKER = /\b(?:[Aa]nswer|ANSWER)(?:\s+(?:is|IS))?\s*[:：]?\s*\**\s*\(?([A-D])\)?(?![A-Za-z0-9])/g;
const PAREN = /\(([A-D])\)/g;
const LINE_START = /^[ \t*]*([A-D])[.)](?=\s|$)/gm;
const LONE = /^\s*\(?([A-D])\)?\.?\s*$/;
const NEGATION = /(?:\bnot|n['’]t|\bnever|\bisnt)\s+(?:option\s+|choice\s+)?$/i;

function isLetter(s: string | undefined): s is ChoiceLetter {
  return s === "A" || s === "B" || s === "C" || s === "D";
}

function negated(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return NEGATION.test(text.slice(Math.max(lineStart, index - 30), index));
}

export interface ChoiceExtraction {
  letter: ChoiceLetter | null;
  ambiguous: boolean;
}

export function extractChoice(text: string): ChoiceExtraction {
  const decide = (letters: Set<ChoiceLetter>): ChoiceExtraction => {
    if (letters.size === 1) {
      const [only] = [...letters];
      return { letter: only ?? null, ambiguous: false };
    }
    return { letter: null, ambiguous: letters.size > 1 };
  };

  const marked = new Set<ChoiceLetter>();
  for (const m of text.matchAll(MARKER)) if (isLetter(m[1])) marked.add(m[1]);
  if (marked.size > 0) return decide(marked);

  const asserted = new Set<ChoiceLetter>();
  for (const m of text.matchAll(PAREN)) {
    if (isLetter(m[1]) && !negated(text, m.index ?? 0)) asserted.add(m[1]);
  }
  for (const m of text.matchAll(LINE_START)) {
    if (isLetter(m[1]) && !negated(text, m.index ?? 0)) asserted.add(m[1]);
  }
  const lone = LONE.exec(text);
  if (lone !== null && isLetter(lone[1])) asserted.add(lone[1]);
  return decide(asserted);
}

export function gradeChoice(item: ChoiceItem, text: string): SubGrade {
  const got = extractChoice(text);
  return { extracted: got.letter, correct: got.letter !== null && got.letter === item.answer, ambiguous: got.ambiguous };
}
