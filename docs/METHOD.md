# Method

How Local Model Picker measures installed Ollama models and how it picks one. This is the prose form of the rules the code implements. Nothing described here has been run yet (see `DEFERRED-VALIDATION.md`); where a value is a proposed default it is marked as one.

## 1. What a run measures

A run is a JSON file written by the CLI (`npm run cli -- run --yes`). It holds, for each installed candidate model (tag plus digest):

- **Speed.** Three fixed prompts (long generation, a long prompt of about 1,500 tokens, mixed chat). For each prompt: one warm-up generation that is discarded, then three measured repeats. Settings are fixed for every request: temperature 0, a fixed seed, a fixed `num_ctx`, a capped `num_predict`, and `think` left at the model default (recorded as `think: "default"`; whether thinking was observed is stored per repeat).
- **Latency.** Time to first token (TTFT) and time to first answer token (TTFA, which differs from TTFT on thinking models), both measured by the client from the request start using a monotonic clock.
- **Durations from the runtime.** `load_duration`, `prompt_eval_count/duration`, `eval_count/duration` from the final `done` chunk, kept as received in nanoseconds (`usageRaw`) and converted once, in `src/core/providers/ollama-parse.ts`: ns / 1e6 = ms; tokens/s = count / (ns / 1e9).
- **Memory.** `/api/ps` samples after load and after each prompt: total resident `size` and `size_vram`. Offload fraction = `size_vram / size` when `size > 0` and `0 <= size_vram <= size`. These are samples, not guaranteed peaks.
- **Accuracy.** 30 fixed items (10 numeric, 8 multiple choice, 6 instruction-following, 6 extraction), one response each at temperature 0, graded by deterministic graders.

A repeat is **invalid** (never a speed of 0) when the stream ended without a `done` chunk, carried an `error` chunk, had a negative or non-finite numeric field, had `eval_count` or `eval_duration` <= 0, or produced no answer content. A warm repeat with `load_duration` 0 is valid. A cached prompt with `prompt_eval_count` or `prompt_eval_duration` 0 is valid with "prompt rate unavailable".

Candidate status: `measured` (exactly one result per item id and the full 3 x (1 + 3) speed set), `incomplete`, `failed` or `skipped` (each with a reason; partial data is kept for audit but is never eligible).

## 2. Answer processing order (D9)

1. Ollama's structured `message.thinking` is a separate field and never part of the answer.
2. The answer stream is cut to its first 8,000 characters (`truncated` and flag `over_cap` if cut); after redaction (step 3) the stored `raw` may grow, bounded by `REDACTED_RAW_MAX_CHARS` (32,000).
3. `raw` is **redacted**: home paths, host names and IP literals; bare user names are redacted only in metadata, warnings and errors (D37), never in answer text, where a user name such as "test" could change an answer. `REDACTION_VERSION` is stored in the protocol.
4. On that text: closed `<think>...</think>` blocks are removed; an unterminated `<think>` removes everything after it (flag `unterminated_think`); empty text is flagged `empty`.
5. The grader runs on the result.

The saved `raw` is exactly the redacted, capped text that was graded, so every grade can be reproduced from the file, and no unredacted copy is stored.

Implementation: `src/core/graders` (`prepareAnswer` = steps 2-3, `answerText` = step 4, `gradeItem` / `gradeAnswer`; `GRADER_VERSION = "graders-v1"`). A `</think>` with no opening tag (chat templates that open the block in the prompt) also removes the text before it.

### 2a. Grader rules (fixed on the dev fixtures before the single held-out run)

- **Numeric.** (1) The last explicit marker (`Answer:`, `####`, "the answer is") wins when the rest of its sentence or line holds exactly one distinct number; (2) otherwise a response with exactly one distinct number; (3) otherwise the first number within 60 characters after the last self-correction cue ("wait", "actually", "correction:"); (4) otherwise `ambiguous`, incorrect. Never the last number. Number grammar: sign, `$ € £`, thousands commas, decimals, scientific notation, simple fractions `a/b`, English number words zero..one thousand; nothing else.
- **Choice.** Upper-case A-D only. Marker letters (`Answer: B`, "the answer is (C)") take precedence; otherwise `(B)`, `B.` / `B)` at line start, or a lone letter. A letter after "not", "isn't", "never" is excluded. Two different letters: `ambiguous`, incorrect.
- **Instruction.** Parameterised rules from the item (`max_words`, `include_keywords`, `all_lowercase`, `json_keys`, ...); keyword matches are whole-word and case-insensitive. JSON strict: the whole response, after one optional code fence, parses; non-strict: the first balanced `{...}` object.
- **Extraction.** Text: the value after the last `Answer:` marker (or a single-line response), compared after trimming, dropping wrapping quotes/emphasis and a trailing period, collapsing whitespace, NFKC and lower case. JSON: exactly the expected keys, each value equal under the same comparison.
- **Naive baseline** (`naiveGrade`, agreement comparison only): last number, first capital A-D, substring, on `raw` without think removal.

