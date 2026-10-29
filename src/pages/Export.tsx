import { useState } from "react";
import type { ValidationIssue } from "../core/index.js";
import { useViewer } from "../state/ViewerContext.js";
import { downloadText, prepareJsonExport, prepareMarkdownExport, safeDownloadName } from "../state/model.js";
import { Badge, EmptyState, Issues, PageHeading } from "../components/Primitives.js";

export default function Export() {
  const { state } = useViewer();
  const [runId, setRunId] = useState("");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [saved, setSaved] = useState("");
  if (!state.runs.length) return <EmptyState />;
  const run = state.runs.find((r) => r.runId === runId) ?? state.runs[0];
  function json() {
    if (!run) return;
    const result = prepareJsonExport(run);
    if (!result.ok) { setIssues(result.errors); return; }
    try { downloadText(result.value, `${safeDownloadName(run.runId)}.json`, "application/json;charset=utf-8"); setIssues([]); setSaved("JSON download prepared with the complete ruling log."); }
    catch { setIssues([{ path: "download", message: "Your browser could not start the download." }]); }
  }
  function markdown() {
    const result = prepareMarkdownExport(state.runs, state.constraints, state.options);
    if (!result.ok) { setIssues(result.errors); return; }
    try { downloadText(result.value, "local-model-picker-report.md", "text/markdown;charset=utf-8"); setIssues([]); setSaved("Markdown download prepared for the current selection settings."); }
    catch { setIssues([{ path: "download", message: "Your browser could not start the download." }]); }
  }
  return <><PageHeading eyebrow="05 / Take your evidence" title="Keep the decision. Keep the receipts.">Download portable run files with appended rulings, or a readable report of the active comparison and its decision trace.</PageHeading>
    <Issues issues={issues} />{saved && <p className="success-message" role="status">{saved}</p>}
    <div className="export-grid"><section className="panel export-card"><span className="export-icon" aria-hidden="true">{ "{ }" }</span><Badge tone="teal">Roundtrip-ready</Badge><h2>Run JSON</h2><p>Original measurements and grades, plus every appended ruling. Import this file again to reproduce original and corrected decisions with the same selection settings.</p><label className="field"><span>Run to export</span><select value={run?.runId ?? ""} onChange={(e) => setRunId(e.target.value)}>{state.runs.map((r) => <option value={r.runId} key={r.runId}>{r.runId} · {r.rulings.length} rulings</option>)}</select></label><button className="button primary" onClick={json}>↓ Download JSON</button><p className="footnote">One run per file, validated and size-checked before download. Export each run to preserve a multi-run comparison. Selection settings are in the Markdown report.</p></section>
      <section className="panel export-card"><span className="export-icon" aria-hidden="true">≡</span><Badge>Readable audit trail</Badge><h2>Markdown report</h2><p>The active decision, original and corrected picks, constraints, baseline choices, full rejection evidence, saved responses, and rulings across imported runs.</p><ul className="reason-list"><li>Escaped prose and HTML</li><li>Response fences longer than embedded backticks</li><li>Terminal control characters removed</li></ul><button className="button secondary" onClick={markdown}>↓ Download Markdown</button><p className="footnote">A text report. Raw responses remain fenced data, never executed or rendered as HTML.</p></section></div>
    <section className="privacy-note"><span aria-hidden="true">◇</span><div><h3>Your files, your workspace</h3><p>Exports use redacted copies: home paths, IP literals, and recognizable host names are removed. No files are uploaded. The workspace lives in memory and closes on refresh.</p></div></section>
  </>;
}
