import { useState } from "react";
import type { ValidationIssue } from "../core/index.js";
import { RUN_FILE_MAX_BYTES, readRunFile } from "../core/index.js";
import { importLocalFile } from "../state/model.js";
import { useViewer } from "../state/ViewerContext.js";
import { Badge, Issues, PageHeading } from "../components/Primitives.js";

const samples = [
  { file: "quality-tradeoff.json", number: "01", title: "Fast isn't always better", detail: "A fast quant loses on accuracy. Follow the evidence to the balanced pick.", tag: "Quality tradeoff" },
  { file: "tied-within-noise.json", number: "02", title: "Too close to call", detail: "Accuracy differences sit inside the noise. See why speed breaks the tie.", tag: "Honest ties" },
  { file: "human-correction.json", number: "03", title: "Put the grader on trial", detail: "An append-only correction log changes the decision. Inspect both versions.", tag: "Audit & rulings" },
] as const;

export default function Runs() {
  const { state, dispatch } = useViewer();
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [busy, setBusy] = useState(false);
  async function loadFiles(files: File[]) {
    setBusy(true); setIssues([]);
    const errors: ValidationIssue[] = [];
    for (const file of files) {
      const result = await importLocalFile(file);
      if (result.ok) dispatch({ type: "import", run: result.value });
      else errors.push(...result.errors.map((error) => ({ ...error, path: `${file.name}: ${error.path || "file"}` })));
    }
    setIssues(errors); setBusy(false);
  }
  async function loadSample(file: typeof samples[number]["file"]) {
    setBusy(true); setIssues([]);
    try {
      // The sole network path in the viewer: fixed bundled, same-origin, credential-free assets.
      const url = new URL(`samples/${file}`, window.location.href);
      if (url.origin !== window.location.origin) throw new Error("Sample must be same-origin");
      const response = await fetch(url, { mode: "same-origin", credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error("The bundled sample could not be loaded.");
      const result = readRunFile(new Uint8Array(await response.arrayBuffer()));
      if (result.ok) dispatch({ type: "import", run: result.value });
      else setIssues(result.errors);
    } catch { setIssues([{ path: "sample", message: "The bundled sample could not be loaded. You can still import a saved JSON run." }]); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeading eyebrow="01 / Run library" title="Find the right model. On your terms.">Compare saved measurements, set your limits, and see exactly why a model earns its place.</PageHeading>
    <section className="import-panel"><div><Badge tone="teal">Local-first workspace</Badge><h2>Bring your own evidence</h2><p>Import JSON from the Local Model Picker CLI. Your runs stay in this browser session.</p><div className="import-facts"><span>Up to {RUN_FILE_MAX_BYTES / 1_000_000} MB per file</span><span>No account or API keys</span><span>Nothing uploaded</span></div></div><label className={`button primary file-button ${busy ? "disabled" : ""}`}>↑ Import run files<input aria-label="Import run files" type="file" accept=".json,application/json" multiple disabled={busy} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void loadFiles(files); }} /></label></section>
    <Issues issues={issues} />
    <div className="section-heading"><div><h2>Explore the tradeoffs</h2><p>Three synthetic stories. No measurements or setup required.</p></div><Badge>Bundled samples</Badge></div>
    <div className="sample-grid">{samples.map((sample) => <article className="sample-card" key={sample.file}><span className="sample-number">{sample.number}</span><Badge>{sample.tag}</Badge><h3>{sample.title}</h3><p>{sample.detail}</p><button className="text-button" disabled={busy} onClick={() => void loadSample(sample.file)}>Load sample <span aria-hidden="true">↗</span></button></article>)}</div>
    <div className="section-heading"><div><h2>Imported runs <span className="count">{state.runs.length}</span></h2><p>Latest candidate measurements win within a compatible comparison group.</p></div>{state.runs.length > 0 && <a className="button secondary" href="#compare">Compare models →</a>}</div>
    {state.runs.length === 0 ? <div className="library-empty"><span aria-hidden="true">▤</span><div><strong>A clean slate</strong><p>Load a sample above or import your first saved run.</p></div></div> : <div className="run-list">{state.runs.map((run) => <article className="run-row" key={run.runId}><div className="run-symbol" aria-hidden="true">▤</div><div className="run-main"><h3>{run.runId}</h3><p>{run.candidates.length} candidates · {run.itemIds.length} items · {run.createdAt.slice(0, 10)} · <span className="mono">{run.fingerprint.hash}</span></p>{run.warnings.length > 0 && <details><summary>{run.warnings.length} run warnings</summary><ul>{run.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}</div><Badge tone={run.runtime === "mock" ? "amber" : "neutral"}>{run.runtime === "mock" ? "MOCK" : run.remote ? "REMOTE" : "LOCAL"}</Badge><span className="muted">{run.rulings.length} rulings</span><button className="text-button danger" onClick={() => dispatch({ type: "remove", runId: run.runId })} aria-label={`Remove ${run.runId}`}>Remove</button></article>)}</div>}
    <p className="footnote">Refreshing closes this workspace. Export your runs and rulings to keep your work.</p>
  </>;
}
