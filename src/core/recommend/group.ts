// Comparison groups (Claude §2.6 step 1, D16, D21). Group key = runtime + endpointKind +
// itemSetHash + graderVersion + protocolHash + fingerprint hash (which includes scopeId; scopeId is
// also spelled out so two remote collections never share a key). Only one group is ever compared.
// allowMixedHardware relaxes ONLY the fingerprint part and only for local-probe fingerprints
// (the part becomes "mixed"); never runtime, protocol, items or graders, never remote or mock scopes.
import type { RunFile } from "../schema/runfile.js";
import type { GroupInfo } from "../schema/result.js";

export const MIXED_HARDWARE = "mixed";

export interface GroupKeyParts {
  runtime: string;
  endpoint: string;
  items: string;
  graders: string;
  protocol: string;
  hardware: string;
}

/** True when allowMixedHardware may relax this run's fingerprint (local-probe only). */
export function canMixHardware(run: RunFile): boolean {
  return run.fingerprint.source === "local-probe" && !run.remote;
}

export function groupKeyParts(run: RunFile, allowMixedHardware: boolean): GroupKeyParts {
  const fp = run.fingerprint;
  const hardware = allowMixedHardware && canMixHardware(run) ? MIXED_HARDWARE : `${fp.source}:${fp.hash}:${fp.scopeId ?? "-"}`;
  return {
    runtime: run.runtime,
    endpoint: run.endpointKind,
    items: run.itemSetHash,
    graders: run.graderVersion,
    protocol: run.protocolHash,
    hardware,
  };
}

export function groupKeyOf(run: RunFile, allowMixedHardware: boolean): string {
  const p = groupKeyParts(run, allowMixedHardware);
  return `runtime=${p.runtime};endpoint=${p.endpoint};items=${p.items};graders=${p.graders};protocol=${p.protocol};hardware=${p.hardware}`;
}

/** Names of the key parts in which two runs differ (for "incompatible" trace lines). */
export function groupDifferences(a: RunFile, b: RunFile, allowMixedHardware: boolean): string[] {
  const pa = groupKeyParts(a, allowMixedHardware);
  const pb = groupKeyParts(b, allowMixedHardware);
  const out: string[] = [];
  if (pa.runtime !== pb.runtime) out.push("runtime");
  if (pa.endpoint !== pb.endpoint) out.push("endpoint kind");
  if (pa.items !== pb.items) out.push("item set");
  if (pa.graders !== pb.graders) out.push("grader version");
  if (pa.protocol !== pb.protocol) out.push("protocol");
  if (pa.hardware !== pb.hardware) out.push("hardware fingerprint");
  return out;
}

export interface RunGroup {
  key: string;
  /** Runs of this group in input order. */
  runs: RunFile[];
  info: GroupInfo;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Partition runs into comparison groups, sorted by key. Does not mutate the input. */
export function groupRuns(runs: readonly RunFile[], allowMixedHardware: boolean): RunGroup[] {
  const byKey = new Map<string, RunFile[]>();
  for (const run of runs) {
    const key = groupKeyOf(run, allowMixedHardware);
    const list = byKey.get(key) ?? [];
    list.push(run);
    byKey.set(key, list);
  }
  const keys = [...byKey.keys()].sort(cmpStr);
  return keys.map((key) => {
    const list = byKey.get(key) ?? [];
    const first = list[0] as RunFile;
    const parts = groupKeyParts(first, allowMixedHardware);
    const info: GroupInfo = {
      key,
      runIds: [...new Set(list.map((r) => r.runId))].sort(cmpStr),
      candidateCount: list.reduce((n, r) => n + r.candidates.length, 0),
      runtime: first.runtime,
      endpointKind: first.endpointKind,
      fingerprintHash: parts.hardware === MIXED_HARDWARE ? MIXED_HARDWARE : first.fingerprint.hash,
    };
    return { key, runs: list, info };
  });
}
