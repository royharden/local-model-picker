# Deferred validation

**Construction complete - runtime unverified.** Dirty Mode allowed source and static syntax inspection only: no installs, tests, builds, product/CLI/eval/simulation execution, browser, services or network. The outer-folder tool (`node tools/syntax-check.mjs <inner repo>`) strips erasable TypeScript then uses `node --check`, and parses JSON; TSX is inspection-only. It does not resolve imports, check types or execute application logic. Every check below is **pending/unverified** until authorized activation after Dirty Mode closes. This final ledger incorporates Claude §6 and Codex §7 plus as-built boundaries.

Run from the inner repo root (`local-model-picker/`) unless stated otherwise.

## Whole repository

| What | Why deferred | Exact command / steps |
|---|---|---|
| Dependency install and lockfile | No installs in Dirty Mode; versions in `package.json` are chosen targets (D4), not verified compatibility | Select Node 22 (the `.nvmrc` target) with your version manager, then `npm install` once to create `package-lock.json`, review/retain it, and from then on `npm ci` |
| Type-check, core boundary (no DOM, no Node types) | tsc not installed | `npx tsc -p tsconfig.core.json` |
| Type-check, viewer | as above | `npx tsc -p tsconfig.app.json` |
| Type-check, CLI + scripts | as above | `npx tsc -p tsconfig.cli.json --noEmit` |
| Type-check, tests | as above | `npx tsc -p tsconfig.test.json` |
| All type-checks together | as above | `npm run typecheck` |
| Lint, including core purity rules (no `node:`/fs/react/cli imports; no `Date`, `fetch`, `process`, `performance`, `Math.random` in `src/core`) and held-out import isolation | eslint not installed | `npx eslint .` (same as `npm run lint`) |
| Unit and contract tests | vitest not installed | `npx vitest run` (same as `npm test`) |
| Viewer build | Vite not installed | `npm run build` (viewer only: type-check + `vite build` to `dist/`) |
| CLI build | as above | `npm run build:cli` (to `dist-cli/`), then `node dist-cli/cli/index.js --help` |
| Package subpath exports (`./runfile`, `./recommend`, `./evalkit`, `./providers`, `./hwprobe`) resolve after `build:cli` | needs a build | after `npm run build:cli`: `node -e "import('local-model-picker/evalkit').then(m => console.log(Object.keys(m)))"` from a scratch project that installs this folder, or inspect `dist-cli/` paths |
| Subpath export targets and `types` conditions | All source targets now exist; emitted declarations/JS and consumer resolution are unverified | After `npm run build:cli`, confirm every `types` and `default` path in `package.json` exists under `dist-cli/`; install this folder into an isolated scratch consumer, import all five subpaths, then `npx tsc --module nodenext --moduleResolution nodenext --noEmit consumer.ts` there |

## M1 contracts and helpers

| What | Why deferred | Exact command / steps |
|---|---|---|
| zod schemas accept valid run files and reject malformed ones (unknown `schemaVersion`, duplicate ids, non-finite numbers, ruling `seq` rules, status-discriminated candidates, flag consistency) | tests not run | `npx vitest run tests/contracts/schema.test.ts` |
| 10,000,000-byte boundary (exactly at cap accepted, one byte over rejected) | as above | same file, test "accepts a file of exactly 10,000,000 bytes" |
| `TextDecoder` is available globally where core runs (Node >= 20.11, browsers); core declares a minimal local type because `tsconfig.core.json` has no DOM/Node types | type-check and tests not run | `npx tsc -p tsconfig.core.json`; the schema test above exercises it |
| Statistics reference values: sign test 7 vs 1 = 9/256 (two-sided 18/256), 0 vs 0 = 1, 5 vs 0 = 1/32; Wilson 0/30, 15/30, 27/30, 30/30 against hand-computed values | tests not run | `npx vitest run tests/core/evalkit.test.ts` |
| Redaction removes home paths, host/user names, IPv4/IPv6 and leaves `3.14`, `1.2e3`, `1,200`, times untouched; `redact(redact(x)) === redact(x)` with literals such as `user`/`host`; terminal sanitiser strips C0/C1/ESC sequences | tests not run | `npx vitest run tests/core/redact.test.ts` |
| Stored `raw` may exceed 8,000 chars after redaction (bound `REDACTED_RAW_MAX_CHARS` = 32,000; per file 4 x `protocol.caps.rawChars`); `offloadFraction` consistency; ruling `originalCorrect` matches the graded item; `isoUtc` field ranges | tests not run | `npx vitest run tests/contracts/schema.test.ts` |
| Safe-command grammar refuses injected tags | tests not run | `npx vitest run tests/core/safe-command.test.ts` |
| Zod 3.23 API usage (`superRefine`, `discriminatedUnion` of `.strict()` objects, `.default()` on `Ruling.by`) | not type-checked | `npx tsc -p tsconfig.core.json` |

