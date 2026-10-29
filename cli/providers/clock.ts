// Clocks for the CLI. Core never reads a clock; the CLI injects these.
// - MonotonicClock: request start and chunk arrival times (TTFT / TTFA, wall-clock per candidate).
// - WallClock: createdAt, runId and availableMemory.at (UTC ISO strings, fixed width).
// - ManualClock: a deterministic monotonic clock the mock runtime advances (R8), also used by tests.

export interface MonotonicClock {
  /** milliseconds from an arbitrary origin; never decreases */
  nowMs(): number;
}

export interface WallClock {
  /** UTC timestamp in Date.prototype.toISOString form (YYYY-MM-DDTHH:MM:SS.sssZ) */
  nowIso(): string;
}

export interface ManualClock extends MonotonicClock {
  /** move time forward by ms (negative or non-finite values are ignored) */
  advance(ms: number): void;
}

export function systemClock(): MonotonicClock {
  return { nowMs: () => performance.now() };
}

export function systemWallClock(): WallClock {
  return { nowIso: () => new Date().toISOString() };
}

export function createManualClock(startMs = 0): ManualClock {
  let now = startMs;
  return {
    nowMs: () => now,
    advance(ms: number): void {
      if (Number.isFinite(ms) && ms > 0) now += ms;
    },
  };
}

/** A wall clock pinned to one instant (tests, reproducible mock samples). */
export function fixedWallClock(iso: string): WallClock {
  return { nowIso: () => iso };
}

/** Timer seam so request timeouts can be driven by fake timers in tests. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function systemTimers(): Timers {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** runId from the CLI wall clock: "run-" + the ISO timestamp without separators, e.g. run-20261024T150000000Z. */
export function runIdFromIso(iso: string): string {
  return `run-${iso.replace(/[-:.]/g, "")}`;
}
