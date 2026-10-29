// evalkit unit tests (authored in Dirty Mode; not yet run). Reference values are hand-computed below.
import { describe, it, expect } from "vitest";
import {
  wilson,
  binomPmf,
  binomCdf,
  binomSf,
  signTestOneSided,
  signTestTwoSided,
  mulberry32,
  seededSplit,
  compareMethods,
  resultsMd,
  formatCell,
} from "../../src/core/index.js";

describe("sign test (exact, discordant pairs)", () => {
  it("7 vs 1: one-sided P(X >= 7 | Bin(8, .5)) = (C(8,7) + C(8,8)) / 256 = 9/256", () => {
    expect(signTestOneSided(7, 1)).toBeCloseTo(9 / 256, 12); // 0.03515625
  });
  it("7 vs 1: two-sided = 2 * 9/256 = 18/256", () => {
    expect(signTestTwoSided(7, 1)).toBeCloseTo(18 / 256, 12); // 0.0703125
  });
  it("0 vs 0: no discordance gives p = 1 (both sides)", () => {
    expect(signTestOneSided(0, 0)).toBe(1);
    expect(signTestTwoSided(0, 0)).toBe(1);
  });
  it("5 vs 0: one-sided = (1/2)^5 = 1/32", () => {
    expect(signTestOneSided(5, 0)).toBeCloseTo(1 / 32, 12);
  });
  it("leader not better: 1 vs 7 one-sided = P(X >= 1 | Bin(8,.5)) = 255/256", () => {
    expect(signTestOneSided(1, 7)).toBeCloseTo(255 / 256, 12);
  });
  it("two-sided is capped at 1 (4 vs 4)", () => {
    expect(signTestTwoSided(4, 4)).toBe(1);
  });
  it("rejects negative or fractional counts", () => {
    expect(() => signTestOneSided(-1, 2)).toThrow(RangeError);
    expect(() => signTestOneSided(1.5, 2)).toThrow(RangeError);
  });
});

describe("binomial", () => {
  it("pmf matches hand-computed rationals for n = 8, p = .5", () => {
    expect(binomPmf(0, 8, 0.5)).toBeCloseTo(1 / 256, 14);
    expect(binomPmf(4, 8, 0.5)).toBeCloseTo(70 / 256, 14);
    expect(binomPmf(9, 8, 0.5)).toBe(0);
  });
  it("cdf and survival agree and sum to 1", () => {
    expect(binomCdf(8, 8, 0.5)).toBe(1);
    expect(binomCdf(-1, 8, 0.5)).toBe(0);
    expect(binomCdf(3, 8, 0.5)).toBeCloseTo((1 + 8 + 28 + 56) / 256, 12); // 93/256
    expect(binomSf(4, 8, 0.5)).toBeCloseTo((70 + 56 + 28 + 8 + 1) / 256, 12); // 163/256
    expect(binomCdf(3, 8, 0.5) + binomSf(4, 8, 0.5)).toBeCloseTo(1, 12);
  });
  it("pmf sums to 1 for n = 30, p = .3", () => {
    let s = 0;
    for (let k = 0; k <= 30; k++) s += binomPmf(k, 30, 0.3);
    expect(s).toBeCloseTo(1, 10);
  });
  it("degenerate p", () => {
    expect(binomPmf(0, 5, 0)).toBe(1);
    expect(binomPmf(5, 5, 1)).toBe(1);
    expect(binomSf(1, 5, 0)).toBe(0);
  });
});

// Wilson, z = 1.959964: z^2 = 3.8414588813, with n = 30: z^2/n = 0.1280486294, denominator 1 + z^2/n = 1.1280486294,
// z^2/(2n) = 0.0640243147, z^2/(4n^2) = 0.0010670719.
//   0/30: center = 0.0640243147 / 1.1280486294 = 0.0567567; half = z * sqrt(0.0010670719) / den = 1.959964 * 0.0326661 / 1.1280486 = 0.0567567
//         -> lo = 0, hi = 0.1280486 / 1.1280486 = 0.11351
//   15/30: p(1-p)/n = 0.0083333; sum = 0.0094004; sqrt = 0.0969557; * z = 0.1900297; / den = 0.168460; center = 0.5
//         -> [0.33154, 0.66846], half-width ~0.1685 (~0.169)
//   27/30: p(1-p)/n = 0.003; sum = 0.0040671; sqrt = 0.0637736; * z = 0.1249940; / den = 0.110806;
//         center = (0.9 + 0.0640243) / 1.1280486 = 0.854594 -> [0.74379, 0.96540]
//   30/30: mirror of 0/30 -> [0.88649, 1]
describe("wilson", () => {
  it("0/30", () => {
    const w = wilson(0, 30);
    expect(w.p).toBe(0);
    expect(w.lo).toBe(0);
    expect(w.hi).toBeCloseTo(0.11351, 4);
  });
  it("15/30 (half-width about 0.169)", () => {
    const w = wilson(15, 30);
    expect(w.lo).toBeCloseTo(0.33154, 4);
    expect(w.hi).toBeCloseTo(0.66846, 4);
    expect((w.hi - w.lo) / 2).toBeCloseTo(0.16846, 4);
  });
  it("27/30", () => {
    const w = wilson(27, 30);
    expect(w.p).toBeCloseTo(0.9, 12);
    expect(w.lo).toBeCloseTo(0.74379, 4);
    expect(w.hi).toBeCloseTo(0.9654, 4);
  });
  it("30/30", () => {
    const w = wilson(30, 30);
    expect(w.lo).toBeCloseTo(0.88649, 4);
    expect(w.hi).toBe(1);
  });
  it("n = 0 is uninformative; invalid input throws", () => {
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 1 });
    expect(() => wilson(31, 30)).toThrow(RangeError);
    expect(() => wilson(-1, 30)).toThrow(RangeError);
  });
});

