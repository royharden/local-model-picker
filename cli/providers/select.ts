// Runtime selection. The runtime is chosen ONLY by --runtime (default "mock"). A host (--host or
// OLLAMA_HOST) or an API key never switches it: with the mock runtime a given --host is ignored with a
// note, and OLLAMA_HOST is not even read. The ollama runtime goes through the fetch guard first.
import type { Item, ProtocolCaps, Runtime } from "../../src/core/index.js";
import type { CliContext } from "../context.js";
import { UsageError, parseIntOpt, stringOpt } from "../context.js";
import type { MonotonicClock } from "./clock.js";
import { DEFAULT_OLLAMA_HOST, resolveEndpoint } from "./fetch-guard.js";
import { createMockRuntime, MOCK_DEFAULT_SEED } from "./mock.js";
import type { MockServer } from "./mock.js";
import { createOllamaRuntime } from "./ollama.js";

export type RuntimeKind = "mock" | "ollama";

export interface RuntimeChoice {
  kind: RuntimeKind;
  runtime: Runtime;
  /** the clock chunk times are measured with (the mock's manual clock for mock runs) */
  clock: MonotonicClock;
  endpointKind: "mock" | "loopback" | "remote";
  remote: boolean;
  /** synthetic-data seed of the mock; null for ollama */
  mockSeed: number | null;
  mockServer: MockServer | null;
  notes: string[];
}

export function parseRuntimeKind(v: string | undefined): RuntimeKind {
  if (v === undefined || v === "mock") return "mock";
  if (v === "ollama") return "ollama";
  throw new UsageError(`--runtime must be "mock" or "ollama" (got "${v.slice(0, 40)}")`);
}

export function selectRuntime(
  values: Record<string, string | boolean | undefined>,
  ctx: CliContext,
  caps: ProtocolCaps,
  items: readonly Item[],
): RuntimeChoice {
  const kind = parseRuntimeKind(stringOpt(values["runtime"]));
  const host = stringOpt(values["host"]);
  const allowRemote = values["allow-remote"] === true;
  const notes: string[] = [];
  if (kind === "mock") {
    if (host !== undefined) notes.push("--host is ignored with the mock runtime (a host never switches runtime; pass --runtime ollama to measure a server)");
    if (allowRemote) notes.push("--allow-remote has no effect with the mock runtime");
    const mockSeed = parseIntOpt(stringOpt(values["mock-seed"]), "mock-seed", 0, 0xffffffff) ?? MOCK_DEFAULT_SEED;
    const mock = createMockRuntime({ seed: mockSeed, items, caps, timers: ctx.timers });
    return { kind, runtime: mock.runtime, clock: mock.clock, endpointKind: "mock", remote: false, mockSeed, mockServer: mock.server, notes };
  }
  if (values["mock-seed"] !== undefined) notes.push("--mock-seed has no effect with the ollama runtime");
  const raw = host ?? ctx.env["OLLAMA_HOST"] ?? DEFAULT_OLLAMA_HOST;
  const g = resolveEndpoint(raw, { allowRemote });
  if (!g.ok) throw new UsageError(g.message);
  if (g.endpointKind === "remote") notes.push("REMOTE endpoint: the local probe does not describe that server; results form their own remote-unknown group");
  const runtime = createOllamaRuntime({ baseUrl: g.baseUrl, fetch: ctx.fetch, clock: ctx.clock, caps, kind: "ollama", timers: ctx.timers });
  return {
    kind,
    runtime,
    clock: ctx.clock,
    endpointKind: g.endpointKind,
    remote: g.endpointKind === "remote",
    mockSeed: null,
    mockServer: null,
    notes,
  };
}