## Later milestones (from the final plans: Claude §6 and Codex §7 ledgers)

| Component | Assumption or skipped check | Later activation / check step |
|---|---|---|
| Item bank (M2) | As built `complete: true`, eighteen fetched rows plus originals; recorded provenance not independently rechecked | Review `data/items.v1.json` and `data/sources/fetched-20261024.json`, fetch exact cited rows/revisions after network activation and diff. A correction gets a new version/hash; do not silently edit frozen grader answers |
| Held-out graders (M2) | Frozen builder-written synthetic labels (F4), no score; proposed correctness agreement >= .95 and naive strictly worse; extraction/combined agreement reported separately | Once explicitly authorized: `npm run eval -- --confirm-heldout`; inspect named correctness/extraction misses and preserve the set. Nonempty JSONL blocks reruns. Interrupted execution needs audit before retry. Add independent untuned real responses separately after a live sweep |
| Grader cap order (M2) | Cap-then-redact-then-strip on real thinking models behaves as the fixture predicts | First live sweep with a thinking model; count `over_cap` / `unterminated_think` flags |
| Recommender (M3) | Fourteen specification scenarios, seventeen expanded cases; four methods' expected picks, known violations and tie reporting (F7) | `npx vitest run tests/core/scenarios.test.ts`; the single gated eval below writes four-method rows. These are not held-out selection accuracy; unmeasured estimate compliance is unknown |
| Simulation (M6) | n=30, seed 0x5332, 10000 trials/pair; .65/.62, .65/.55, .65/.65; independence omits correlation/shared difficulty | Single gated eval produces rates/counts/MCSE, or `npx tsx scripts/sim.ts` for simulation alone. Check post-hoc observed leader, positive-gap false tie/wrong-direction win, separate null false difference/unresolved definitions |
| Ollama protocol (M4) | Synthetic `fixtures/ollama/*` do not prove real API compatibility | Pin/record `ollama --version`; `npm run cli -- discover --runtime ollama --json`, then `npm run cli -- run --yes --runtime ollama --models INSTALLED_TAG --out live-out`. Diff actual tags/show/ps/version/stream shapes against synthetic fixtures; retain sanitized real fixtures separately |
| Latency (M4) | Client TTFT / time to first answer from streamed chunks; thinking detected via `message.thinking` or `<think>` | Live run with one thinking and one non-thinking model |
| Memory (M4) | `/api/ps` residency and `size_vram < size` semantics; Apple unified memory; sampling is not a guaranteed peak. Optional NVIDIA peak sampler omitted | Live sweep with an installed model larger than VRAM; compare raw `/api/ps` and `nvidia-smi` / Activity Monitor. `nvidiaPeakBytes` stays null; do not claim peak measurements |
| Unload (M4) | `keep_alive: 0` unloads only models this run loaded | Live: preload a model, run, confirm it is still resident afterwards |
| Probe (M4) | `nvidia-smi` / `system_profiler` formats; Windows CPU string; Apple unified and CPU-only unknowns | `npm run cli -- probe --runtime ollama --json` on Windows/NVIDIA, Mac if available, and CPU-only host; compare native tools and preserve unknowns |
| Fetch guard (M4) | Literal loopback, credentials, no DNS/redirect, localhost rewrite and remote-scope isolation | `npx vitest run tests/cli/fetch-guard.test.ts tests/cli/transport.test.ts`; then one live `npm run cli -- discover --runtime ollama --json` |
| CLI journey (M4) | Mock I/O, fake clock, dry-run zero inference/write, local JSON/report handoff | `npm run cli -- run` then `npm run cli -- run --yes --runtime mock --out out`; use its exact printed path as RUN_FILE: `npm run cli -- recommend RUN_FILE`, `npm run cli -- report RUN_FILE --out reports --md decision.md`. Pass multiple files explicitly, not a shell-dependent wildcard |
| Viewer (M5) | Render, cap, groups, MOCK/REMOTE, audit and downloads all unexecuted | Claim an agent-ports port, set LMP_VIEWER_PORT, then in PowerShell `npm run dev -- --host 127.0.0.1 --port $env:LMP_VIEWER_PORT --strictPort`. Load sample/import → compare → custom limits → ruling → JSON+Markdown → reimport all runs and reapply saved settings. JSON has no selection settings or embedded bank; unknown answers stay unknown |
| Remote mode (M4/M5) | One-collection remote groups, explicit GPU rule, banner, low confidence; never merge unknown servers | Contract tests for scope separation; a live check only if Roy has a second Ollama host, otherwise stays unverified |
| Live recommendation | No real measurements exist | Authorised serial sweep; sanitised file to `fixtures/real/` for the case study only (never used for tuning) |
| Bolt (M6) | Imports as a static Vite app; build passes in Bolt; preview cannot reach Ollama | Later authorised import under BOLT-HANDOFF "inspect and prepare only"; no backend to provision |
| Case study | "not yet measured" | Roy runs a live sweep |
| Jev | Not in the MVP | A separate later decision (dev decides, held-out confirms once, F12) |

