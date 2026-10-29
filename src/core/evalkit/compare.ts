// Compare selection methods (recommend, estimate-only, fastest-only, accuracy-only) over the
// specification scenarios. Plain data in, plain rows out; scripts/eval.ts wires it up (M6).

export interface MethodOutcome {
  pick: string | null;
  /** number of active measured limits the pick violates (0 when pick is null) */
  limitViolations: number;
  /** null when the method has no notion of ties */
  tied: boolean | null;
}

export interface Method<I> {
  name: string;
  run(input: I): MethodOutcome;
}

export interface MethodCase<I> {
  id: string;
  input: I;
  expectedPick: string | null;
  /** null when the scenario makes no tie claim */
  expectedTied: boolean | null;
}

export interface CaseOutcome {
  caseId: string;
  pick: string | null;
  expectedPick: string | null;
  match: boolean;
  limitViolations: number;
  tied: boolean | null;
  tieCorrect: boolean | null;
}

export interface ComparisonRow {
  method: string;
  cases: number;
  expectedPickMatches: number;
  limitViolations: number;
  /** cases where both the method and the scenario state a tie flag */
  tieCases: number;
  tieCorrect: number;
  perCase: CaseOutcome[];
}

export function compareMethods<I>(methods: readonly Method<I>[], cases: readonly MethodCase<I>[]): ComparisonRow[] {
  return methods.map((m) => {
    const perCase: CaseOutcome[] = cases.map((c) => {
      const out = m.run(c.input);
      const tieCorrect = out.tied === null || c.expectedTied === null ? null : out.tied === c.expectedTied;
      return {
        caseId: c.id,
        pick: out.pick,
        expectedPick: c.expectedPick,
        match: out.pick === c.expectedPick,
        limitViolations: out.limitViolations,
        tied: out.tied,
        tieCorrect,
      };
    });
    return {
      method: m.name,
      cases: perCase.length,
      expectedPickMatches: perCase.filter((p) => p.match).length,
      limitViolations: perCase.reduce((s, p) => s + p.limitViolations, 0),
      tieCases: perCase.filter((p) => p.tieCorrect !== null).length,
      tieCorrect: perCase.filter((p) => p.tieCorrect === true).length,
      perCase,
    };
  });
}
