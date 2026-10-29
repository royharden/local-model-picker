import { readFileSync } from "node:fs";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../src/App.js";
import Audit from "../../src/pages/Audit.js";
import Recommend from "../../src/pages/Recommend.js";
import { ViewerProvider, useViewer } from "../../src/state/ViewerContext.js";
import { appendRuling, downloadText, importLocalFile, initialState, prepareJsonExport, prepareMarkdownExport, viewerReducer } from "../../src/state/model.js";
import { DEFAULT_SELECTION_OPTIONS, RUN_FILE_MAX_BYTES, RunFileSchema, defaultConstraints, readRunFile, recommend } from "../../src/core/index.js";
import type { RunFile } from "../../src/core/index.js";

const sample = (file = "human-correction.json"): RunFile => RunFileSchema.parse(JSON.parse(readFileSync(new URL(`../../public/samples/${file}`, import.meta.url), "utf8")));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function Seed({ run }: { run: RunFile }) {
  const { dispatch } = useViewer();
  useEffect(() => { dispatch({ type: "import", run }); }, [dispatch, run]);
  return null;
}
function seeded(run: RunFile, child: ReactNode) { return render(<ViewerProvider><Seed run={run} />{child}</ViewerProvider>); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.location.hash = ""; });

describe("viewer import and immutable evidence", () => {
  it("refuses an oversized browser file before it can be read, and reports schema paths", async () => {
    const arrayBuffer = vi.fn<() => Promise<ArrayBuffer>>();
    const result = await importLocalFile({ size: RUN_FILE_MAX_BYTES + 1, arrayBuffer });
    expect(result.ok).toBe(false);
    expect(arrayBuffer).not.toHaveBeenCalled();
    if (!result.ok) expect(result.errors[0]?.path).toBe("file.size");
    const raw = bytes({ schemaVersion: 9 });
    const invalid = await importLocalFile({ size: raw.length, arrayBuffer: async () => raw.buffer as ArrayBuffer });
    if (invalid.ok) throw new Error("unsupported schema accepted");
    expect(invalid.errors[0]?.path).toBe("schemaVersion");
  });
  it("deduplicates identical run IDs and preserves evidence when identities conflict", () => {
    const run = sample();
    const imported = viewerReducer(initialState, { type: "import", run });
    const duplicate = viewerReducer(imported, { type: "import", run: structuredClone(run) });
    expect(duplicate.runs).toBe(imported.runs);
    expect(duplicate.notice).toContain("already imported");
    const changed = { ...run, warnings: [...run.warnings, "different evidence"] };
    const conflict = viewerReducer(imported, { type: "import", run: changed });
    expect(conflict.runs[0]).toBe(run);
    expect(conflict.notice).toContain("different contents");
    expect(initialState.runs).toEqual([]);
  });
  it("validates all three relabelled samples and their consistent mock identity", () => {
    const runs = [sample("quality-tradeoff.json"), sample("tied-within-noise.json"), sample()];
    expect(new Set(runs.map((run) => run.fingerprint.hash)).size).toBe(1);
    for (const run of runs) { expect(run.runtime).toBe("mock"); expect(run.endpointKind).toBe("mock"); expect(run.synthetic).toBe(true); expect(run.fingerprint.source).toBe("mock"); expect(run.fingerprint.scopeId).toBe("mock-v1"); }
  });
});

describe("rulings and portable exports", () => {
  it("appends the next sequence with a validated reason and preserves original grades", () => {
    const run = sample();
    const previous = run.rulings.at(-1)!;
    const before = JSON.stringify(run);
    const draft = { candidateKey: previous.candidateKey, itemId: previous.itemId, overrideCorrect: !previous.overrideCorrect,
      reason: "Reviewed the saved answer against the item contract.", correctedExtraction: null, at: "2026-10-24T19:00:00.000Z" };
    expect(appendRuling(run, { ...draft, reason: "   " }).ok).toBe(false);
    expect(appendRuling(run, { ...draft, reason: "x".repeat(501) }).ok).toBe(false);
    const next = appendRuling(run, draft);
    if (!next.ok) throw new Error(JSON.stringify(next.errors));
    const ruling = next.value.rulings.at(-1)!;
    expect(ruling.seq).toBe(previous.seq + 1);
    expect(ruling.previousRulingId).toBe(previous.id);
    expect(next.value.candidates).toEqual(run.candidates);
    expect(JSON.stringify(run)).toBe(before);
  });
  it("exports and re-imports JSON with rulings and reproduces both s14 picks", () => {
    const run = sample();
    const constraints = defaultConstraints("quality");
    const decisions = (r: RunFile) => [false, true].map((applyRulings) => recommend([r], constraints, { ...DEFAULT_SELECTION_OPTIONS, applyRulings }));
    const before = decisions(run);
    expect(before[0]?.pick).not.toBe(before[1]?.pick);
    const exported = prepareJsonExport(run);
    if (!exported.ok) throw new Error(JSON.stringify(exported.errors));
    const imported = readRunFile(new TextEncoder().encode(exported.value));
    if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
    expect(imported.value.rulings).toEqual(run.rulings);
    expect(decisions(imported.value)).toEqual(before);
  });
  it("redacts export copies and produces escaped Markdown with safe response fences", () => {
    const run = sample();
    run.warnings.push("<img src=x> | C:\\Users\\someone\\private at 192.168.1.5");
    run.candidates[0]!.items[0]!.raw = "``````\n<script>data</script>\n\u001b[2J";
    const before = JSON.stringify(run);
    const json = prepareJsonExport(run);
    if (!json.ok) throw new Error(JSON.stringify(json.errors));
    expect(json.value).not.toContain("someone");
    expect(json.value).not.toContain("192.168.1.5");
    const report = prepareMarkdownExport([run], defaultConstraints("quality"), DEFAULT_SELECTION_OPTIONS);
    if (!report.ok) throw new Error(JSON.stringify(report.errors));
    expect(report.value).toContain("&lt;img src\\=x&gt;");
    expect(report.value).toContain("```````\n``````\n<script>data</script>");
    expect(report.value).not.toContain("\u001b");
    expect(JSON.stringify(run)).toBe(before);
  });
  it("downloads a Blob and revokes its URL after the browser handoff", () => {
    vi.useFakeTimers();
    const create = vi.fn<(blob: Blob) => string>(() => "blob:local-export"); const revoke = vi.fn<(url: string) => void>();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    try { downloadText("evidence", "run.json", "application/json"); expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob); expect(document.querySelector("a[download]")).toBeNull(); vi.runAllTimers(); expect(revoke).toHaveBeenCalledWith("blob:local-export"); }
    finally { if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor); else Reflect.deleteProperty(URL, "createObjectURL"); if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor); else Reflect.deleteProperty(URL, "revokeObjectURL"); vi.useRealTimers(); }
  });
});

