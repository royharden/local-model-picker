// evalkit: plain-TypeScript statistics and evaluation helpers (no statistics library).
export { wilson } from "./wilson.js";
export type { WilsonInterval } from "./wilson.js";
export { binomPmf, binomCdf, binomSf } from "./binom.js";
export { signTestOneSided, signTestTwoSided } from "./signtest.js";
export { mulberry32, randInt } from "./prng.js";
export { seededSplit } from "./split.js";
export type { Split } from "./split.js";
export { compareMethods } from "./compare.js";
export type { Method, MethodCase, MethodOutcome, CaseOutcome, ComparisonRow } from "./compare.js";
export { resultsMd, formatCell, PENDING } from "./resultsmd.js";
export type { Cell, MethodSummaryRow, ReferenceRow, ResultsMdOptions } from "./resultsmd.js";
