// Quantisation order for the estimate-only walk-down (D17): llmfit's QUANT_HIERARCHY idea
// (MIT, re-implemented) plus Q4_0, which Ollama ships. Highest quality first. Any other quant is
// excluded from the baseline with a reason.

export const QUANT_ORDER = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q4_0", "Q3_K_M", "Q2_K"] as const;
export type KnownQuant = (typeof QUANT_ORDER)[number];

/** Rank in QUANT_ORDER (0 = highest quality) or null for an unknown quant. Case-insensitive. */
export function quantRank(quantization: string | null): number | null {
  if (quantization === null) return null;
  const q = quantization.trim().toUpperCase();
  const i = (QUANT_ORDER as readonly string[]).findIndex((k) => k.toUpperCase() === q);
  return i < 0 ? null : i;
}

/**
 * Parameter count in billions from an Ollama parameter_size string ("8.0B", "70.6B", "500M",
 * "1.5b"). Null when absent or not in that shape.
 */
export function parseParameterSize(parameterSize: string | null): number | null {
  if (parameterSize === null) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMBT])\s*$/i.exec(parameterSize);
  if (m === null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] as string).toUpperCase();
  const scale = unit === "K" ? 1e-6 : unit === "M" ? 1e-3 : unit === "B" ? 1 : 1e3;
  return value * scale;
}

/** Model name for walk-down grouping (D29): the tag before the first ":" (the whole tag if none). */
export function modelNameOf(tag: string): string {
  const i = tag.indexOf(":");
  return i < 0 ? tag : tag.slice(0, i);
}
