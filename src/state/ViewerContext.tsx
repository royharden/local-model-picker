import { createContext, useContext, useMemo, useReducer } from "react";
import type { Dispatch, ReactNode } from "react";
import { groupRuns, recommend } from "../core/index.js";
import { initialState, viewerReducer } from "./model.js";
import type { ViewerAction, ViewerState } from "./model.js";

function useViewerState() {
  const [state, dispatch] = useReducer(viewerReducer, initialState);
  const groups = useMemo(() => groupRuns(state.runs, state.options.allowMixedHardware), [state.runs, state.options.allowMixedHardware]);
  // Both views are always derived independently from original grades and the append-only log.
  const original = useMemo(() => recommend(state.runs, state.constraints, { ...state.options, applyRulings: false }), [state.runs, state.constraints, state.options]);
  const corrected = useMemo(() => recommend(state.runs, state.constraints, { ...state.options, applyRulings: true }), [state.runs, state.constraints, state.options]);
  const result = state.options.applyRulings ? corrected : original;
  const selectedRuns = state.runs.filter((run) => result.group?.runIds.includes(run.runId));
  return { state, dispatch, groups, original, corrected, result, selectedRuns };
}
type ViewerContextValue = ReturnType<typeof useViewerState>;
const ViewerContext = createContext<ViewerContextValue | null>(null);
export function ViewerProvider({ children }: { children: ReactNode }) {
  const value = useViewerState();
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}
export function useViewer(): ViewerContextValue {
  const value = useContext(ViewerContext);
  if (!value) throw new Error("Viewer components require ViewerProvider");
  return value;
}
export type { Dispatch, ViewerAction, ViewerState };