## Focused activation commands and as-built risk checks

All rows remain pending. `RUN_FILE`, `INSTALLED_TAG`, `THINKING_TAG`, `NONTHINKING_TAG`, `REMOTE_URL` and `GROUP_KEY` below are operator-supplied placeholders, not literal values. Use only installed models and intended endpoints. No command below installs or starts Ollama. Probe/discover/run default to mock unless `--runtime ollama` is explicit; collection generation timeout is in **seconds** (`--timeout-gen 300`), not milliseconds.

| Check / ledger coverage | Exact command / controlled procedure |
|---|---|
| Graders and isolation; dev-only tests | `npx vitest run tests/core/graders.test.ts tests/core/heldout-isolation.test.ts` (does not score held-out) |
| Core aggregation, limits, deterministic order, invariants, group refusal, supersession, rulings | `npx vitest run tests/core/aggregate.test.ts tests/core/recommend.test.ts tests/core/estimate.test.ts tests/core/property.test.ts tests/core/scenarios.test.ts` |
| Statistics references, zero discordance, PRNG/split, report escaping | `npx vitest run tests/core/evalkit.test.ts tests/core/report.test.ts` |
| Protocol parsing: invalid/missing done, fragmented/capped stream, thinking, zero load versus zero generation | `npx vitest run tests/contracts/ollama-parse.test.ts tests/cli/transport.test.ts` |
| Import/write roundtrip, byte boundary, atomic publication/no clobber, report basename | `npx vitest run tests/contracts/schema.test.ts tests/cli/io.test.ts tests/cli/write-race.test.ts tests/cli/report.test.ts` |
| CLI dry run, fake fetch/clock, mock independence, cancellation/cleanup, probe commands | `npx vitest run tests/cli/run.test.ts tests/cli/hwprobe.test.ts tests/cli/recommend.test.ts` |
| Viewer imports, group selector, original/corrected, append-only ruling and exports | `npx vitest run tests/viewer/viewer.test.tsx`; then the manual browser journey above |
| Atomic hard-link filesystem behavior | On each intended output filesystem (including OneDrive if used), run a mock collection to a fresh `--out`, reimport its exact path, and run `npm run cli -- report RUN_FILE --out reports --md decision.md` twice: second attempt must refuse without changing bytes. Check unsupported hard-link filesystem fails explicitly without a rename fallback; inspect cleanup and concurrent-writer tests. Directory crash durability is not claimed |
| Controlled cancellation and partial-file recovery | `npm run cli -- run --yes --runtime ollama --models INSTALLED_TAG --out cancel-out`; press Ctrl-C during generation, confirm interrupted exit and a validated partial file where saving succeeds; import it, verify completed data retained, incomplete/skipped never picked. Repeat with owned and preloaded models; inspect remaining residency; do not fabricate a successful recovery |
| TTFT/TTFA and cap-before-strip | `npm run cli -- run --yes --runtime ollama --models THINKING_TAG,NONTHINKING_TAG --timeout-gen 300 --out thinking-out`; inspect structured/inline thinking, TTFT/TTFA, saved redacted raw and replayed grading, `over_cap`/`unterminated_think` counts |
| Unload ownership and concurrency | Preload an installed model in Ollama outside this tool; record `/api/ps`; run the live command above and compare residency afterwards. A preloaded model must remain. Verify owned cleanup separately and document concurrent interference; ownership inference is not a lock |
| Explicit remote mode (optional hardware prerequisite) | Only with an intended second host: `npm run cli -- run --yes --runtime ollama --allow-remote --host REMOTE_URL --models INSTALLED_TAG --out remote-out`; `npm run cli -- recommend RUN_FILE --accept-remote --constraint requireFullGpu=false`. Check REMOTE/low confidence, no local probe, unavailable estimate. Repeat in a separate collection and verify groups stay separate, even with mixed-hardware override |
| Custom constraints and group/ruling replay | `npm run cli -- recommend RUN_FILE --objective speed --constraint minAccuracy=0.6 --constraint requireFullGpu=false`; add `--group GROUP_KEY` if required. Compare `--ignore-rulings`. Keep Markdown, reapply objective/constraints/group/flags after JSON reimport; JSON alone carries no settings |
| Held-out execution boundary | `npm run eval` must refuse before loading responses. With an authorized empty results JSONL, run `npm run eval -- --confirm-heldout` once, retain output even on missed proposed target; a second attempt must refuse before loading. Do not delete/empty execution records. If interrupted, stop and document an audit decision before any retry |
| Evidence artifact integrity | Inspect `results/results.md` and each JSONL record after the single execution: named misses, split, all fourteen scenarios/seventeen cases/four methods, unavailable/unknown compliance, statistics tolerance, simulation definitions/MCSE, per-candidate synthetic wallClockMs and zero billed API cost. An interrupted pair of writes can disagree; stop for audit, never infer both are current |
| Case study and never-tuned real responses | After an authorized live sweep, inspect/redact its exact output, retain it separately in `fixtures/real/`, record hardware/runtime/protocol/settings and original/corrected/estimate choices; report case study separately. The default eval reads synthetic scenarios only and does not transform a live file into benchmark evidence |
| Bolt/static portability | After a separate source-transfer/import grant, use the exact inner source/revision, read `BOLT-HANDOFF.md`, inspect and prepare only. After activation, `npm ci` with retained lock and `npm run build`; verify sample/import browser journey. Native CLI is local; database/functions/auth/secrets not required |

No live sweep, external transfer or service startup is authorized by this ledger itself. Optional Jev remains outside the MVP. Numerical result cells and case-study claims must remain pending until the corresponding execution is recorded; a syntax pass is not acceptance of these checks.