describe("viewer evidence journeys", () => {
  it("shows path-level import errors in the actual file input flow", async () => {
    render(<App />);
    const raw = bytes({ schemaVersion: 99 });
    const file = new File([raw], "future.json", { type: "application/json" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => raw.buffer });
    fireEvent.change(screen.getByLabelText("Import run files"), { target: { files: [file] } });
    await screen.findByRole("alert");
    expect(screen.getByText("future.json: schemaVersion")).toBeTruthy();
  });
  it("shows full filter evidence and original/corrected views", async () => {
    seeded(sample(), <Recommend />);
    await screen.findByRole("heading", { name: "Why not the others?" });
    fireEvent.change(screen.getByRole("spinbutton", { name: /Minimum tokens/ }), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply limits →" }));
    await waitFor(() => expect(screen.getAllByText("No candidate fits").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Measured").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Limit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Source").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Original grades" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Rulings applied" })).toBeTruthy();
  });
  it("renders hostile raw text safely and appends a ruling through the audit form", async () => {
    const run = sample(); run.candidates[0]!.items[0]!.raw = "<img src=x onerror=alert(1)> ``` response";
    seeded(run, <Audit />);
    await screen.findByText("<img src=x onerror=alert(1)> ``` response");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/Unavailable: this run's item-bank contract/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ruling reason"), { target: { value: "Manual review of the saved response." } });
    fireEvent.click(screen.getByRole("button", { name: "Append ruling →" }));
    await screen.findByText("Sequence 7");
    expect(screen.getByText("Manual review of the saved response.")).toBeTruthy();
  });
  it("exposes group selection and keeps MOCK and REMOTE warnings tied to the selected group", async () => {
    render(<App />);
    const mock = sample();
    const remote = structuredClone(mock);
    remote.runId = "remote-import"; remote.rulings = []; remote.runtime = "ollama"; remote.remote = true; remote.endpointKind = "remote";
    remote.availableMemory = { source: "unavailable", vramFreeBytes: null, ramFreeBytes: null, at: remote.createdAt };
    remote.fingerprint = { source: "remote-unknown", scopeId: remote.runId, cpuModel: null, cpuThreads: null, ramBytes: null, os: null,
      gpu: { vendor: "unknown", name: null, vramTotalBytes: null, unifiedMemory: null },
      canonical: { source: "remote-unknown", scopeId: remote.runId, cpuModel: null, cpuThreads: null, ramGiB: null, platform: null, gpuVendor: "unknown", gpuName: null, vramGiB: null }, hash: "123456789abc" };
    const files = [mock, remote].map((run) => { const raw = bytes(run); const file = new File([raw], `${run.runId}.json`); Object.defineProperty(file, "arrayBuffer", { value: async () => raw.buffer }); return file; });
    fireEvent.change(screen.getByLabelText("Import run files"), { target: { files } });
    const select = await screen.findByRole("combobox", { name: "Comparison group" });
    expect(screen.getByText("MOCK DATA")).toBeTruthy();
    expect(screen.getByText(/These measurements describe the remote server/)).toBeTruthy();
    const remoteOption = Array.from(select.querySelectorAll("option")).find((option) => option.textContent?.includes("ollama / remote"));
    expect(remoteOption).toBeTruthy();
    fireEvent.change(select, { target: { value: remoteOption!.value } });
    await waitFor(() => expect(screen.queryByText("MOCK DATA")).toBeNull());
    expect(screen.getByText(/These measurements describe the remote server/)).toBeTruthy();
  });
});
