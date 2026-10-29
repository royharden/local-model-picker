// Serial collector. Dry-run returns immediately after /api/tags and planning. Every generation,
// hardware probe, residency snapshot and write occurs after the explicit --yes boundary.
import * as path from "node:path";
import type { Candidate, CandidateRun, ChatRequest, ProcessEntry, Protocol, RedactOptions, RunFile, Runtime, RuntimeSignal, StreamCapture } from "../src/core/index.js";
import { DEFAULT_GENERATION, DEFAULT_PROTOCOL_CAPS, GRADER_VERSION, REDACTION_VERSION, SPEED_REPEATS, SPEED_WARMUPS, buildSpeedRepeat, collectAnswerText, gradeAnswer, redact, streamFailure } from "../src/core/index.js";
import type { CliContext } from "./context.js";
import { EXIT, RUNTIME_OPTIONS, TOOL_NAME, TOOL_VERSION, UsageError, parseCommandArgs, parseIntOpt, parseModelList, stringOpt } from "./context.js";
import { discoverCandidates, selectModels } from "./discover.js";
import { mockProbe, probeLocal, redactionLiterals } from "./hwprobe/index.js";
import { hashCanonical, remoteFingerprint } from "./hwprobe/fingerprint.js";
import type { BundledData } from "./io/read.js";
import { loadBundledData } from "./io/read.js";
import { buildRunPlan, formatPlan } from "./plan.js";
import type { MonotonicClock } from "./providers/clock.js";
import { runIdFromIso } from "./providers/clock.js";
import { describeError } from "./providers/errors.js";
import { selectRuntime } from "./providers/select.js";

export function makeProtocol(data: BundledData, values: Record<string, string | boolean | undefined>): Protocol {
  return {
    ...DEFAULT_GENERATION,
    seed: parseIntOpt(stringOpt(values["seed"]), "seed", -2147483648, 2147483647) ?? DEFAULT_GENERATION.seed,
    numCtx: parseIntOpt(stringOpt(values["num-ctx"]), "num-ctx", 1, 131072) ?? DEFAULT_GENERATION.numCtx,
    numPredict: parseIntOpt(stringOpt(values["num-predict"]), "num-predict", 1, 4096) ?? DEFAULT_GENERATION.numPredict,
    promptSetHash: hashCanonical(data.prompts), repeats: SPEED_REPEATS, warmups: SPEED_WARMUPS,
    redactionVersion: REDACTION_VERSION, itemSetComplete: data.bank.complete,
    caps: { ...DEFAULT_PROTOCOL_CAPS, genTimeoutMs: (parseIntOpt(stringOpt(values["timeout-gen"]), "timeout-gen", 1, 3600) ?? 300) * 1000 },
  };
}

/** Capture only in memory; unredacted content/thinking is never serialized or printed. */
export async function captureStream(runtime: Runtime, request: ChatRequest, clock: MonotonicClock, signal: RuntimeSignal, redaction: RedactOptions): Promise<StreamCapture> {
  const chunks: StreamCapture["chunks"][number][] = [];
  const startMs = clock.nowMs();
  let transportError: string | null = null;
  try { for await (const chunk of runtime.chatStream(request, signal)) chunks.push(chunk); }
  catch (e) { transportError = redact(describeError(e), redaction).slice(0, 400); }
  return { startMs, chunks, transportError };
}

function sameModel(entry: ProcessEntry, candidate: Candidate): boolean {
  return entry.name === candidate.tag && entry.digest === candidate.digest;
}

/** Both tag and digest are checked; digest aliases and preexisting tags are never owned. */
export function canUnload(candidate: Candidate, initial: readonly ProcessEntry[] | null, loadedByRun: boolean, current: readonly ProcessEntry[]): boolean {
  return initial !== null && loadedByRun &&
    !initial.some((p) => p.name === candidate.tag || p.digest === candidate.digest) &&
    current.filter((p) => p.digest === candidate.digest || p.name === candidate.tag).length === 1 &&
    current.some((p) => sameModel(p, candidate));
}