### 2b. Item bank and grader fixtures

`data/items.v1.json` (`complete: true`): 10 GSM8K test rows and 8 MMLU test rows copied verbatim from `data/sources/fetched-20261024.json`, each with `sourceId`, revision and URL, plus 12 originals (6 instruction, 6 extraction). `fixtures/graders/{dev,heldout}.v1.json` hold 80 synthetic responses (40/40) whose expected extraction and correctness were written by hand before the grader code. The split records seed 21298 (0x5332) and freeze date 2026-10-24, but the assignment was made by an explicit hand list (one instance of each trap per half where possible), **not** by `seededSplit`; the file each case sits in is the record of the assignment. `scripts/eval.ts`, the only reader of the held-out file, checks with `checkGraderSplit` that the halves are disjoint, complete (40/40) and name only bank items.

The 8,000-character cap (`RAW_ANSWER_MAX_CHARS`, recorded as `protocol.caps.rawChars`) applies **before** redaction, and `truncated` / `over_cap` are decided against it. Redaction can lengthen the text (`::1` becomes `<ipv6>`; a short host-name literal becomes `<host>`; the current rules expand at most 3x), so the stored `raw` may be longer than 8,000 characters. The schema bounds the stored text at `REDACTED_RAW_MAX_CHARS` = 4 x `RAW_ANSWER_MAX_CHARS` = 32,000 characters, and a run file at 4 x its own `protocol.caps.rawChars`.

## 3. Transport bounds (D10, D31)

Metadata requests time out after 10 s; generation requests must deliver headers within 30 s and finish within 300 s (`--timeout-gen`); an NDJSON line is capped at 256 KB and a response at 1 MB. All caps are stored in `protocol.caps` and so are part of `protocolHash`. Run files are capped at 10,000,000 bytes on import (checked before parsing) and on write (checked on the serialised bytes; an over-cap write writes nothing).

## 4. Aggregation

- Per prompt: median, minimum and maximum of generation tokens/s over the three measured repeats; spread = (max - min) / median.
- Candidate throughput = the **minimum** of the three per-prompt medians.
- Candidate latency = the **maximum** of the per-prompt medians, using TTFA when thinking was observed and TTFT otherwise (the trace says which).
- Memory = the maximum observed `size` / 1e9 (decimal GB). Offload = the minimum valid observed fraction. No `/api/ps` entry means "not measured", which fails an active memory or full-GPU limit.
- Accuracy = correct / n, with a 95% Wilson interval. With rulings applied, the latest ruling (highest `seq`) for a (candidate, item) pair replaces the original grade; such scores are badged "human-corrected".

## 5. The recommend rule

`recommend(runs, constraints, options)` is pure and deterministic (no clock, no I/O, no randomness).

1. **Comparison group.** Runs are grouped by runtime + endpoint kind + item-set hash + grader version + protocol hash + fingerprint hash. More than one group gives `refused` with the list of groups; the user picks one. `allowMixedHardware` relaxes only the fingerprint part and only between local probes (always low confidence). A remote group is exactly one remote collection.
2. **One measurement per candidate.** If a candidate appears in several runs of the group, the whole measurement from the latest `createdAt` (then highest `runId`) is used; older ones are listed as superseded. Repeats and items are never spliced across runs.
3. **Unmeasured** candidates are listed with their reason and are never eligible.
4. **Hard filters**: `minTokPerSec`, `maxTtftMs`, `maxMemoryGB` (when set), `requireFullGpu`, `minAccuracy` (when set). Every failing filter is recorded with measured value, limit, unit and source. `requireFullGpu: "auto"` applies on an NVIDIA GPU with known VRAM; on Apple unified memory it applies per candidate when `size_vram` is valid and is otherwise skipped (low confidence); with no GPU detected it is not applied (low confidence); a remote group must choose true or false explicitly.
5. **No survivors** gives `none`: no pick, every reason listed. Never the least bad.
6. **Quality objective.** The leader is the most accurate survivor. Each other survivor is compared on the same items with an exact one-sided sign test on discordant items: b = leader right / other wrong, c = the reverse, p = P(X >= b | Binomial(b + c, 0.5)), p = 1 when b + c = 0. A survivor is "significantly lower" when p < alpha; otherwise it joins the **noise set**. The pick is the fastest member of the noise set. When the noise set has more than one member the result says **"tied within noise"**: this is a failure to distinguish, not proof of equal quality.
7. **Speed objective.** Requires `minAccuracy` (proposed 0.6). The pick is the fastest survivor; the paired comparison with the accuracy leader is still shown.
8. **Runner-up** is the next candidate in the final ordering.
9. **Confidence** is `low` when any of: the noise set has more than one member; fewer than two survivors; any survivor's spread > `spreadThreshold`; mixed hardware allowed; Ollama versions differ in the group; the full-GPU check was skipped for any candidate; mock data; remote group; the pick has `over_cap` or `unterminated_think` on any item; the item bank is incomplete (placeholders); the result is `none` or `refused`. Otherwise `high`. Confidence is an internal heuristic label, not a probability. A separate speed line (D12) uses descriptive bounds per candidate, [min over prompts of the per-prompt minimum, min over prompts of the per-prompt maximum]: it says "clearly faster" when the pick's lower bound is above the runner-up's upper bound, otherwise "speed ranges overlap". It is display only and never changes confidence.
10. **Command.** `ollama run <tag>` is shown only when the tag matches `^[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._\-]+)?$` and is at most 200 characters; otherwise no command is shown. Nothing ever executes it.

