import { aggregateSpeed } from "../core/index.js";
import { useViewer } from "../state/ViewerContext.js";
import { Badge, EmptyState, PageHeading, number, percent } from "../components/Primitives.js";

export default function Compare() {
  const { state, result } = useViewer();
  if (!state.runs.length) return <EmptyState />;
  return <><PageHeading eyebrow="02 / Side by side" title="Every tradeoff, in view.">Measured throughput, response latency, sampled memory, and accuracy. Missing data stays missing.</PageHeading>
    {!result.perCandidate.length ? <EmptyState title="Choose a comparison group">{result.message}</EmptyState> : <>
      <div className="table-wrap"><table className="comparison-table"><caption>Candidate measurements · {state.options.applyRulings ? "rulings applied" : "original grades"}</caption><thead><tr><th scope="col">Model / quant</th><th scope="col">Generation<br />tokens/s</th><th scope="col">TTFT / TTFA<br />ms</th><th scope="col">Cold / warm<br />load ms</th><th scope="col">Memory<br />decimal GB</th><th scope="col">GPU<br />offload</th><th scope="col">Accuracy<br />Wilson 95%</th></tr></thead><tbody>{result.perCandidate.map((summary) => {
        const run = state.runs.find((r) => r.runId === summary.runId);
        const measurement = run?.candidates.find((c) => c.candidate.key === summary.key);
        const speed = aggregateSpeed(measurement?.speed ?? []);
        return <tr key={`${summary.runId}/${summary.key}`} className={summary.key === result.pick ? "picked-row" : ""}><th scope="row"><div className="model-name">{measurement?.candidate.tag ?? summary.key}</div><small className="mono">{summary.key}</small><div className="row-badges">{summary.key === result.pick && <Badge tone="teal">Selected</Badge>}<Badge>{run?.runtime ?? "unknown"}</Badge><Badge>{summary.status}</Badge>{summary.humanCorrected && <Badge tone="teal">human-corrected</Badge>}</div></th><td><strong>{number(summary.tokPerSec)}</strong><small>[{number(summary.speedRange?.lo ?? null)} – {number(summary.speedRange?.hi ?? null)}]</small></td><td>{number(speed.maxMedianTtftMs)} / {number(speed.maxMedianTtfaMs)}<small>Limit uses {summary.latencyMetric?.toUpperCase() ?? "unavailable"}</small></td><td>{number(speed.coldLoadMs)} / {number(speed.warmLoadMs)}</td><td>{number(summary.memoryGB, 2)}</td><td>{percent(summary.offload)}</td><td><strong>{percent(summary.accuracy)}</strong><small>{summary.correct} / {summary.n} · n = {summary.n}</small><small>{summary.wilson95 ? `${percent(summary.wilson95.lo)} – ${percent(summary.wilson95.hi)}` : "not measured"}</small></td></tr>;
      })}</tbody></table></div>
      <p className="footnote">— = not measured. Throughput is the minimum per-prompt median; brackets are descriptive speed bounds. Latencies are maximum per-prompt medians. Memory and offload are sampled /api/ps observations, not guaranteed peaks.</p>
      <div className="section-heading"><div><h2>Under each workload</h2><p>All prompt medians and spreads remain visible.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Candidate / prompt</th><th>Valid repeats</th><th>Median [min–max] tok/s</th><th>Latency ms</th><th>Spread</th></tr></thead><tbody>{result.perCandidate.flatMap((c) => c.perPrompt.map((p) => <tr key={`${c.runId}/${c.key}/${p.promptId}`}><th scope="row"><span className="mono">{c.key}</span><small>{p.promptId}</small></th><td>{p.validRepeats}</td><td>{number(p.medianTokPerSec)} [{number(p.minTokPerSec)}–{number(p.maxTokPerSec)}]</td><td>{number(p.medianLatencyMs)}</td><td>{percent(p.spread)}</td></tr>))}</tbody></table></div>
    </>}
  </>;
}
