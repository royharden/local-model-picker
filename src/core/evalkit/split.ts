// Deterministic dev / held-out split (grader fixtures, D8). Input order does not matter:
// ids are sorted first, then shuffled by a seeded Fisher-Yates.
import { mulberry32, randInt } from "./prng.js";

export interface Split {
  dev: string[];
  heldout: string[];
}

const byId = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** dev gets round(n * devFraction) ids; both halves are disjoint and returned sorted ascending. */
export function seededSplit(ids: readonly string[], seed: number, devFraction: number): Split {
  if (!(devFraction >= 0 && devFraction <= 1)) throw new RangeError(`devFraction must be in [0, 1], got ${devFraction}`);
  const a = [...ids].sort(byId);
  for (let i = 1; i < a.length; i++) {
    if (a[i] === a[i - 1]) throw new RangeError(`duplicate id ${String(a[i])}`);
  }
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    const tmp = a[i] as string;
    a[i] = a[j] as string;
    a[j] = tmp;
  }
  const nDev = Math.round(a.length * devFraction);
  return { dev: a.slice(0, nDev).sort(byId), heldout: a.slice(nDev).sort(byId) };
}
