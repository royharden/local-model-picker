// Barrel for the provider seam: the Runtime interface (types.ts) plus the pure Ollama body parsers
// (ollama-parse.ts) and the byte-capped NDJSON splitter (ndjson.ts). Pure: no Node imports.
// src/core/index.ts is expected to re-export this barrel (replacing its direct types.js export).
export * from "./types.js";
export * from "./ollama-parse.js";
export * from "./ndjson.js";
