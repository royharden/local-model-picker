import { describe, expect, it } from "vitest";
import { guardedFetch, resolveEndpoint } from "../../cli/providers/fetch-guard.js";

describe("endpoint guard", () => {
  it("uses only explicit literal loopbacks without DNS and rewrites localhost", () => {
    for (const host of ["http://127.0.0.1:11434", "http://127.99.1.2", "http://[::1]:11434"]) expect(resolveEndpoint(host, { allowRemote: false }).ok).toBe(true);
    expect(resolveEndpoint("localhost", { allowRemote: false })).toEqual({ ok: true, baseUrl: "http://127.0.0.1:11434", endpointKind: "loopback" });
    for (const host of ["http://0.0.0.0:11434", "http://127.0.0.1.evil.invalid", "http://example.invalid", "http://2130706433", "http://127.1", "http://0x7f000001", "http://user:secret@localhost", "file:///tmp", "http://localhost/path"]) expect(resolveEndpoint(host, { allowRemote: false }).ok).toBe(false);
  });
  it("remote permission never permits credentials or unsafe schemes", () => {
    expect(resolveEndpoint("https://example.invalid", { allowRemote: true })).toEqual({ ok: true, baseUrl: "https://example.invalid", endpointKind: "remote" });
    expect(resolveEndpoint("https://user:secret@example.invalid", { allowRemote: true }).ok).toBe(false);
    expect(resolveEndpoint("ftp://example.invalid", { allowRemote: true }).ok).toBe(false);
  });
  it("sets redirect:error on every request and rejects a returned 3xx", async () => {
    let redirect: string | undefined;
    const guarded = guardedFetch(async (_url, init) => { redirect = init.redirect; return { ok: false, status: 302, body: null }; }, "http://127.0.0.1:11434");
    await expect(guarded("/api/tags", { method: "GET", signal: new AbortController().signal })).rejects.toThrow("redirect refused");
    expect(redirect).toBe("error");
  });
});
