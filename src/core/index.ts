// Public surface of the pure core. The viewer, the CLI, scripts and tests import core only from
// here (PLAN.md §3). Frozen at M1 exit: later milestones add exports (graders, aggregate,
// recommend, estimate, baselines, report, provider parsers) with a note in STATUS.md.
// Seam owner: S32-INT.

// Configuration and proposed defaults
export * from "./config/defaults.js";

// Contracts (zod schemas + inferred types)
export * from "./schema/fingerprint.js";
export * from "./schema/candidate.js";
export * from "./schema/constraints.js";
export * from "./schema/rulings.js";
export * from "./schema/runfile.js";
export * from "./schema/items.js";
export * from "./schema/result.js";

// Run-file import / export
export * from "./io/readrunfile.js";

// Statistics and evaluation helpers
export * from "./evalkit/index.js";

// Safety helpers
export * from "./redact/redact.js";
export * from "./redact/terminal.js";
export * from "./recommend/safe-command.js";

// Runtime seam and browser-safe provider parsers (M4)
export * from "./providers/index.js";

// Graders and answer normalisation (M2)
export * from "./graders/index.js";

// Aggregation, recommendation, installed-only estimate and reports (M3)
export * from "./aggregate/index.js";
export * from "./recommend/group.js";
export * from "./recommend/recommend.js";
export * from "./recommend/trace.js";
export * from "./recommend/confidence.js";
export * from "./estimate/index.js";
export * from "./baselines.js";
export * from "./report/markdown.js";
