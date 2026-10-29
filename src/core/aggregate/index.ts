// Aggregation barrel (M3): speed, memory and accuracy summaries of one candidate measurement.
export { aggregateSpeed, median } from "./speed.js";
export type { SpeedAggregate, LatencyMetric } from "./speed.js";
export { aggregateMemory, BYTES_PER_GB } from "./memory.js";
export type { MemoryAggregate } from "./memory.js";
export { aggregateAccuracy, latestRulings, discordance } from "./accuracy.js";
export type { AccuracyAggregate, Discordance } from "./accuracy.js";
