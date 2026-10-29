import {
  DEFAULT_RULING_BY, DEFAULT_SELECTION_OPTIONS, RUN_FILE_MAX_BYTES, defaultConstraints,
  nextRulingSeq, latestRulings, parseRunFileValue, readRunFile, redactDeep,
  serializeRunFile, checkRunFileSize, markdownReport, recommend,
} from "../core/index.js";
import type { Constraints, SelectionOptions, RunFile, Result, Ruling } from "../core/index.js";

export interface ViewerState {
  runs: RunFile[];
  constraints: Constraints;
  options: SelectionOptions;
  notice: string;
}
export const initialState: ViewerState = {
  runs: [], constraints: defaultConstraints("quality"), options: { ...DEFAULT_SELECTION_OPTIONS }, notice: "",
};
export type ViewerAction =
  | { type: "import"; run: RunFile }
  | { type: "remove"; runId: string }
  | { type: "config"; constraints: Constraints; options: SelectionOptions }
  | { type: "replace-rulings"; run: RunFile };

/** Conflicting run identities require explicit removal; imports never silently replace evidence. */
export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  if (action.type === "import") {
    const previous = state.runs.find((run) => run.runId === action.run.runId);
    if (previous) return { ...state, notice: serializeRunFile(previous) === serializeRunFile(action.run)
      ? `Run ${action.run.runId} is already imported; no duplicate added.`
      : `Run ${action.run.runId} has different contents. Remove the existing run before importing this version; existing evidence was kept.` };
    return { ...state, runs: [...state.runs, action.run], notice: `Imported ${action.run.runId}.` };
  }
  if (action.type === "remove") return { ...state, runs: state.runs.filter((run) => run.runId !== action.runId), options: { ...state.options, groupKey: null }, notice: "Run removed from this session." };
  if (action.type === "config") return { ...state, constraints: action.constraints, options: action.options, notice: "Selection settings updated." };
  return { ...state, runs: state.runs.map((run) => run.runId === action.run.runId ? action.run : run), notice: "Ruling appended. Original grades are unchanged." };
}

export interface LocalFile { size: number; arrayBuffer(): Promise<ArrayBuffer> }
/** The browser file's declared byte count is checked BEFORE reading; core checks actual bytes again. */
export async function importLocalFile(file: LocalFile): Promise<Result<RunFile>> {
  if (file.size > RUN_FILE_MAX_BYTES) return { ok: false, errors: [{ path: "file.size", message: `File exceeds the ${RUN_FILE_MAX_BYTES.toLocaleString("en-US")}-byte limit; it was not read.` }] };
  try { return readRunFile(new Uint8Array(await file.arrayBuffer())); }
  catch { return { ok: false, errors: [{ path: "file", message: "This file could not be read. Choose a local JSON run file." }] }; }
}

export interface RulingDraft { candidateKey: string; itemId: string; overrideCorrect: boolean; reason: string; correctedExtraction: string | null; at: string }
export function appendRuling(run: RunFile, draft: RulingDraft): Result<RunFile> {
  const reason = draft.reason.trim();
  if (reason.length < 1 || reason.length > 500) return { ok: false, errors: [{ path: "rulings.reason", message: "A reason must contain 1 to 500 characters." }] };
  const item = run.candidates.find((c) => c.candidate.key === draft.candidateKey)?.items.find((i) => i.itemId === draft.itemId);
  if (!item) return { ok: false, errors: [{ path: "rulings.itemId", message: "Choose an existing graded response." }] };
  const seq = nextRulingSeq(run.rulings);
  const previous = latestRulings(run.rulings, run.runId, draft.candidateKey).get(draft.itemId);
  let id = `viewer-ruling-${seq}`;
  while (run.rulings.some((r) => r.id === id)) id += "-v";
  const ruling: Ruling = { id, seq, previousRulingId: previous?.id ?? null, kind: "grader_override", runId: run.runId,
    candidateKey: draft.candidateKey, itemId: draft.itemId, originalCorrect: item.correct, overrideCorrect: draft.overrideCorrect,
    correctedExtraction: draft.correctedExtraction, reason, by: DEFAULT_RULING_BY, at: draft.at };
  return parseRunFileValue({ ...run, rulings: [...run.rulings, ruling] });
}

/** Export uses a new redacted copy and validates again; references must survive redaction intact. */
export function prepareJsonExport(run: RunFile): Result<string> {
  const redacted = parseRunFileValue(redactDeep(run));
  if (!redacted.ok) return redacted;
  const text = serializeRunFile(redacted.value);
  const size = checkRunFileSize(text);
  return size.ok ? { ok: true, value: text } : { ok: false, errors: [{ path: "export", message: size.message }] };
}
export function prepareMarkdownExport(runs: RunFile[], constraints: Constraints, options: SelectionOptions): Result<string> {
  const copies: RunFile[] = [];
  for (const run of runs) {
    const valid = parseRunFileValue(redactDeep(run));
    if (!valid.ok) return valid;
    copies.push(valid.value);
  }
  const result = recommend(copies, constraints, options);
  return { ok: true, value: markdownReport(copies, result, constraints, options) };
}

/** Blob URLs live only through the browser's download handoff and are always revoked. */
export function downloadText(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name; document.body.append(link);
  try { link.click(); }
  finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
export const safeDownloadName = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "run";