describe("mulberry32", () => {
  it("is deterministic per seed, in [0, 1), and seed-sensitive", () => {
    const a = mulberry32(0x5332);
    const b = mulberry32(0x5332);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const c = mulberry32(0x5333);
    const zs = Array.from({ length: 10 }, () => c());
    expect(zs).not.toEqual(xs.slice(0, 10));
  });
  it("roughly uniform (mean of 10,000 draws within 0.02 of 0.5)", () => {
    const r = mulberry32(1);
    let s = 0;
    for (let i = 0; i < 10_000; i++) s += r();
    expect(Math.abs(s / 10_000 - 0.5)).toBeLessThan(0.02);
  });
});

describe("seededSplit", () => {
  const ids = Array.from({ length: 80 }, (_, i) => `g${String(i).padStart(2, "0")}`);
  it("is deterministic, disjoint, complete and 40/40", () => {
    const s1 = seededSplit(ids, 0x5332, 0.5);
    const s2 = seededSplit([...ids].reverse(), 0x5332, 0.5);
    expect(s1).toEqual(s2);
    expect(s1.dev.length).toBe(40);
    expect(s1.heldout.length).toBe(40);
    const dev = new Set(s1.dev);
    expect(s1.heldout.some((id) => dev.has(id))).toBe(false);
    expect([...s1.dev, ...s1.heldout].sort()).toEqual([...ids].sort());
  });
  it("different seeds give different splits; duplicates throw", () => {
    expect(seededSplit(ids, 1, 0.5).dev).not.toEqual(seededSplit(ids, 2, 0.5).dev);
    expect(() => seededSplit(["a", "a"], 1, 0.5)).toThrow(RangeError);
  });
});

describe("compareMethods and resultsMd", () => {
  it("counts expected-pick matches, violations and tie correctness", () => {
    const cases = [
      { id: "s01", input: 1, expectedPick: "q4", expectedTied: false },
      { id: "s02", input: 2, expectedPick: "q5", expectedTied: true },
    ];
    const rows = compareMethods(
      [
        { name: "recommend", run: (i: number) => ({ pick: i === 1 ? "q4" : "q5", limitViolations: 0, tied: i === 2 }) },
        { name: "fastest-only", run: () => ({ pick: "q2", limitViolations: 1, tied: null }) },
      ],
      cases,
    );
    expect(rows[0]).toMatchObject({ method: "recommend", cases: 2, expectedPickMatches: 2, limitViolations: 0, tieCases: 2, tieCorrect: 2 });
    expect(rows[1]).toMatchObject({ method: "fastest-only", expectedPickMatches: 0, limitViolations: 2, tieCases: 0, tieCorrect: 0 });
  });
  it("renders null cells as pending and escapes table text", () => {
    const md = resultsMd(
      [{ method: "recommend", cases: null, expectedPickMatches: null, limitViolations: null, tieCases: null, tieCorrect: null }],
      [{ name: "sign test 7 vs 1 (one-sided)", value: null, note: "a|b <c>" }],
    );
    expect(md).toContain("| recommend | pending | pending | pending | pending | pending |");
    expect(md).toContain("a\\|b &lt;c&gt;");
    // `&` is escaped first, so an entity typed as text stays text and is not decoded to "<".
    expect(formatCell("x & y")).toBe("x &amp; y");
    expect(formatCell("&lt;b&gt; <i>")).toBe("&amp;lt;b&amp;gt; &lt;i&gt;");
    expect(formatCell(0.0703125)).toBe("0.0703");
    expect(formatCell(14)).toBe("14");
  });
});
