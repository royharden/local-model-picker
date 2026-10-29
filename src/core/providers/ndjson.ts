// NDJSON line splitter with byte caps (D10). Pure: no I/O, no clock, no Node types.
// Works on raw bytes so the line cap (protocol.caps.ndjsonLineBytes) and the stream cap
// (protocol.caps.streamBytes) are exact byte counts, and a line split across network reads
// (including inside a multi-byte UTF-8 character) is buffered until its newline arrives.
// Splitting on byte 0x0A is safe in UTF-8: no multi-byte sequence contains 0x0A.
import type { ProviderErrorCode } from "./types.js";

/**
 * Minimal local declaration of the WHATWG TextDecoder (see io/readrunfile.ts for why it is
 * declared here: tsconfig.core.json has no DOM or Node types; every target runtime provides it).
 */
declare const TextDecoder: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): { decode(input: Uint8Array): string };
};

export interface NdjsonLimits {
  /** maximum bytes of one line, newline excluded */
  lineBytes: number;
  /** maximum bytes of the whole response body */
  streamBytes: number;
}

export type NdjsonFailureCode = Extract<ProviderErrorCode, "oversize_line" | "oversize_stream" | "malformed">;

export interface NdjsonFailure {
  code: NdjsonFailureCode;
  message: string;
}

/** Complete, non-blank lines decoded from one push (or from end), plus the first failure if any. */
export interface SplitStep {
  lines: string[];
  failure: NdjsonFailure | null;
}

export interface LineSplitter {
  /** Feed the next chunk of body bytes. After a failure every later call returns that failure and no lines. */
  push(chunk: Uint8Array): SplitStep;
  /** The body ended: a final line without a trailing newline is returned here. */
  end(): SplitStep;
  /** bytes received so far */
  totalBytes(): number;
}

export function createLineSplitter(limits: NdjsonLimits): LineSplitter {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  let failure: NdjsonFailure | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const failWith = (lines: string[], f: NdjsonFailure): SplitStep => {
    failure = f;
    pending = [];
    pendingBytes = 0;
    return { lines, failure: f };
  };

  const oversizeLine = (): NdjsonFailure => ({
    code: "oversize_line",
    message: `an NDJSON line exceeded ${limits.lineBytes} bytes`,
  });

  /** Join pending pieces plus `last`, drop one trailing CR, decode strictly; null on invalid UTF-8. */
  const decodeLine = (last: Uint8Array): string | null => {
    const length = pendingBytes + last.length;
    const buf = new Uint8Array(length);
    let offset = 0;
    for (const p of pending) {
      buf.set(p, offset);
      offset += p.length;
    }
    buf.set(last, offset);
    let end = length;
    if (end > 0 && buf[end - 1] === 0x0d) end -= 1;
    try {
      return decoder.decode(buf.subarray(0, end));
    } catch {
      return null;
    }
  };

  const takeLine = (lines: string[], last: Uint8Array): NdjsonFailure | null => {
    if (pendingBytes + last.length > limits.lineBytes) return oversizeLine();
    const text = decodeLine(last);
    pending = [];
    pendingBytes = 0;
    if (text === null) return { code: "malformed", message: "an NDJSON line is not valid UTF-8" };
    if (text.trim() !== "") lines.push(text);
    return null;
  };

  return {
    push(chunk: Uint8Array): SplitStep {
      if (failure !== null) return { lines: [], failure };
      const lines: string[] = [];
      total += chunk.length;
      if (total > limits.streamBytes) {
        return failWith(lines, { code: "oversize_stream", message: `the response exceeded ${limits.streamBytes} bytes` });
      }
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) break;
        const f = takeLine(lines, chunk.subarray(start, nl));
        if (f !== null) return failWith(lines, f);
        start = nl + 1;
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        if (pendingBytes + rest.length > limits.lineBytes) return failWith(lines, oversizeLine());
        // copy: a stream reader may reuse its buffer for the next read
        pending.push(rest.slice());
        pendingBytes += rest.length;
      }
      return { lines, failure: null };
    },
    end(): SplitStep {
      if (failure !== null) return { lines: [], failure };
      const lines: string[] = [];
      if (pendingBytes > 0) {
        const f = takeLine(lines, new Uint8Array(0));
        if (f !== null) return failWith(lines, f);
      }
      return { lines, failure: null };
    },
    totalBytes(): number {
      return total;
    },
  };
}
