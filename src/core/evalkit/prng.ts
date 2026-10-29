// mulberry32: small seeded 32-bit PRNG (public-domain algorithm by Tommy Ettinger, re-implemented).
// Core never uses Math.random (eslint enforces it).

/** Returns a generator of floats in [0, 1). The same seed always yields the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n) from a generator. */
export function randInt(rand: () => number, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`n must be a positive integer, got ${n}`);
  return Math.floor(rand() * n);
}
