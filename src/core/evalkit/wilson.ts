// Wilson score interval (two-sided; z = 1.959964 for 95%).
import { WILSON_Z_95 } from "../config/defaults.js";

export interface WilsonInterval {
  /** observed proportion k / n (0 when n = 0) */
  p: number;
  lo: number;
  hi: number;
}

/**
 * Wilson interval for k successes in n trials. n = 0 gives the uninformative [0, 1] with p 0.
 * Bounds are clamped to [0, 1]; 0/n has lo exactly 0 and n/n has hi exactly 1.
 */
export function wilson(k: number, n: number, z: number = WILSON_Z_95): WilsonInterval {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`k must be an integer in [0, n], got ${k}`);
  if (!(Number.isFinite(z) && z > 0)) throw new RangeError(`z must be a positive finite number, got ${z}`);
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const lo = k === 0 ? 0 : Math.max(0, center - half);
  const hi = k === n ? 1 : Math.min(1, center + half);
  return { p, lo, hi };
}
