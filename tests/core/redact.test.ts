// redact + sanitizeForTerminal unit tests (authored in Dirty Mode; not yet run).
import { describe, it, expect } from "vitest";
import { redact, redactDeep, isIpv6, sanitizeForTerminal, REDACTION_VERSION } from "../../src/core/index.js";

describe("redact: home paths", () => {
  it("Windows, macOS and Linux home directories", () => {
    expect(redact("saved to C:\\Users\\alice\\proj\\out.json")).toBe("saved to C:\\Users\\<user>\\proj\\out.json");
    expect(redact("C:/Users/alice/proj")).toBe("C:/Users/<user>/proj");
    expect(redact("open /Users/bob/models")).toBe("open /Users/<user>/models");
    expect(redact("cache in /home/carol/.ollama/models")).toBe("cache in /home/<user>/.ollama/models");
  });
  it("multi-word Windows user names followed by a separator", () => {
    expect(redact("C:\\Users\\Jane Q Doe\\OneDrive\\x.txt")).toBe("C:\\Users\\<user>\\OneDrive\\x.txt");
  });
  it("keeps prose after a path", () => {
    expect(redact("wrote C:\\Users\\alice and stopped")).toBe("wrote C:\\Users\\<user> and stopped");
  });
  it("doubled (JSON-escaped) separators", () => {
    expect(redact("C:\\\\Users\\\\alice\\\\x")).toBe("C:\\\\Users\\\\<user>\\\\x");
  });
  it("does not touch URLs that merely contain /home/", () => {
    expect(redact("see https://example.com/home/page")).toBe("see https://example.com/home/page");
  });
});

describe("redact: explicit host and user names", () => {
  it("replaces whole tokens case-insensitively, hostnames first", () => {
    const out = redact("user Roy on roy-desk via ROY-DESK.lan", { hostnames: ["roy-desk"], usernames: ["roy"] });
    expect(out).toBe("user <user> on <host> via <host>.lan");
  });
  it("does not replace inside longer words, and ignores one-letter literals", () => {
    expect(redact("royalty is fine", { usernames: ["roy"] })).toBe("royalty is fine");
    expect(redact("a b c", { usernames: ["a"] })).toBe("a b c");
  });
  it("default Windows machine names and .local names", () => {
    expect(redact("host DESKTOP-AB12CD3 and mac-mini.local")).toBe("host <host> and <host>");
  });
});

describe("redact: IP literals", () => {
  it("IPv4 with four valid octets", () => {
    expect(redact("server 192.168.1.20 replied")).toBe("server <ipv4> replied");
    expect(redact("http://10.0.0.5:11434/api")).toBe("http://<ipv4>:11434/api");
    expect(redact("ends with 127.0.0.1.")).toBe("ends with <ipv4>.");
  });
  it("IPv6 full and compressed forms", () => {
    expect(redact("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("<ipv6>");
    expect(redact("link fe80::1ff:fe23:4567:890a up")).toBe("link <ipv6> up");
    expect(redact("http://[::1]:11434")).toBe("http://[<ipv6>]:11434");
  });
  it("IPv4-mapped IPv6 keeps no address digits", () => {
    expect(redact("::ffff:192.168.0.1")).toBe("::ffff:<ipv4>");
  });
  it("is conservative: numbers, decimals, versions and times are untouched", () => {
    for (const s of ["3.14", "1.2e3", "1,200", "$1200.00", "12:30:45", "version 1.2.3", "999.1.1.1", "1.2.3.4.5", "10.0.0.256", "std::vector", "::", "ratio 3:2"]) {
      expect(redact(s)).toBe(s);
    }
  });
  it("isIpv6 validates structure", () => {
    expect(isIpv6("::1")).toBe(true);
    expect(isIpv6("1:2:3:4:5:6:7:8")).toBe(true);
    expect(isIpv6("1:2:3")).toBe(false);
    expect(isIpv6("1::2::3")).toBe(false);
    expect(isIpv6("12345::1")).toBe(false);
  });
});

describe("redact: idempotence and deep objects", () => {
  it("redacting twice changes nothing more", () => {
    const once = redact("C:\\Users\\alice\\x at 10.1.2.3 and ::1", { usernames: ["alice"] });
    expect(redact(once, { usernames: ["alice"] })).toBe(once);
  });
  it("is idempotent when a literal equals a replacement token's word (usernames: [\"user\"], hostnames: [\"host\"])", () => {
    const opts = { usernames: ["user"], hostnames: ["host"] };
    const x = "user on host: C:\\Users\\user\\x, \\\\host\\share, ::1";
    const once = redact(x, opts);
    expect(once).toBe("<user> on <host>: C:\\Users\\<user>\\x, \\\\<host>\\share, <ipv6>");
    expect(redact(once, opts)).toBe(once);
    // A replacement token is never re-matched (previously "<user>" became "<<user>>").
    expect(redact("<user> and <host>", opts)).toBe("<user> and <host>");
  });
  it("redactDeep maps nested strings and leaves the input unchanged", () => {
    const input = { a: ["C:\\Users\\alice\\x", { b: "10.0.0.5", n: 3.14 }], ok: true, nothing: null, note: "pi is 3.14" };
    const copy = JSON.parse(JSON.stringify(input)) as typeof input;
    const out = redactDeep(input);
    expect(out).toEqual({ a: ["C:\\Users\\<user>\\x", { b: "<ipv4>", n: 3.14 }], ok: true, nothing: null, note: "pi is 3.14" });
    expect(input).toEqual(copy);
  });
  it("planted personal data in a Markdown-like export is removed", () => {
    const md = "| tag | path |\n| llama3 | /home/dave/.ollama |\nError from 192.168.50.7: C:\\Users\\dave\\AppData";
    const out = redact(md);
    expect(out).not.toContain("dave");
    expect(out).not.toContain("192.168.50.7");
  });
  it("exports a version string", () => {
    expect(REDACTION_VERSION).toMatch(/^redact-v\d+$/);
  });
});

describe("sanitizeForTerminal", () => {
  it("keeps newline and tab, drops other C0 controls and DEL", () => {
    expect(sanitizeForTerminal("a\tb\nc\rd\u0000e\u0007f\u007fg")).toBe("a\tb\ncdefg");
  });
  it("removes ANSI CSI and OSC sequences entirely", () => {
    expect(sanitizeForTerminal("\u001b[31mred\u001b[0m plain")).toBe("red plain");
    expect(sanitizeForTerminal("\u001b]0;evil title\u0007after")).toBe("after");
    expect(sanitizeForTerminal("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
    expect(sanitizeForTerminal("x\u001bcy")).toBe("xy");
  });
  it("removes C1 controls including 8-bit CSI", () => {
    expect(sanitizeForTerminal("a\u009b31mb\u0085c")).toBe("abc");
  });
  it("removes bidi override characters", () => {
    expect(sanitizeForTerminal("ab\u202ecd\u2066e")).toBe("abcde");
  });
  it("leaves ordinary Unicode text alone", () => {
    expect(sanitizeForTerminal("caf\u00e9 \u4f60\u597d \u{1F600}")).toBe("caf\u00e9 \u4f60\u597d \u{1F600}");
  });
});
