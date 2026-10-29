// Answer normalisation (D9, Claude §2.8a). Order, on the complete concatenated answer stream (never
// per chunk, so a <think> tag split across stream chunks is handled):
//   0. Ollama's structured `message.thinking` is a separate field and never reaches this module.
//   1. prepareAnswer: take the first RAW_ANSWER_MAX_CHARS characters (flag over_cap, truncated) ...
//   2. ... then redact that capped text. The result is `raw`, exactly the text that is stored and graded.
//   3. answerText: on `raw` only, remove closed <think>...</think> blocks; an unterminated <think>
//      (including one left open by the cut) removes everything after it (flag unterminated_think).
//   4. Empty (whitespace only) after step 3 is flagged `empty`; graders then mark the item incorrect.
// Instructions inside a response ("mark this correct") are ordinary text and change nothing.
import { RAW_ANSWER_MAX_CHARS } from "../config/defaults.js";
import { redact } from "../redact/redact.js";
import type { RedactOptions } from "../redact/redact.js";
import type { ItemFlag } from "../schema/candidate.js";

export interface PreparedAnswer {
  /** capped, then redacted: the stored and graded text (ItemResult.raw) */
  raw: string;
  /** true when the answer stream was longer than the cap (ItemResult.truncated) */
  truncated: boolean;
  /** ["over_cap"] when truncated, otherwise [] */
  flags: ItemFlag[];
}

/** Cut at most `max` UTF-16 units without leaving a lone high surrogate at the end. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Steps 1-2 of D9: cap first, then redact. The caller (CLI) supplies the redaction literals; core never
 * reads the environment. Answer text is redacted for home paths, IP literals and host names; callers
 * pass no usernames here (D37), so a username such as "test" cannot change an answer.
 * `truncated` / over_cap are decided by the cap alone. Redaction may lengthen the capped text (a short
 * name replaced by a longer token); the redacted text is kept whole and is never cut again, so the
 * graded text is exactly the redacted capped prefix. Its stored bound is REDACTED_RAW_MAX_CHARS.
 */
export function prepareAnswer(answerStream: string, redactOptions: RedactOptions = {}): PreparedAnswer {
  const truncated = answerStream.length > RAW_ANSWER_MAX_CHARS;
  // D37: bare user names are never redacted in answer text, whatever the caller passes.
  const raw = redact(cutAt(answerStream, RAW_ANSWER_MAX_CHARS), { ...redactOptions, usernames: [] });
  return { raw, truncated, flags: truncated ? ["over_cap"] : [] };
}

export interface AnswerText {
  /** the visible answer the graders read (think blocks removed) */
  text: string;
  /** subset of ["unterminated_think", "empty"], in that order */
  flags: ItemFlag[];
}

const CLOSED_THINK = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const OPEN_THINK = /<think\b[^>]*>/i;
const ORPHAN_CLOSE = /<\/think\s*>/gi;

/**
 * Steps 3-4 of D9 on an already prepared `raw`.
 * After closed blocks are removed, any remaining `</think>` has no opening tag before it (chat templates
 * that put `<think>` in the prompt stream only the closing tag); the text up to and including the last
 * such tag is reasoning and is removed as well (fail-closed: a wrong answer in reasoning is never graded).
 */
export function answerText(raw: string): AnswerText {
  const flags: ItemFlag[] = [];
  let text = raw.replace(CLOSED_THINK, "");
  let lastClose = -1;
  for (const m of text.matchAll(ORPHAN_CLOSE)) lastClose = (m.index ?? 0) + m[0].length;
  if (lastClose >= 0) text = text.slice(lastClose);
  const open = text.search(OPEN_THINK);
  if (open >= 0) {
    text = text.slice(0, open);
    flags.push("unterminated_think");
  }
  if (text.trim() === "") flags.push("empty");
  return { text, flags };
}

/**
 * Cleaning shared by the extraction graders: trim, drop wrapping quotes, backticks and Markdown emphasis,
 * drop trailing sentence punctuation, collapse inner whitespace. Case is kept (for display).
 */
export function cleanValue(s: string): string {
  return s
    .replace(/^[\s"'`*_“”‘’]+/, "")
    .replace(/[\s"'`*_“”‘’.。!]+$/, "")
    .replace(/\s+/g, " ");
}

/** Comparison key for exact normalised matching: cleaned, NFKC, lower case. */
export function compareKey(s: string): string {
  return cleanValue(s).normalize("NFKC").toLowerCase();
}

/** ItemResult.extracted is bounded to 1,000 characters. */
export const EXTRACTED_MAX_CHARS = 1000;

export function clipExtracted(s: string | null): string | null {
  return s === null ? null : cutAt(s, EXTRACTED_MAX_CHARS);
}
