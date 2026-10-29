// Exact binomial distribution in plain TypeScript (no statistics library).
// Terms are built iteratively in log space, so n up to several thousand neither overflows nor
// underflows the first term; for n <= a few hundred and p = 0.5 the results match the exact
// rationals to ~1e-15 relative error (tests compare with hand-computed fractions).

function checkArgs(k: number, n: number, p: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(k)) throw new RangeError(`k must be an integer, got ${k}`);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p must be in [0, 1], got ${p}`);
}

/** ln C(n, k) by a sum of logs (0 <= k <= n). */
function lnChoose(n: number, k: number): number {
  const m = Math.min(k, n - k);
  let s = 0;
  for (let i = 1; i <= m; i++) s += Math.log(n - m + i) - Math.log(i);
  return s;
}

/** P(X = k) for X ~ Binomial(n, p). */
export function binomPmf(k: number, n: number, p: number): number {
  checkArgs(k, n, p);
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(lnChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** Sum of pmf over [lo, hi] (inclusive, 0 <= lo <= hi <= n), terms by the ratio recurrence in log space. */
function sumRange(lo: number, hi: number, n: number, p: number): number {
  if (lo > hi) return 0;
  if (p === 0) return lo === 0 ? 1 : 0;
  if (p === 1) return hi === n ? 1 : 0;
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  let lt = lnChoose(n, lo) + lo * lp + (n - lo) * lq;
  let s = 0;
  for (let i = lo; i <= hi; i++) {
    s += Math.exp(lt);
    // t(i + 1) = t(i) * (n - i) / (i + 1) * p / (1 - p)
    if (i < hi) lt += Math.log(n - i) - Math.log(i + 1) + lp - lq;
  }
  return Math.min(1, Math.max(0, s));
}

/** P(X <= k). */
export function binomCdf(k: number, n: number, p: number): number {
  checkArgs(k, n, p);
  if (k < 0) return 0;
  if (k >= n) return 1;
  return sumRange(0, k, n, p);
}

/** P(X >= k), summed directly (no 1 - cdf cancellation). */
export function binomSf(k: number, n: number, p: number): number {
  checkArgs(k, n, p);
  if (k <= 0) return 1;
  if (k > n) return 0;
  return sumRange(k, n, n, p);
}
