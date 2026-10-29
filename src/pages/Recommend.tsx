import { useState } from "react";
import type { FormEvent } from "react";
import { RecommendConfigSchema } from "../core/index.js";
import type { ValidationIssue, Objective } from "../core/index.js";
import { useViewer } from "../state/ViewerContext.js";
import { Badge, DecisionCard, EmptyState, Issues, PageHeading } from "../components/Primitives.js";

export default function Recommend() {
  const { state, dispatch, original, corrected, result } = useViewer();
  const [objective, setObjective] = useState<Objective>(state.options.objective);
  const [fields, setFields] = useState(() => Object.fromEntries(Object.entries(state.constraints).map(([key, value]) => [key, value === null ? "" : String(value)])));
  const [remote, setRemote] = useState(state.options.acceptRemote);
  const [mixed, setMixed] = useState(state.options.allowMixedHardware);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  if (!state.runs.length) return <EmptyState />;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const numeric = (key: string, nullable = false) => fields[key]?.trim() === "" ? (nullable ? null : NaN) : Number(fields[key]);
    const gpu = fields["requireFullGpu"];
    const parsed = RecommendConfigSchema.safeParse({ constraints: {
      minTokPerSec: numeric("minTokPerSec"), maxTtftMs: numeric("maxTtftMs"), maxMemoryGB: numeric("maxMemoryGB", true),
      requireFullGpu: gpu === "auto" ? "auto" : gpu === "true", fullGpuThreshold: numeric("fullGpuThreshold"),
      minAccuracy: numeric("minAccuracy", true), alpha: numeric("alpha"), spreadThreshold: numeric("spreadThreshold"),
    }, options: { ...state.options, objective, acceptRemote: remote, allowMixedHardware: mixed, groupKey: mixed === state.options.allowMixedHardware ? state.options.groupKey : null } });
    if (!parsed.success) { setIssues(parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))); return; }
    setIssues([]); dispatch({ type: "config", ...parsed.data });
  }
  const field = (key: string, label: string, hint: string, max?: number) => <label className="field" key={key}><span>{label}</span><input name={key} type="number" min="0" max={max} step="any" value={fields[key] ?? ""} onChange={(e) => setFields((old) => ({ ...old, [key]: e.target.value }))} /><small>{hint}</small></label>;
  return <><PageHeading eyebrow="03 / Decision workspace" title="Your limits. A traceable choice.">Hard limits come first. The decision then weighs accuracy and speed, with uncertainty left visible.</PageHeading>
    <div className="recommend-layout"><form className="panel constraints-panel" onSubmit={submit}><div className="card-top"><h2>Selection limits</h2><Badge>Proposed defaults</Badge></div><label className="field"><span>Objective</span><select value={objective} onChange={(event) => { const next = event.target.value as Objective; setObjective(next); if (next === "speed" && !fields["minAccuracy"]) setFields((old) => ({ ...old, minAccuracy: "0.6" })); }}><option value="quality">Quality · accuracy first</option><option value="speed">Speed · fastest above accuracy floor</option></select></label>
      <div className="field-grid">{field("minTokPerSec", "Minimum tokens / second", "Proposed default: 8")}{field("maxTtftMs", "Maximum response latency (ms)", "Proposed default: 5,000; TTFA when thinking")}{field("maxMemoryGB", "Maximum memory (GB)", "Decimal GB. Blank = no cap; never inferred.")}{field("minAccuracy", "Minimum accuracy (0–1)", "Speed requires a floor; proposed: 0.6", 1)}</div>
      <label className="field"><span>Require full GPU</span><select value={fields["requireFullGpu"]} onChange={(e) => setFields((old) => ({ ...old, requireFullGpu: e.target.value }))}><option value="auto">Auto · proposed default</option><option value="true">Yes · require measured GPU offload</option><option value="false">No · allow partial offload or CPU</option></select><small>Remote groups need an explicit Yes or No.</small></label>
      <details className="advanced"><summary>Statistical & comparison settings</summary>{field("fullGpuThreshold", "Full-GPU threshold (0–1)", "Proposed default: 0.95", 1)}{field("alpha", "One-sided sign-test alpha", "Proposed default: 0.05; no multiplicity correction", 1)}{field("spreadThreshold", "Speed spread warning threshold", "Proposed default: 0.25")}
        <label className="checkbox"><input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />Accept remote measurements</label><label className="checkbox"><input type="checkbox" checked={mixed} onChange={(e) => setMixed(e.target.checked)} />Allow mixed local hardware (low confidence)</label></details>
      <Issues issues={issues} /><button className="button primary full" type="submit">Apply limits →</button><p className="footnote">Settings apply when you choose Apply limits. Confidence is a heuristic, not a probability.</p>
    </form><div className="decision-column"><DecisionCard title={state.options.applyRulings ? "Active · rulings applied" : "Active · original grades"} result={result} active />
      {result.tied && <div className="banner tie-banner" role="status"><strong>Tied within noise</strong><span>This item bank could not distinguish {result.noiseSet.length} candidates. The faster candidate wins the tie; this does not prove equivalent quality. A longer eval can help.</span><span className="mono">{result.noiseSet.join(" · ")}</span></div>}
      {result.speedComparison && <p className="speed-comparison">↗ {result.speedComparison.text}</p>}
      <section className="panel"><h3>Confidence, explained</h3>{result.confidenceReasons.length ? <ul className="reason-list">{result.confidenceReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>No low-confidence reasons were recorded for this group.</p>}</section>
      {result.command && <section className="command-card"><span className="eyebrow">Run it locally · command as text</span><code>{result.command}</code></section>}
    </div></div>
    <div className="section-heading"><div><h2>One record, two views</h2><p>Original grades remain intact. Human rulings change correctness only.</p></div><label className="checkbox"><input type="checkbox" checked={state.options.applyRulings} onChange={(e) => dispatch({ type: "config", constraints: state.constraints, options: { ...state.options, applyRulings: e.target.checked } })} />Use rulings for active decision</label></div><div className="decision-pair"><DecisionCard title="Original grades" result={original} /><DecisionCard title="Rulings applied" result={corrected} /></div>
    <div className="section-heading"><div><h2>What simpler rules would pick</h2><p>Baselines expose the cost of ignoring measured evidence or your limits.</p></div></div><div className="baseline-grid">{[result.baselines.estimateOnly, result.baselines.fastestOnly, result.baselines.accuracyOnly].map((baseline) => <article className="panel baseline-card" key={baseline.method}><span className="eyebrow">{baseline.method}</span><h3>{baseline.label}</h3><p className="mono">{baseline.available ? baseline.pick ?? "No pick" : "Unavailable"}</p><p>{baseline.reason}</p>{baseline.violations.length > 0 && <div className="baseline-warning">Violates: {baseline.violations.join(", ")}</div>}</article>)}</div><p className="footnote">Estimate-only uses installed weight sizes and free memory; it excludes KV cache and runtime overhead. Fastest-only and accuracy-only ignore your limits.</p>
    <div className="section-heading"><div><h2>Why not the others?</h2><p>The complete trace includes every failed limit, comparison, incompatible group, and superseded measurement.</p></div><Badge>{result.trace.length} trace entries</Badge></div><div className="trace-list">{result.trace.length === 0 ? <p className="muted">No candidate trace is available. Choose a group above.</p> : result.trace.map((entry, index) => <article className={`trace-entry trace-${entry.kind}`} key={index}><div><Badge tone={entry.kind === "filter" ? "amber" : "neutral"}>{entry.kind}</Badge><strong className="mono">{entry.candidateKey}</strong></div><p>{entry.text}</p>{entry.kind === "filter" && <dl className="filter-evidence"><div><dt>Filter</dt><dd>{entry.filter}</dd></div><div><dt>Measured</dt><dd>{String(entry.measured)} {entry.unit}</dd></div><div><dt>Limit</dt><dd>{String(entry.limit)} {entry.unit}</dd></div><div><dt>Source</dt><dd>{entry.source}</dd></div></dl>}</article>)}</div>
  </>;
}
