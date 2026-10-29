// D23: authored in Dirty Mode, never executed during construction.
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { mulberry32, signTestOneSided } from "../src/core/index.js";

export const SIMULATION = {
  seed: 0x5332,
  trials: 10_000,
  items: 30,
  alpha: 0.05,
  pairs: [[0.65, 0.62], [0.65, 0.55], [0.65, 0.65]],
} as const;

export interface Frequency {
  count: number;
  rate: number;
  mcse: number;
}
export interface SimulationRow {
  trueA: number;
  trueB: number;
  trials: number;
  items: number;
  alpha: number;
  falseTie: Frequency | null;
  wrongDirectionSignificantWin: Frequency | null;
  nullFalseDifference: Frequency | null;
  nullUnresolved: Frequency | null;
}

function frequency(count: number): Frequency {
  const rate = count / SIMULATION.trials;
  return { count, rate, mcse: Math.sqrt(rate * (1 - rate) / SIMULATION.trials) };
}

/**
 * One mulberry32 stream, in listed pair/trial/item order, A draw then B draw. All Bernoulli
 * responses are independent across candidates, items and trials: no shared difficulty/correlation.
 * Select the observed accuracy leader AFTER drawing responses (A wins equal observed scores),
 * then test leader-right/other-wrong discordances one-sided with p < alpha. This reproduces
 * post-hoc direction selection, not a calibrated test against a prespecified leader.
 * Positive true gap: false tie = no significant difference; false win = significant B win.
 * Null: false difference = either significant direction; unresolved = no significant difference.
 * These have different meanings; null non-rejection is never called a false tie.
 * MCSE is sqrt(rate * (1-rate) / trials), a binomial Monte Carlo error, not model uncertainty.
 */
export function simulate(): SimulationRow[] {
  const random = mulberry32(SIMULATION.seed);
  return SIMULATION.pairs.map(([trueA, trueB]) => {
    let unresolved = 0;
    let wrongWin = 0;
    let declaredDifference = 0;
    for (let trial = 0; trial < SIMULATION.trials; trial++) {
      let aOnly = 0;
      let bOnly = 0;
      for (let item = 0; item < SIMULATION.items; item++) {
        const a = random() < trueA;
        const b = random() < trueB;
        if (a && !b) aOnly++;
        if (b && !a) bOnly++;
      }
      const aLeads = aOnly >= bOnly;
      const p = signTestOneSided(aLeads ? aOnly : bOnly, aLeads ? bOnly : aOnly);
      if (p < SIMULATION.alpha) {
        declaredDifference++;
        if (!aLeads) wrongWin++;
      } else unresolved++;
    }
    const positiveGap = trueA > trueB;
    return {
      trueA, trueB, trials: SIMULATION.trials, items: SIMULATION.items, alpha: SIMULATION.alpha,
      falseTie: positiveGap ? frequency(unresolved) : null,
      wrongDirectionSignificantWin: positiveGap ? frequency(wrongWin) : null,
      nullFalseDifference: positiveGap ? null : frequency(declaredDifference),
      nullUnresolved: positiveGap ? null : frequency(unresolved),
    };
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify({ parameters: SIMULATION, rows: simulate() }, null, 2)}\n`);
}
