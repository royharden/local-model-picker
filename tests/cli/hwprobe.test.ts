import { describe, expect, it } from "vitest";
import { APPLE_QUERY_ARGS, NVIDIA_QUERY_ARGS, PROBE_EXEC_OPTIONS, parseNvidiaSmi, parseSystemProfiler, probeApple, probeNvidia } from "../../cli/hwprobe/index.js";
import { mockFingerprint, remoteFingerprint } from "../../cli/hwprobe/fingerprint.js";

describe("bounded native probes", () => {
  it("uses fixed execFile arrays with timeout, buffer cap and no shell", async () => {
    const calls: unknown[] = [];
    await probeNvidia(async (file, args, options) => { calls.push({ file, args, options }); return { stdout: "Fixture GPU, 8192, 4096, 000.00\n" }; });
    await probeApple(async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '{"SPDisplaysDataType":[{"sppci_model":"Apple Fixture","spdisplays_vendor":"Apple"}]}' }; });
    expect(calls).toEqual([{ file: "nvidia-smi", args: NVIDIA_QUERY_ARGS, options: PROBE_EXEC_OPTIONS }, { file: "system_profiler", args: APPLE_QUERY_ARGS, options: PROBE_EXEC_OPTIONS }]);
    expect(PROBE_EXEC_OPTIONS).toMatchObject({ timeout: 5000, maxBuffer: 1_048_576, windowsHide: true, shell: false });
  });
  it("converts NVIDIA MiB and rejects unavailable or impossible memory", async () => {
    expect(parseNvidiaSmi("Fixture GPU, 8192, 4096, 000.00")?.gpu.vramTotalBytes).toBe(8192 * 1024 * 1024);
    expect(parseNvidiaSmi("Fixture GPU, N/A, N/A, 000.00")).toBeNull();
    expect(parseNvidiaSmi("Fixture GPU, 1, 2, 000.00")).toBeNull();
    expect(await probeNvidia(async () => { throw new Error("missing executable"); })).toBeNull();
  });
  it("Apple identifies unified GPU without inventing dedicated VRAM", () => {
    expect(parseSystemProfiler('{"SPDisplaysDataType":[{"sppci_model":"Apple Fixture"}]}')).toEqual({ name: "Apple Fixture", appleSilicon: true });
    expect(parseSystemProfiler("not json")).toBeNull();
  });
  it("mock fingerprints are fixed and remote scopes are distinct", () => {
    expect(mockFingerprint()).toEqual(mockFingerprint());
    expect(mockFingerprint().scopeId).toBe("mock-v1");
    expect(remoteFingerprint("run-a").hash).not.toBe(remoteFingerprint("run-b").hash);
    expect(remoteFingerprint("run-a")).toMatchObject({ cpuModel: null, cpuThreads: null, ramBytes: null, os: null });
  });
});
