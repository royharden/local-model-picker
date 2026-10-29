// Constraints and SelectionOptions (Claude §2.5, D33, D34). recommend(runs, constraints, options).
import { z } from "zod";
import { nonNegNumber, fraction } from "./common.js";

export const OBJECTIVES = ["quality", "speed"] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** All finite and non-negative; accuracy, thresholds and alpha in [0, 1]. maxMemoryGB is decimal GB (bytes / 1e9). */
export const ConstraintsSchema = z
  .object({
    minTokPerSec: nonNegNumber,
    maxTtftMs: nonNegNumber,
    maxMemoryGB: nonNegNumber.nullable(),
    requireFullGpu: z.union([z.boolean(), z.literal("auto")]),
    fullGpuThreshold: fraction,
    minAccuracy: fraction.nullable(),
    alpha: fraction,
    spreadThreshold: nonNegNumber,
  })
  .strict();

export type Constraints = z.infer<typeof ConstraintsSchema>;

/** No hidden globals (C7): every switch that changes the result is here. allowMixedHardware lives here (D33). */
export const SelectionOptionsSchema = z
  .object({
    objective: z.enum(OBJECTIVES),
    groupKey: z.string().min(1).max(2000).nullable(),
    allowMixedHardware: z.boolean(),
    acceptRemote: z.boolean(),
    applyRulings: z.boolean(),
  })
  .strict();

export type SelectionOptions = z.infer<typeof SelectionOptionsSchema>;

/**
 * Constraints and options validated together: the speed objective requires minAccuracy
 * (clearing it is a validation error, never a hidden default).
 */
export const RecommendConfigSchema = z
  .object({ constraints: ConstraintsSchema, options: SelectionOptionsSchema })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.options.objective === "speed" && cfg.constraints.minAccuracy === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constraints", "minAccuracy"],
        message: "the speed objective requires minAccuracy (proposed default 0.6)",
      });
    }
  });

export type RecommendConfig = z.infer<typeof RecommendConfigSchema>;
