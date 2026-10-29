import { useState } from "react";
import { latestRulings } from "../core/index.js";
import type { ItemResult, RunFile, ValidationIssue } from "../core/index.js";
import { useViewer } from "../state/ViewerContext.js";
import { appendRuling } from "../state/model.js";
import { expectedFor } from "../state/expected.js";
import { Badge, DecisionCard, EmptyState, Issues, PageHeading } from "../components/Primitives.js";

function ResponseEditor({ run, candidateKey, item }: { run: RunFile; candidateKey: string; item: ItemResult }) {
  const { dispatch } = useViewer();
  const latest = latestRulings(run.rulings, run.runId, candidateKey).get(item.itemId);
  const effective = latest?.overrideCorrect ?? item.correct;
  const [reason, setReason] = useState("");
  const [extraction, setExtraction] = useState("");
  const [override, setOverride] = useState(!effective);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  function save() {
    const result = appendRuling(run, { candidateKey, itemId: item.itemId, overrideCorrect: override, reason,
      correctedExtraction: extraction.trim() || null, at: new Date().toISOString() });
    if (!result.ok) { setIssues(result.errors); return; }
    dispatch({ type: "replace-rulings", run: result.value }); setReason(""); setExtraction(""); setIssues([]);
  }
  return <><section className="panel response-panel"><div className="card-top"><div><span className="eyebrow">Saved response · {item.itemId}</span><h2>Read the evidence</h2></div><Badge tone={effective ? "teal" : "amber"}>{effective ? "Correct" : "Incorrect"}{latest ? " · human ruling" : " · original grader"}</Badge></div>
    <div className="audit-values"><div><h3>Expected answer / rule</h3><pre>{expectedFor(run, item.itemId)}</pre></div><div><h3>Grader extraction</h3><pre>{item.extracted ?? "No extraction recorded"}</pre>{latest?.correctedExtraction !== null && latest?.correctedExtraction !== undefined && <><h3>Human extraction note</h3><pre>{latest.correctedExtraction}</pre></>}</div></div>
    <h3>Raw text that was graded</h3><p className="muted">Saved, capped, redacted text. Response content is displayed as text.</p><pre className="raw-response" tabIndex={0}>{item.raw || "(empty response)"}</pre><div className="row-badges"><Badge>Original: {item.correct ? "correct" : "incorrect"}</Badge><Badge>Effective: {effective ? "correct" : "incorrect"}</Badge><Badge>{item.graderId}</Badge>{item.flags.map((flag) => <Badge tone="amber" key={flag}>{flag}</Badge>)}{item.truncated && <Badge tone="amber">truncated</Badge>}</div>
  </section><section className="panel ruling-panel"><span className="eyebrow">Grader wrong?</span><h2>Append a human ruling</h2><p>The log changes correctness only. The original response, extraction, and grade stay intact.</p><label className="field"><span>Effective grade after this ruling</span><select value={String(override)} onChange={(e) => setOverride(e.target.value === "true")}><option value="true">Correct</option><option value="false">Incorrect</option></select></label><label className="field"><span>Reason · required</span><textarea aria-label="Ruling reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What did the grader miss? Include the evidence for this correction." /><small>{reason.trim().length} / 500 characters</small></label><label className="field"><span>Corrected extraction · optional note</span><textarea aria-label="Corrected extraction" rows={2} maxLength={1000} value={extraction} onChange={(e) => setExtraction(e.target.value)} /><small>A note for audit; it never changes model text or reruns a grader.</small></label><Issues issues={issues} /><button className="button primary" onClick={save}>Append ruling →</button></section></>;
}

export default function Audit() {
  const { state, original, corrected, selectedRuns } = useViewer();
  const [runId, setRunId] = useState("");
  const [candidateKey, setCandidateKey] = useState("");
  const [itemId, setItemId] = useState("");
  if (!state.runs.length) return <EmptyState />;
  const runs = selectedRuns.length ? selectedRuns : state.runs;
  const run = runs.find((r) => r.runId === runId) ?? runs[0];
  const candidate = run?.candidates.find((c) => c.candidate.key === candidateKey) ?? run?.candidates[0];
  const item = candidate?.items.find((i) => i.itemId === itemId) ?? candidate?.items[0];
  return <><PageHeading eyebrow="04 / Grader audit" title="Trust the evidence. Check the grader.">Inspect every saved response and append a reasoned correction. Recommendation changes remain visible beside the original decision.</PageHeading>
    <div className="decision-pair"><DecisionCard title="Original grades" result={original} /><DecisionCard title="Rulings applied" result={corrected} /></div>
    <section className="panel audit-selectors"><label className="field"><span>Run</span><select value={run?.runId ?? ""} onChange={(e) => { setRunId(e.target.value); setCandidateKey(""); setItemId(""); }}>{runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId}</option>)}</select></label><label className="field"><span>Candidate</span><select value={candidate?.candidate.key ?? ""} onChange={(e) => { setCandidateKey(e.target.value); setItemId(""); }}>{run?.candidates.map((c) => <option key={c.candidate.key} value={c.candidate.key}>{c.candidate.tag} · {c.status}</option>)}</select></label><label className="field"><span>Response ({candidate?.items.length ?? 0} saved)</span><select value={item?.itemId ?? ""} onChange={(e) => setItemId(e.target.value)}>{candidate?.items.map((i) => <option key={i.itemId} value={i.itemId}>{i.itemId} · original {i.correct ? "correct" : "incorrect"}</option>)}</select></label></section>
    {run && candidate && item ? <div className="audit-layout"><ResponseEditor key={`${run.runId}/${candidate.candidate.key}/${item.itemId}`} run={run} candidateKey={candidate.candidate.key} item={item} /></div> : <section className="panel"><h2>No saved responses</h2><p>This candidate was not fully measured. Choose another candidate or run.</p></section>}
    <div className="section-heading"><div><h2>Append-only ruling log <span className="count">{run?.rulings.length ?? 0}</span></h2><p>Replayed by sequence. Later rulings supersede earlier rulings for the same candidate and item.</p></div></div><div className="ruling-log">{run?.rulings.length ? run.rulings.map((ruling) => <article className="panel" key={ruling.id}><div className="card-top"><Badge tone="teal">Sequence {ruling.seq}</Badge><span className="muted">{ruling.by} · {ruling.at}</span></div><h3 className="mono">{ruling.candidateKey} / {ruling.itemId}</h3><p>{ruling.reason}</p><p className="muted">Original: {String(ruling.originalCorrect)} → ruling: {String(ruling.overrideCorrect)} · supersedes {ruling.previousRulingId ?? "none"}</p>{ruling.correctedExtraction !== null && <pre>{ruling.correctedExtraction}</pre>}</article>) : <div className="library-empty"><p>No human rulings in this run yet.</p></div>}</div>
  </>;
}
