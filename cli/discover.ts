// `discover`: list installed candidates via /api/tags (+ /api/show per tag). Never pulls, copies or
// deletes a model. --models selects exact installed tags (a bare name also matches "<name>:latest");
// an unknown tag is an error, never a download.
import type { Candidate, ModelSummary, Runtime, RuntimeSignal, ShowInfo } from "../src/core/index.js";
import { CandidateSchema, candidateKeyOf, DEFAULT_PROTOCOL_CAPS, MAX_CANDIDATES, redact } from "../src/core/index.js";
import type { RedactOptions } from "../src/core/index.js";
import type { CliContext } from "./context.js";
import { EXIT, RUNTIME_OPTIONS, UsageError, parseCommandArgs, parseModelList, stringOpt } from "./context.js";
import { describeError } from "./providers/errors.js";
import { selectRuntime } from "./providers/select.js";
import { loadBundledData } from "./io/read.js";
import { redactionLiterals } from "./hwprobe/index.js";

export interface DiscoveredCandidate {
  summary: ModelSummary;
  show: ShowInfo | null;
  candidate: Candidate;
}

export type Selection = { ok: true; models: ModelSummary[] } | { ok: false; message: string };

/** Pick installed models by exact tag (bare names also match ":latest"); all models when `wanted` is undefined. Sorted by tag. */
export function selectModels(installed: readonly ModelSummary[], wanted: readonly string[] | undefined): Selection {
  const sorted = [...installed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (wanted === undefined) return { ok: true, models: sorted };
  const byName = new Map(sorted.map((m) => [m.name, m]));
  const picked: ModelSummary[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const m = byName.get(w) ?? (w.includes(":") ? undefined : byName.get(`${w}:latest`));
    if (m === undefined) missing.push(w);
    else if (!picked.includes(m)) picked.push(m);
  }
  if (missing.length > 0) {
    return { ok: false, message: `not installed: ${missing.slice(0, 10).join(", ")} (models are never pulled; run discover to list installed tags)` };
  }
  return { ok: true, models: picked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

/** Candidate identity from /api/tags, with /api/show details preferred when present. */
export function toCandidate(summary: ModelSummary, show: ShowInfo | null): Candidate | null {
  const d = show?.details;
  const candidate: Candidate = {
    key: candidateKeyOf(summary.name, summary.digest),
    tag: summary.name,
    digest: summary.digest,
    family: d?.family ?? summary.details.family,
    parameterSize: d?.parameterSize ?? summary.details.parameterSize,
    quantization: d?.quantizationLevel ?? summary.details.quantizationLevel,
    sizeBytes: summary.sizeBytes,
  };
  return CandidateSchema.safeParse(candidate).success ? candidate : null;
}

/** /api/show for each selected model (metadata only). A failed show keeps the /api/tags details with a warning. */
export async function discoverCandidates(
  runtime: Runtime,
  models: readonly ModelSummary[],
  signal: RuntimeSignal,
  redaction: RedactOptions,
): Promise<{ candidates: DiscoveredCandidate[]; warnings: string[] }> {
  const candidates: DiscoveredCandidate[] = [];
  const warnings: string[] = [];
  for (const m of models) {
    let show: ShowInfo | null = null;
    try {
      show = await runtime.show(m.name, signal);
    } catch (e) {
      warnings.push(redact(`show failed for one model; using /api/tags details: ${describeError(e)}`, redaction));
    }
    const candidate = toCandidate(m, show);
    if (candidate === null) {
      warnings.push("a model with an unusable tag or digest was skipped");
      continue;
    }
    candidates.push({ summary: m, show, candidate });
  }
  return { candidates, warnings };
}

const GB = 1e9;

export function describeCandidateLine(c: Candidate): string {
  const size = (c.sizeBytes / GB).toFixed(2);
  return `${c.tag}  digest ${c.digest.slice(0, 12)}  params ${c.parameterSize ?? "?"}  quant ${c.quantization ?? "?"}  ${size} GB`;
}

export async function discoverCommand(argv: string[], ctx: CliContext): Promise<number> {
  const args = parseCommandArgs(argv, { ...RUNTIME_OPTIONS, models: { type: "string" }, json: { type: "boolean", default: false } });
  if (args.positionals.length > 0) throw new UsageError("discover takes no positional arguments");
  const data = await loadBundledData(ctx.dataDir);
  const choice = selectRuntime(args.values, ctx, { ...DEFAULT_PROTOCOL_CAPS }, data.bank.items);
  const redaction = choice.kind === "mock" || choice.remote ? {} : redactionLiterals(ctx.os).metadata;
  for (const n of choice.notes) ctx.printErr(`note: ${n}`);
  let installed: ModelSummary[];
  try {
    installed = await choice.runtime.listModels(ctx.signal);
  } catch (e) {
    ctx.printErr(`error: could not list models: ${redact(describeError(e), redaction)}`);
    return EXIT.failure;
  }
  const sel = selectModels(installed, parseModelList(stringOpt(args.values["models"])));
  if (!sel.ok) {
    ctx.printErr(`error: ${sel.message}`);
    return EXIT.failure;
  }
  const found = await discoverCandidates(choice.runtime, sel.models, ctx.signal, redaction);
  if (args.values["json"] === true) {
    ctx.print(redact(JSON.stringify({ runtime: choice.kind, endpointKind: choice.endpointKind, candidates: found.candidates.map((c) => c.candidate), warnings: found.warnings }, null, 2), redaction));
    return EXIT.ok;
  }
  if (choice.kind === "mock") ctx.print("MOCK DATA: synthetic models served by the mock runtime (not a measurement)");
  if (choice.remote) ctx.print("REMOTE endpoint");
  ctx.print(`${found.candidates.length} installed candidate(s):`);
  for (const c of found.candidates) ctx.print(redact(`  ${describeCandidateLine(c.candidate)}`, redaction));
  if (found.candidates.length > MAX_CANDIDATES) ctx.print(`note: a run measures at most ${MAX_CANDIDATES} candidates; pass --models`);
  for (const w of found.warnings) ctx.printErr(`warning: ${w}`);
  return EXIT.ok;
}
