// sanitizeForTerminal: strip terminal control characters from untrusted text (model tags,
// responses, error strings) before printing in the CLI or writing the Markdown report.
// Removes C0 controls except \n and \t, DEL, C1 controls (U+0080..U+009F), whole ESC / CSI / OSC /
// DCS-style sequences, and the Unicode bidirectional override/isolate characters.
// Written as a character scanner rather than a control-character regex (eslint no-control-regex).

const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_ST = 0x9c;

/** U+202A..U+202E and U+2066..U+2069 (bidi embedding/override/isolate). */
function isBidiControl(c: number): boolean {
  return (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

function isDroppedControl(c: number): boolean {
  if (c === 0x0a || c === 0x09) return false;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** Index after a CSI body starting at i (parameters 0x30-0x3f, intermediates 0x20-0x2f, one final 0x40-0x7e). */
function skipCsi(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c >= 0x20 && c <= 0x3f) {
      j++; // parameter or intermediate byte
    } else if (c >= 0x40 && c <= 0x7e) {
      return j + 1; // final byte ends the sequence
    } else {
      return j; // malformed: stop here; the caller examines this character normally
    }
  }
  return j;
}

/** Index after a string sequence (OSC/DCS/SOS/PM/APC) ended by BEL, ESC \ or C1 ST; unterminated runs to the end. */
function skipString(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === BEL || c === C1_ST) return j + 1;
    if (c === ESC && s.charCodeAt(j + 1) === 0x5c) return j + 2;
    j++;
  }
  return j;
}

export function sanitizeForTerminal(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    if (c === ESC) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b /* [ */) {
        i = skipCsi(input, i + 2);
      } else if (next === 0x5d /* ] */ || next === 0x50 /* P */ || next === 0x58 /* X */ || next === 0x5e /* ^ */ || next === 0x5f /* _ */) {
        i = skipString(input, i + 2);
      } else {
        // two-character escape: ESC, optional intermediates 0x20-0x2f, one final byte 0x30-0x7e
        let j = i + 1;
        while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
        const f = input.charCodeAt(j);
        if (f >= 0x30 && f <= 0x7e) j++;
        i = j;
      }
      continue;
    }
    if (c === C1_CSI) {
      i = skipCsi(input, i + 1);
      continue;
    }
    if (c === C1_OSC || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
      i = skipString(input, i + 1);
      continue;
    }
    if (!isDroppedControl(c)) out += input.charAt(i);
    i++;
  }
  return out;
}