export interface CollectInput {
  run: RunFile;
  /** Unredacted discovery identities used only for requests and process matching. */
  requestCandidates: readonly Candidate[];
  data: BundledData;
  runtime: Runtime;
  clock: MonotonicClock;
  signal: AbortSignal;
  metadataRedaction: RedactOptions;
  answerRedaction: RedactOptions;
  timers: CliContext["timers"];
}

/** Mutates the draft run in place so any interruption retains every completed record. */
export async function collectRun(input: CollectInput): Promise<RunFile> {
  const { run, runtime, signal, clock } = input;
  const warn = (message: string): void => {
    const text = redact(message, input.metadataRedaction).slice(0, 500);
    if (!run.warnings.includes(text) && run.warnings.length < 190) run.warnings.push(text);
  };
  let initial: ProcessEntry[] | null = null;
  try { initial = await runtime.processStatus(signal); }
  catch (e) { warn(`initial residency unavailable; owned cleanup disabled: ${describeError(e)}`); }
  const settings = { temperature: 0, seed: run.protocol.seed, num_ctx: run.protocol.numCtx, num_predict: run.protocol.numPredict };

  for (let i = 0; i < run.candidates.length; i++) {
    const row = run.candidates[i];
    const candidate = input.requestCandidates[i];
    if (row === undefined || candidate === undefined) continue;
    if (signal.aborted) break; // prefilled remaining rows stay skipped
    const started = clock.nowMs();
    row.status = "incomplete";
    row.statusReason = "collection in progress";
    let failed = false;
    let firstSuccessfulLoad = false;
    let firstObservation = true;
    const observe = async (): Promise<void> => {
      try {
        const resident = await runtime.processStatus(signal);
        const matching = resident.filter((p) => p.digest === candidate.digest);
        const exact = matching.find((p) => sameModel(p, candidate));
        if (firstSuccessfulLoad && exact !== undefined && initial !== null && !initial.some((p) => p.name === candidate.tag || p.digest === candidate.digest)) row.loadedByRun = true;
        if (matching.length !== 1) { warn("residency missing or ambiguous for one candidate; memory sample unavailable"); return; }
        const entry = matching[0];
        if (entry === undefined || entry.sizeVramBytes === null) { warn("size_vram was not reported; memory/offload sample unavailable (unknown, not zero)"); return; }
        row.memory.push({ phase: firstObservation ? "after-load" : "after-repeat", sizeBytes: entry.sizeBytes, sizeVramBytes: entry.sizeVramBytes,
          offloadFraction: entry.sizeBytes > 0 && entry.sizeVramBytes <= entry.sizeBytes ? entry.sizeVramBytes / entry.sizeBytes : null, source: "api/ps" });
        firstObservation = false;
      } catch (e) { if (!signal.aborted) warn(`residency sample unavailable: ${describeError(e)}`); }
    };
    try {
      speed: for (const prompt of input.data.prompts.prompts) {
        for (let repeat = 0; repeat <= SPEED_REPEATS; repeat++) {
          if (signal.aborted) break speed;
          const capture = await captureStream(runtime, { model: candidate.tag, messages: prompt.messages, options: settings, keepAlive: "5m" }, clock, signal, input.metadataRedaction);
          const record = buildSpeedRepeat(prompt.id, repeat, capture);
          if (record.invalidReason !== null) record.invalidReason = redact(record.invalidReason, input.metadataRedaction).slice(0, 500);
          row.speed.push(record);
          if (!record.valid) failed = true;
          if (capture.chunks.some((c) => c.type === "done") && streamFailure(capture) === null) firstSuccessfulLoad = true;
          if (!signal.aborted) await observe();
        }
      }
      for (const item of input.data.bank.items) {
        if (signal.aborted) break;
        const capture = await captureStream(runtime, { model: candidate.tag, messages: [{ role: "user", content: item.prompt }], options: settings, keepAlive: "5m" }, clock, signal, input.metadataRedaction);
        const failure = streamFailure(capture);
        if (failure !== null) { failed = true; warn(`one eval item was not completed: ${failure}`); continue; }
        // D9: structured thinking excluded; cap -> redact -> think stripping -> grade.
        row.items.push(gradeAnswer(item, collectAnswerText(capture.chunks), input.answerRedaction));
      }
      const complete = !failed && !signal.aborted && row.speed.length === input.data.prompts.prompts.length * (SPEED_WARMUPS + SPEED_REPEATS) && row.items.length === run.itemIds.length;
      row.status = complete ? "measured" : "incomplete";
      row.statusReason = complete ? null : signal.aborted ? "interrupted; completed records retained" : "one or more generation requests were invalid or incomplete";
    } catch (e) {
      row.status = row.speed.length || row.items.length ? "incomplete" : "failed";
      row.statusReason = redact(`collection failed: ${describeError(e)}`, input.metadataRedaction).slice(0, 500);
    } finally {
      row.wallClockMs = Math.max(0, clock.nowMs() - started);
      // A separate bounded signal permits safe cleanup after Ctrl-C; never use global cleanup.
      const cleanup = new AbortController();
      const timer = input.timers.setTimeout(() => cleanup.abort(), run.protocol.caps.metadataTimeoutMs);
      try {
        if (row.loadedByRun) {
          const current = await runtime.processStatus(cleanup.signal);
          if (canUnload(candidate, initial, row.loadedByRun, current)) {
            const cap = await captureStream(runtime, { model: candidate.tag, messages: [], options: null, keepAlive: 0 }, clock, cleanup.signal, input.metadataRedaction);
            const failure = streamFailure(cap);
            if (failure !== null) warn(`owned model unload did not complete: ${failure}`);
          } else warn("owned cleanup skipped: residency ownership absent or ambiguous");
        }
      } catch (e) { warn(`owned cleanup skipped: ${describeError(e)}`); }
      finally { input.timers.clearTimeout(timer); }
    }
  }
  if (signal.aborted) {
    run.flags.push("interrupted");
    for (const row of run.candidates) if (row.status === "skipped") row.statusReason = "not started: collection interrupted";
  }
  return run;
}

