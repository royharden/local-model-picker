import { useEffect, useState } from "react";
import { ViewerProvider, useViewer } from "./state/ViewerContext.js";
import { Badge } from "./components/Primitives.js";
import Runs from "./pages/Runs.js";
import Compare from "./pages/Compare.js";
import Recommend from "./pages/Recommend.js";
import Audit from "./pages/Audit.js";
import Export from "./pages/Export.js";

const tabs = [
  { id: "runs", title: "Runs", icon: "▤", subtitle: "Import & explore" },
  { id: "compare", title: "Compare", icon: "⊞", subtitle: "Measure the tradeoffs" },
  { id: "recommend", title: "Recommend", icon: "↗", subtitle: "Find your fit" },
  { id: "audit", title: "Audit", icon: "◎", subtitle: "Inspect the evidence" },
  { id: "export", title: "Export", icon: "↓", subtitle: "Keep your work" },
] as const;
type TabId = typeof tabs[number]["id"];
function readTab(): TabId { const id = window.location.hash.slice(1); return tabs.find((tab) => tab.id === id)?.id ?? "runs"; }

function Workspace() {
  const { state, dispatch, groups, result, selectedRuns } = useViewer();
  const [tab, setTab] = useState<TabId>(readTab);
  useEffect(() => { const change = () => { if (tabs.some((entry) => entry.id === window.location.hash.slice(1))) setTab(readTab()); }; window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  const shownRuns = result.group ? selectedRuns : state.runs;
  const mock = shownRuns.some((run) => run.runtime === "mock");
  const remote = shownRuns.some((run) => run.remote);
  const synthetic = shownRuns.some((run) => run.synthetic && run.runtime !== "mock");
  const candidateCount = state.runs.reduce((count, run) => count + run.candidates.length, 0);
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar"><a className="brand" href="#runs" aria-label="Local Model Picker home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Local Model<span className="brand-second">Picker<span className="brand-dot">.</span></span></span></a><div className="sidebar-kicker">MEASURE. COMPARE. DECIDE.</div><nav aria-label="Main navigation">{tabs.map((entry, i) => <a key={entry.id} href={`#${entry.id}`} className={tab === entry.id ? "nav-link active" : "nav-link"} aria-current={tab === entry.id ? "page" : undefined}><span className="nav-icon" aria-hidden="true">{entry.icon}</span><span><strong>{entry.title}</strong><small>{entry.subtitle}</small></span><span className="nav-number">0{i + 1}</span></a>)}</nav><div className="sidebar-bottom"><span className="online-dot" />Local-first. Evidence-led.<p>Saved runs in. Clear choices out.</p><span className="sidebar-version">LOCAL MODEL PICKER / v0.1</span></div></aside>
    <div className="workspace"><header className="topbar"><div><span className="breadcrumb">Workspace <span>/</span> <strong>{tabs.find((entry) => entry.id === tab)?.title}</strong></span></div><div className="topbar-right"><span className="session-dot" /><span>In-memory session</span><Badge>{state.runs.length} runs</Badge></div></header><main id="main-content" tabIndex={-1}>
      {state.runs.length > 0 && <section className="workspace-context" aria-label="Comparison context"><div className="workspace-stats"><strong>{candidateCount}</strong> candidate records <span> / </span><strong>{groups.length}</strong> comparison {groups.length === 1 ? "group" : "groups"}</div>{groups.length > 1 && <label className="group-select"><span>Comparison group</span><select aria-label="Comparison group" value={state.options.groupKey ?? ""} onChange={(e) => dispatch({ type: "config", constraints: state.constraints, options: { ...state.options, groupKey: e.target.value || null } })}><option value="">Choose a compatible group…</option>{groups.map((group, index) => <option key={group.key} value={group.key}>{index + 1}. {group.info.runtime} / {group.info.endpointKind} · {group.info.fingerprintHash} · {group.info.runIds.join(", ")}</option>)}</select></label>}</section>}
      {mock && <div className="banner mock-banner" role="status"><Badge tone="amber">MOCK DATA</Badge><span>Synthetic examples, not hardware measurements. Use your own measured run for a real decision.</span></div>}
      {remote && <div className="banner remote-banner" role="status"><Badge tone="amber">REMOTE</Badge><span>These measurements describe the remote server. Local hardware is unknown; explicit remote acceptance and GPU settings are required.</span></div>}
      {synthetic && <div className="banner mock-banner"><Badge tone="amber">SYNTHETIC</Badge><span>Scenario data. These records are not a hardware measurement.</span></div>}
      {groups.length > 1 && !state.options.groupKey && <p className="group-message">These files form separate measurement contracts. Select a group above to compare compatible runs.</p>}
      {state.notice && <p className="session-notice" role="status">{state.notice}</p>}
      {tab === "runs" && <Runs />}{tab === "compare" && <Compare />}{tab === "recommend" && <Recommend />}{tab === "audit" && <Audit />}{tab === "export" && <Export />}
      <footer className="workspace-footer"><span>Built around your evidence.</span><span>No telemetry · No model downloads · No cloud inference</span></footer>
    </main></div></div>;
}
export default function App() { return <ViewerProvider><Workspace /></ViewerProvider>; }
