// Claude §2.6 step 11: the `ollama run <tag>` line is shown only for tags matching a conservative
// grammar (length <= 200). Anything else (scenario s09, injected tag text) gets no command and a
// fixed explanation; the tag stays plain data. The text is never executed by anything.

/**
 * Claude's grammar `^[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._\-]+)?$`, written with "-" last in each
 * class instead of escaped (identical set; avoids eslint no-useless-escape). First char alphanumeric;
 * then letters, digits, . _ / -; optional ":" plus letters, digits, . _ -. JS `$` does not match
 * before a trailing newline, so "tag\n" is refused.
 */
export const SAFE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/;
export const SAFE_TAG_MAX_LENGTH = 200;
export const UNSAFE_TAG_REASON = "tag contains characters that are not shown as a command";

export function isSafeTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= SAFE_TAG_MAX_LENGTH && SAFE_TAG_PATTERN.test(tag);
}

export interface SafeCommand {
  command: string | null;
  reason: string | null;
}

/** `ollama run <tag>` for a safe tag; otherwise null with UNSAFE_TAG_REASON. */
export function safeRunCommand(tag: string): SafeCommand {
  return isSafeTag(tag) ? { command: `ollama run ${tag}`, reason: null } : { command: null, reason: UNSAFE_TAG_REASON };
}