export async function runCommand(argv: string[], ctx: CliContext): Promise<number> {
  const args = parseCommandArgs(argv, { ...RUNTIME_OPTIONS, yes: { type: "boolean", default: false }, models: { type: "string" }, out: { type: "string" }, seed: { type: "string" }, "num-ctx": { type: "string" }, "num-predict": { type: "string" }, "timeout-gen": { type: "string" } });
  if (args.positionals.length) throw new UsageError("run takes no positional arguments");
  const data = await loadBundledData(ctx.dataDir);
  const protocol = makeProtocol(data, args.values);
  const choice = selectRuntime(args.values, ctx, protocol.caps, data.bank.items);
  const createdAt = ctx.wall.nowIso();
  const runId = runIdFromIso(createdAt);
  const outDir = path.resolve(ctx.cwd, stringOpt(args.values["out"]) ?? "out");
  const installed = await choice.runtime.listModels(ctx.signal); // sole permitted live dry-run request
  const selected = selectModels(installed, parseModelList(stringOpt(args.values["models"])));
  if (!selected.ok) throw new UsageError(selected.message);
  const plan = buildRunPlan({ runtime: choice.kind, endpointKind: choice.endpointKind, models: selected.models, itemCount: data.bank.items.length, promptIds: data.prompts.prompts.map((p) => p.id), protocol, outDir, outFile: path.join(outDir, `${runId}.json`) });
  for (const note of choice.notes) ctx.printErr(`note: ${note}`);
  for (const line of formatPlan(plan)) ctx.print(line);
  if (args.values["yes"] !== true) { ctx.print("Dry-run: pass --yes to collect and save this plan."); return EXIT.ok; }
  if (plan.refusals.length) return EXIT.failure;
  const redaction = choice.kind === "mock" || choice.remote ? { answers: {}, metadata: {} } : redactionLiterals(ctx.os);
  const found = await discoverCandidates(choice.runtime, selected.models, ctx.signal, redaction.metadata);
  if (found.candidates.length !== selected.models.length) { ctx.printErr("error: discovery identities were unusable; nothing collected or written"); return EXIT.failure; }
  const probe = choice.kind === "mock" ? mockProbe(ctx.wall) : choice.remote ? {
    fingerprint: remoteFingerprint(runId), availableMemory: { vramFreeBytes: null, ramFreeBytes: null, source: "unavailable" as const, at: createdAt }, warnings: [],
  } : await probeLocal({ os: ctx.os, exec: ctx.exec, wall: ctx.wall, redaction: redaction.metadata });
  let ollamaVersion: string | null = null;
  const warnings = [...found.warnings, ...probe.warnings];
  try { ollamaVersion = await choice.runtime.version(ctx.signal); if (ollamaVersion !== null) ollamaVersion = redact(ollamaVersion, redaction.metadata); }
  catch (e) { warnings.push(redact(`runtime version unavailable: ${describeError(e)}`, redaction.metadata)); }
  const requestCandidates = found.candidates.map((entry) => entry.candidate);
  const candidates: CandidateRun[] = requestCandidates.map((candidate) => ({ candidate, status: "skipped", statusReason: "not started", speed: [], memory: [], nvidiaPeakBytes: null, items: [], wallClockMs: 0, loadedByRun: false }));
  const run: RunFile = { schemaVersion: 1, runId, createdAt, tool: { name: TOOL_NAME, version: TOOL_VERSION }, runtime: choice.kind, synthetic: choice.kind === "mock", seed: choice.mockSeed, remote: choice.remote, endpointKind: choice.endpointKind, runtimeInfo: { ollamaVersion }, fingerprint: probe.fingerprint, availableMemory: probe.availableMemory, itemSetHash: hashCanonical(data.bank), itemIds: data.bank.items.map((item) => item.id), graderVersion: GRADER_VERSION, protocol, protocolHash: hashCanonical(protocol), flags: [], warnings, candidates, rulings: [] };
  await collectRun({ run, requestCandidates, data, runtime: choice.runtime, clock: choice.clock, signal: ctx.signal, metadataRedaction: redaction.metadata, answerRedaction: redaction.answers, timers: ctx.timers });
  // Redact discovery metadata only after requests: a private tag is still addressed by its original name.
  for (const row of run.candidates) {
    const c = row.candidate;
    c.tag = redact(c.tag, redaction.metadata).slice(0, 300); c.key = `${c.tag}@${c.digest.slice(0, 12)}`;
    if (c.family !== null) c.family = redact(c.family, redaction.metadata).slice(0, 100);
    if (c.parameterSize !== null) c.parameterSize = redact(c.parameterSize, redaction.metadata).slice(0, 50);
    if (c.quantization !== null) c.quantization = redact(c.quantization, redaction.metadata).slice(0, 50);
  }
  const saved = await ctx.writeRun(run, outDir);
  if (!saved.ok) { ctx.printErr(`error: ${saved.message}`); for (const issue of saved.issues.slice(0, 8)) ctx.printErr(`${issue.path}: ${issue.message}`); return EXIT.failure; }
  ctx.print(`Saved ${saved.path} (${saved.bytes} bytes)${ctx.signal.aborted ? " — partial interrupted run" : ""}`);
  return ctx.signal.aborted ? EXIT.interrupted : run.candidates.some((c) => c.status !== "measured") ? EXIT.failure : EXIT.ok;
}