Proposed defaults (`src/core/config/defaults.ts`, each marked `// PROPOSED`): 8 tok/s, 5,000 ms, full-GPU threshold 0.95, alpha 0.05, spread 0.25, `minAccuracy` 0.6 for speed and none for quality, `maxMemoryGB` unset (never inferred), `requireFullGpu: "auto"`.

## 6. Baselines

- **Estimate-only** ("llmfit-style installed-only weights estimate"): uses only weight sizes from `/api/tags` and the free memory captured at probe time (free VRAM on NVIDIA, free RAM on CPU-only or Apple). Per model (tag name before `:` plus parameter size) it takes the highest fitting quant in the order Q8_0 > Q6_K > Q5_K_M > Q4_K_M > Q4_0 > Q3_K_M > Q2_K, then the largest model. KV cache and runtime overhead are excluded. Unavailable when free memory is unknown or the group is remote.
- **Fastest-only** and **accuracy-only** use all measured candidates and ignore the user's limits by design; their limit violations are counted separately.

## 7. Statistics (`src/core/evalkit`)

Plain TypeScript: Wilson interval (z = 1.959964), exact binomial pmf/cdf/survival in log space, one- and two-sided sign tests (two-sided is exported but unused), the mulberry32 seeded PRNG, a deterministic seeded split, method comparison rows and a `results.md` generator whose unfilled cells read "pending". No multiplicity correction is applied; the leader is chosen after seeing the results; with n = 30 the test has low power (see LIMITATIONS, M6).

## 8. Privacy

Redaction (`src/core/redact`) removes home paths (`C:\Users\x`, `/Users/x`, `/home/x`), host and user names passed explicitly by the CLI (user names in metadata, warnings and errors only, not in answer text: D37), default Windows machine names, `.local` names and IPv4/IPv6 literals. It is conservative: decimals such as `3.14`, `1.2e3`, `1,200` and times such as `12:30:45` are not changed. It cannot guarantee removal of every secret a user types into a prompt. Terminal output and the Markdown report strip control characters and escape sequences (`sanitizeForTerminal`).

## 9. Interfaces and seam owners

Every shared interface is owned by **S32-INT**; changes after M1 need a note in `STATUS.md`.

| Interface | Location | Owner | Consumers |
|---|---|---|---|
| Core public surface | `src/core/index.ts` | S32-INT | viewer, CLI, scripts, tests |
| Run-file contract (zod) | `src/core/schema/*.ts` | S32-INT | CLI writer, viewer import, recommend |
| `readRunFile`, `serializeRunFile`, `checkRunFileSize` | `src/core/io/readrunfile.ts` | S32-INT | `cli/io/read.ts`, `cli/io/write.ts`, viewer |
| `Runtime` provider interface | `src/core/providers/types.ts` | S32-INT | `cli/providers/ollama.ts`, `cli/providers/mock.ts` |
| Constraints / SelectionOptions / RecommendResult | `src/core/schema/{constraints,result}.ts` | S32-INT | recommend (M3), CLI, viewer |
| Item bank, prompt set, grader fixtures | `src/core/schema/items.ts` | S32-INT | `data/*.v1.json`, graders (M2), `scripts/eval.ts` |
| Proposed defaults and protocol caps | `src/core/config/defaults.ts` | S32-INT | CLI, viewer forms, recommend |
| Redaction and terminal sanitising | `src/core/redact/*.ts` | S32-INT | CLI, report, viewer export |
| Safe command text | `src/core/recommend/safe-command.ts` | S32-INT | recommend, CLI, viewer |
| Statistics | `src/core/evalkit/*.ts` | S32-INT | recommend, `scripts/eval.ts`, `scripts/sim.ts` |
