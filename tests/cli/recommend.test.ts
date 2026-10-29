import { describe, expect, it } from "vitest";
import { dispatch } from "../../cli/index.js";
import { parseSelectionArgs } from "../../cli/recommend.js";
import { fakeContext } from "./helpers.js";

describe("CLI selection arguments", () => {
  it("maps explicit selection options and repeated constraints without hidden defaults", () => {
    const parsed = parseSelectionArgs(["run.json", "--objective", "speed", "--constraint", "minAccuracy=0.75", "--constraint=requireFullGpu=false", "--allow-mixed-hardware", "--accept-remote", "--group", "group-a"]);
    expect(parsed.constraints).toMatchObject({ minAccuracy: 0.75, requireFullGpu: false });
    expect(parsed.options).toMatchObject({ objective: "speed", acceptRemote: true, allowMixedHardware: true, groupKey: "group-a" });
  });
  it("rejects a cleared accuracy floor, invalid finite numbers and unknown properties", () => {
    expect(() => parseSelectionArgs(["run.json", "--objective", "speed", "--constraint", "minAccuracy=null"])).toThrow("requires");
    for (const constraint of ["minTokPerSec=Infinity", "minAccuracy=2", "minTokPerSec=-1", "__proto__=1", "minTokPerSec="]) expect(() => parseSelectionArgs(["run.json", "--constraint", constraint])).toThrow();
  });
  it("help dispatch performs no probe, network or output write", async () => {
    const f = fakeContext(); expect(await dispatch(["--help"], f.ctx)).toBe(0);
    expect(f.probes).toHaveLength(0); expect(f.network).toHaveLength(0); expect(f.saved).toHaveLength(0);
    expect(f.lines.join("\n")).toContain("runtime unverified");
  });
});
