# Bolt handoff: Local Model Picker

**Status: construction complete - runtime unverified.** The inner repository is the app root; the outer planning/agent folders are not part of the import. The local Git repository has no remote. No push, import, backend provisioning, hosting or publication has occurred. This handoff authorizes no such action.

Target: a static React + TypeScript + Vite viewer. Future Bolt action: **inspect and prepare only**. Native Node CLI collection stays on the owner's computer; a hosted preview cannot probe the user's GPU or reliably reach local Ollama. The viewer works from bundled synthetic MOCK samples and user-imported JSON files; its workspace is in memory.

## Provisioning inventory

| Resource | Requirement |
|---|---|
| Database / migrations | None / Not required |
| Functions | Not required |
| Secrets | Not required |
| Auth / storage / Realtime / schedules | Not required |
| Frontend environment | None; no `VITE_` configuration |
| External service | Ollama, only for an owner's separate local CLI live sweep; no account or key needed by the viewer |
| Synthetic data | `public/samples/*.json`; labelled MOCK, not live measurements |
| Local configuration | Process `OLLAMA_HOST` for CLI endpoint only; documented in `.env.example`, never consumed by the viewer |

The commented `TYPESAFE_API_KEY` placeholder is reserved for a possible future experiment and has no consumer in this MVP. Do not enter it in Bolt. No backend resources need provisioning.

## Build and pending acceptance

Node 22 is the development target (`.nvmrc`); the declared engine floor is 20.11. One npm package. **No lockfile exists yet**: after activation run `npm install` once, review/retain `package-lock.json`, then use `npm ci`. No install/build/test command has been executed here.

| Check | Future command / result |
|---|---|
| Types / lint / tests | `npm run typecheck`, `npm run lint`, `npm test` — pending |
| Static viewer | `npm run build` → `dist/` — pending |
| Local CLI | `npm run build:cli` → `dist-cli/` — pending; not deployed |
| Viewer journey | Load sample → compare → change limits → audit ruling → JSON/Markdown export → reimport and reapply saved settings — pending |
| Evidence | `npm run eval -- --confirm-heldout` once after a separate evaluation grant — pending; numeric results pending, case study not yet measured |
| Bolt import/build/preview | Future owner-authorized transfer of exact inner source and pinned revision — pending |

Before starting any local preview server, claim a machine-approved port under agent-ports and use `npm run dev -- --host 127.0.0.1 --port PORT --strictPort` with that port. Preserve the existing design. JSON holds run data/rulings; custom selection settings are in Markdown and must be reapplied. Audit expected answers can be unknown for imported banks. See [DEFERRED-VALIDATION](docs/DEFERRED-VALIDATION.md) and [LIMITATIONS](docs/LIMITATIONS.md).

## Inspection/preparation prompt for a future authorized transfer

> Inspect and prepare only. Read this BOLT-HANDOFF.md and inspect the exact inner Local Model Picker repository at the owner-approved branch/revision. It is a static Vite viewer with a separate local Node CLI; Database: none; Functions, Secrets and Auth: Not required. Inspect package/build compatibility and bundled synthetic samples, and prepare a reviewable import/build/preview plan with pending checks. Preserve the app's design and file-based workflow. Keep native hardware probing and Ollama collection local. Do not create cloud resources, add a database or functions, enter secrets, push code, import from GitHub, deploy or publish under this prompt. Report concrete gaps and owner prerequisites; do not call source construction or pending checks verified.
