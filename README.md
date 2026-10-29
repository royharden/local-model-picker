# Local Model Picker

When the mini-eval cannot distinguish installed Ollama models or quants, Local Model Picker says **tied within noise** and selects the faster candidate. It also shows what an **estimate-only** weights-and-free-memory rule would pick, alongside fastest-only and accuracy-only baselines. A tie is failure to distinguish, not proof of equivalent quality.

**Status: construction complete - runtime unverified.** Source, fixtures, test sources, evaluation scripts and the static viewer are constructed. Dependencies have not been installed; type-checks, lint, tests, builds, CLI collection, evaluation, simulation and browser journeys have not run. Static syntax inspection is not runtime validation. Every numeric outcome in [results/results.md](results/results.md) is **pending**, and [results/results.jsonl](results/results.jsonl) is empty. Case study: **not yet measured**. No live comparison or benchmark success is claimed.

One TypeScript package contains a browser-safe pure core, a local Node CLI, and a React/Vite file viewer. The viewer loads bundled synthetic samples or imported run files; it does not probe hardware or contact Ollama. There is no database, authentication, server function, upload service, telemetry or required secret. The CLI defaults to synthetic `mock`; `run` is a dry run until `--yes`. Supplying a host does not switch it to live inference.

## After Dirty Mode closes

All commands below are future activation instructions, not execution receipts. Work in this inner repository, with Node 22 (the `.nvmrc` development target; package engine floor is 20.11). There is no lockfile yet: run `npm install` once, review and retain the resulting `package-lock.json`, then use `npm ci` for subsequent frozen installs. Dependency compatibility is unverified.

```text
npm run typecheck
npm run lint
npm test
npm run build
npm run build:cli
```

The viewer build outputs `dist/`; the CLI build outputs `dist-cli/`. Before starting a dev server, claim an approved port under the machine's agent-ports policy and set `LMP_VIEWER_PORT` to that port. In PowerShell:

```powershell
npm run dev -- --host 127.0.0.1 --port $env:LMP_VIEWER_PORT --strictPort
```

The viewer has Runs, Compare, Recommend, Audit and Export pages. Load a bundled MOCK sample, inspect the trace and baseline choices, append a ruling with a reason, and export JSON plus Markdown. Workspace state is in memory and resets on refresh. JSON exports contain **one run's measurements and rulings**, not selection settings; export every run in a multi-run comparison. Keep the Markdown report and reapply its objective, constraints, group and flags after importing JSON. JSON alone does not reproduce a custom-settings decision. Imported item banks are not embedded: when the bundled bank cannot identify an expected answer, Audit reports it as unknown rather than inventing one.

## Local CLI

These commands use the default mock runtime and require no Ollama or key after dependencies are available:

```text
npm run cli -- --help
npm run cli -- probe --json
npm run cli -- discover --json
npm run cli -- run
npm run cli -- run --yes --runtime mock --out out
```

`run` prints the selected models, workload, settings, rough duration and estimated output size. Without `--yes` it makes no inference request and writes nothing. Replace `RUN_FILE` below with the exact saved JSON path printed by collection; pass each file explicitly (shell wildcard expansion is not portable):

```text
npm run cli -- recommend RUN_FILE
npm run cli -- recommend RUN_FILE --json
npm run cli -- recommend RUN_FILE --objective speed --constraint minAccuracy=0.6
npm run cli -- recommend RUN_FILE --constraint maxMemoryGB=8 --constraint requireFullGpu=false
npm run cli -- report RUN_FILE --out reports --md decision.md
```

`report` without `--md` or `--out` prints Markdown. `--md` is a **plain basename inside `--out`** (default directory: current working directory), not a path. Existing destinations are refused. Files are validated and capped before writing, then published using a synced same-directory temporary file and an atomic no-clobber **hard link**. There is no rename fallback; filesystems without hard-link support fail explicitly. Actual filesystem behavior and cancellation/partial-file recovery remain unverified.

For a future authorized live sweep, start Ollama yourself and use an already installed tag. The CLI never pulls, copies or deletes models:

```text
npm run cli -- probe --runtime ollama --json
npm run cli -- discover --runtime ollama --json
npm run cli -- run --runtime ollama --models INSTALLED_TAG --out live-out
npm run cli -- run --yes --runtime ollama --models INSTALLED_TAG --out live-out
```

Default host: `http://127.0.0.1:11434`. `--host URL` or the process environment's `OLLAMA_HOST` selects an endpoint; `.env.example` documents the name and is not an automatic environment loader. Non-loopback needs `--allow-remote`; recommending that run also needs `--accept-remote` and `--constraint requireFullGpu=true` or `false`. Remote hardware is unknown, scoped to that collection, always low confidence, and estimate-only is unavailable.

Collection options: `--seed` (default 42), `--num-ctx` (4096), `--num-predict` (512), `--timeout-gen` (**seconds**, default 300), and `--mock-seed` (synthetic data seed, default `0x5332` / decimal 21298; CLI input is decimal). Temperature is fixed at zero; thinking stays at the model default. The speed protocol uses three prompts, one discarded warm-up and three measured repeats per prompt; the item bank has thirty items. These are protocol settings, not measured outcomes. Optional NVIDIA peak sampling was omitted; memory is sampled `/api/ps` residency, never a guaranteed peak.

Selection defaults are labelled proposals: quality objective; minimum 8 tok/s; maximum 5000 ms response latency (time to first answer when thinking); no memory cap; GPU rule `auto`, full-GPU threshold .95; sign-test alpha .05; spread warning .25. Speed uses a required accuracy floor, proposed .6. Repeated `--constraint key=value` overrides these. `--group`, `--allow-mixed-hardware`, `--accept-remote` and `--ignore-rulings` expose explicit comparison choices. Confidence is a heuristic, not a probability. Unknown measurements remain unknown.

## Evaluation and evidence

The fixture-based report covers deterministic versus naive held-out grading with named disagreements, fourteen specification scenarios expanded into seventeen option/ruling cases for four selection methods, hand-computed statistics references, seeded independent-Bernoulli simulation, and per-model cost/time from synthetic run files. These scenarios test the specified rule; they do not measure selection quality in the world. Synthetic timing is never hardware performance.

After activation and approval of the one frozen held-out evaluation:

```text
npm run eval -- --confirm-heldout
```

Without confirmation the script exits before loading held-out data. A nonempty result JSONL blocks repeated scoring. Do not tune graders or labels against misses, erase the execution marker to retry, or silently rerun an interrupted evaluation; arrange a separate documented audit decision. The script writes named misses even if a proposed target is missed. `scripts/sim.ts` is also a standalone synthetic statistics source (`npx tsx scripts/sim.ts` after activation); it is not a model benchmark and has not run.

Read [METHOD](docs/METHOD.md), [LIMITATIONS](docs/LIMITATIONS.md), and the complete [deferred-validation ledger](docs/DEFERRED-VALIDATION.md). [BOLT-HANDOFF.md](BOLT-HANDOFF.md) contains an **inspect and prepare only** prompt for a future static viewer handoff. No remote, push, GitHub import or deployment has been performed or requested by that prompt.

## Licence

MIT; see [LICENSE](LICENSE) and [NOTICE](NOTICE) for dataset and methodology attribution.
