// Privacy redaction (pure regex, no I/O). Applied by the CLI to the capped answer text before it is
// stored or graded (D9), and to free text (warnings, errors, metadata) at ingestion and export.
// Conservative by design: a dotted decimal answer such as "3.14", "1.2e3", "1,200" or a time
// "12:30:45" is never touched; IPv4 needs exactly four octets 0-255 not embedded in a longer
// dotted number, and IPv6 needs a valid group structure.
// Pattern rules cannot know this machine's hostname or user name, so the CLI passes them as
// explicit literals (RedactOptions); core never reads the environment.
// Redaction cannot guarantee removal of every secret a user embeds manually (LIMITATIONS).

/** Bump on any rule change: it is recorded in protocol.redactionVersion and is part of protocolHash. */
export const REDACTION_VERSION = "redact-v1";

export const REDACTED = {
  user: "<user>",
  host: "<host>",
  ipv4: "<ipv4>",
  ipv6: "<ipv6>",
} as const;

export interface RedactOptions {
  /** machine host names (e.g. os.hostname()), matched case-insensitively as whole tokens */
  hostnames?: readonly string[];
  /** user names (e.g. os.userInfo().username), matched case-insensitively as whole tokens */
  usernames?: readonly string[];
}

/** Explicit literals shorter than this are ignored (a one-letter user name would erase ordinary text). */
export const MIN_LITERAL_LENGTH = 2;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function replaceLiterals(text: string, literals: readonly string[] | undefined, token: string): string {
  if (literals === undefined || literals.length === 0) return text;
  const usable = [...new Set(literals.map((l) => l.trim()).filter((l) => l.length >= MIN_LITERAL_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const lit of usable) {
    // Whole token: not preceded or followed by a letter or digit. The `<` / `>` guards keep a
    // literal such as "user" or "host" from matching inside an earlier token ("<user>"), so
    // redact(redact(x)) === redact(x).
    const re = new RegExp(`(?<![A-Za-z0-9<])${escapeRegExp(lit)}(?![A-Za-z0-9>])`, "gi");
    out = out.replace(re, token);
  }
  return out;
}

// A path segment that may be a (possibly multi-word) user name: words without separators,
// joined by single spaces only when a path separator follows (so prose after the path is kept).
const SEG = `[^\\\\/\\s"'<>|:*?]+`;
const NAME = `(?:${SEG}(?: ${SEG})*(?=[\\\\/])|${SEG})`;

/** C:\Users\x, C:/Users/x, C:\Documents and Settings\x */
// (separators may be doubled, as in JSON-escaped text pasted into an answer)
const WIN_HOME = new RegExp(`\\b([A-Za-z]:[\\\\/]{1,2})(Users|Documents and Settings)([\\\\/]{1,2})${NAME}`, "gi");
/** /Users/x (macOS) and /home/x (Linux) */
const NIX_HOME = new RegExp(`(^|[^A-Za-z0-9_.-])(/(?:Users|home)/)${NAME}`, "g");
/** \\HOST\share UNC prefix */
const UNC_HOST = /(?<![A-Za-z0-9:\\])\\\\[A-Za-z0-9._-]+\\/g;
/** Default Windows machine names and mDNS .local names */
const DEFAULT_HOSTS = /\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{5,15}\b|\b[A-Za-z0-9-]{1,63}\.local\b/g;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** Exactly four octets, not part of a longer dotted number ("1.2.3.4.5") or a decimal ("1.2.3.4.5e2"). */
const IPV4 = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?!\\d|\\.\\d)`, "g");
/** IPv6 candidate token; validated by isIpv6 before replacement. */
const IPV6_CANDIDATE = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:]|\.\d)/g;

const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;

/** Full 8-group form or a single "::" compression with at most 7 groups; bare "::" is not redacted. */
export function isIpv6(token: string): boolean {
  if (token === "::") return false;
  const parts = token.split("::");
  if (parts.length > 2) return false;
  const groups = (side: string): string[] | null => {
    if (side === "") return [];
    const g = side.split(":");
    return g.every((x) => HEX_GROUP.test(x)) ? g : null;
  };
  if (parts.length === 1) {
    const g = groups(token);
    return g !== null && g.length === 8;
  }
  const left = groups(parts[0] ?? "");
  const right = groups(parts[1] ?? "");
  return left !== null && right !== null && left.length + right.length <= 7;
}

/**
 * Redact one string. Idempotent for the same options: redacting the output again changes nothing,
 * because no rule matches inside a replacement token (`<user>`, `<host>`, `<ipv4>`, `<ipv6>`).
 */
export function redact(text: string, options: RedactOptions = {}): string {
  let out = text;
  out = replaceLiterals(out, options.hostnames, REDACTED.host);
  out = replaceLiterals(out, options.usernames, REDACTED.user);
  out = out.replace(WIN_HOME, (_m, drive: string, dir: string, sep: string) => `${drive}${dir}${sep}${REDACTED.user}`);
  out = out.replace(NIX_HOME, (_m, pre: string, dir: string) => `${pre}${dir}${REDACTED.user}`);
  out = out.replace(UNC_HOST, `\\\\${REDACTED.host}\\`);
  out = out.replace(DEFAULT_HOSTS, REDACTED.host);
  out = out.replace(IPV6_CANDIDATE, (m) => (isIpv6(m) ? REDACTED.ipv6 : m));
  out = out.replace(IPV4, REDACTED.ipv4);
  return out;
}

/** Maximum nesting redactDeep walks; deeper input is a caller bug (run files are about 6 levels). */
export const REDACT_MAX_DEPTH = 64;

/**
 * Redact every string value in a JSON-like value (arrays and plain objects), returning a new value;
 * the input is not mutated. Object keys, numbers, booleans and null are kept as they are.
 */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > REDACT_MAX_DEPTH) throw new RangeError(`redactDeep: nesting deeper than ${REDACT_MAX_DEPTH}`);
    if (typeof v === "string") return redact(v, options);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, depth + 1);
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}
