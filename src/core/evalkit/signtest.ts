// Exact sign test on discordant pairs (Claude §2.6 step 6, F2).
// b = items the leader got right and the other candidate wrong; c = the converse.
// Concordant pairs are discarded before calling.
import { binomSf, binomCdf } from "./binom.js";

function checkCounts(b: number, c: number): void {
  if (!Number.isInteger(b) || b < 0 || !Number.isInteger(c) || c < 0) {
    throw new RangeError(`discordant counts must be non-negative integers, got b=${b}, c=${c}`);
  }
}

/** One-sided p = P(X >= b | X ~ Binomial(b + c, 0.5)); 1 when b + c = 0. Significantly lower when p < alpha. */
export function signTestOneSided(b: number, c: number): number {
  checkCounts(b, c);
  const n = b + c;
  if (n === 0) return 1;
  return binomSf(b, n, 0.5);
}

/** Two-sided p = min(1, 2 * min(P(X >= b), P(X <= b))); 1 when b + c = 0. Exported for others; recommend does not use it. */
export function signTestTwoSided(b: number, c: number): number {
  checkCounts(b, c);
  const n = b + c;
  if (n === 0) return 1;
  const upper = binomSf(b, n, 0.5);
  const lower = binomCdf(b, n, 0.5);
  return Math.min(1, 2 * Math.min(upper, lower));
}
