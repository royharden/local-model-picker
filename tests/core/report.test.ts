import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION_OPTIONS, RunFileSchema, defaultConstraints, escapeMarkdown, fencedText, markdownReport, recommend } from "../../src/core/index.js";

const fixture = (name = "s01-q2-accuracy-collapse.json") => RunFileSchema.parse(JSON.parse(readFileSync(new URL(`../../fixtures/runs/${name}`, import.meta.url), "utf8")));

describe("safe, auditable Markdown reports", () => {
  it("neutralizes HTML, links, table cells and block-starting newlines in prose", () => {
    const text = escapeMarkdown("<script>alert(1)</script> | [click](javascript:alert(1))\n# heading\u001b[2J\u202e");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("\\|");
    expect(text).toContain("\\[click\\]");
    expect(text).toContain("\\# heading");
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("<script>");
  });
  it("chooses fences longer than any inner backtick run and removes control sequences", () => {
    const payload = "answer\n`````````\n<script>data</script>\n~~~\n\u001b[2Jend";
    const lines = fencedText(payload).split("\n");
    expect(lines[0]).toBe("`".repeat(10));
    expect(lines.at(-1)).toBe(lines[0]);
    expect(lines.slice(1, -1).join("\n")).toBe(payload.replace("\u001b[2J", ""));
    expect(fencedText("plain")).toBe("```\nplain\n```");
  });
  it("records both original/corrected decisions, sample caveats, baselines, prompts and rulings", () => {
    const run = fixture("s14-grader-overrides.json");
    const constraints = defaultConstraints("quality");
    const options = { ...DEFAULT_SELECTION_OPTIONS, applyRulings: true };
    const result = recommend([run], constraints, options);
    const before = JSON.stringify(run);
    const report = markdownReport([run], result, constraints, options);
    expect(report).toContain("Synthetic scenario data");
    expect(report).toContain("Original grades");
    expect(report).toContain("human-corrected");
    expect(report).toContain("Tied within noise");
    expect(report).toContain("llmfit");
    expect(report).toContain("Per-prompt speed");
    expect(report).toContain("Sequence 6");
    expect(report).toContain("KV cache and runtime overhead are excluded");
    expect(report).toContain("not a guaranteed peak");
    expect(JSON.stringify(run)).toBe(before);
    expect(markdownReport([run], result, constraints, options)).toBe(report);
  });
  it("renders injected tags as text, suppresses unsafe commands, and fences hostile responses", () => {
    const run = fixture("s09-injected-tag.json");
    run.warnings.push("<img src=x onerror=alert(1)>\n| injected | row |");
    run.candidates[0]!.items[0]!.raw = "````\n# hostile response\n<img src=x>\n\u001b[2J";
    const constraints = defaultConstraints("quality");
    const result = recommend([run], constraints, DEFAULT_SELECTION_OPTIONS);
    const report = markdownReport([run], result, constraints, DEFAULT_SELECTION_OPTIONS);
    expect(result.command).toBeNull();
    expect(report).toContain("No safe command is available");
    expect(report).toContain("&lt;img src\\=x onerror\\=alert\\(1\\)&gt;");
    expect(report).toContain("`````\n````\n# hostile response\n<img src=x>\n\n`````");
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("\n| injected | row |");
  });
  it("prints MOCK and REMOTE banners from selected run metadata", () => {
    const run = fixture();
    run.runtime = "mock"; run.endpointKind = "mock"; run.fingerprint.source = "mock"; run.fingerprint.scopeId = "mock-v1";
    const constraints = defaultConstraints("quality");
    expect(markdownReport([run], recommend([run], constraints, DEFAULT_SELECTION_OPTIONS), constraints, DEFAULT_SELECTION_OPTIONS)).toContain("**MOCK: not a measurement.**");
    run.runtime = "ollama"; run.endpointKind = "remote"; run.remote = true; run.fingerprint.source = "remote-unknown"; run.fingerprint.scopeId = run.runId;
    const remoteConstraints = { ...constraints, requireFullGpu: false as const };
    const remoteOptions = { ...DEFAULT_SELECTION_OPTIONS, acceptRemote: true };
    expect(markdownReport([run], recommend([run], remoteConstraints, remoteOptions), remoteConstraints, remoteOptions)).toContain("**REMOTE:");
  });
});
