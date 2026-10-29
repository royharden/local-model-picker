// Fetch guard (D22, Claude §2.7 R6). Decides where the CLI may send requests, with no DNS lookup:
// - parse with URL; scheme http or https only; embedded credentials rejected; no path/query/fragment;
// - loopback means the LITERAL addresses 127.0.0.0/8 or ::1; the literal name `localhost` is
//   rewritten to 127.0.0.1 before any request, so no resolver decides loopback;
// - every other host is remote and needs --allow-remote (stored as endpointKind "remote", never as an address);
// - every request uses redirect: "error", and a 3xx that still arrives is refused.
// Host parsing mirrors Ollama's OLLAMA_HOST rules: no scheme -> http with default port 11434;
// an explicit http:// or https:// without a port uses that scheme's default port.

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const OLLAMA_DEFAULT_PORT = "11434";

/** Body reader shape shared by Node's fetch (web ReadableStream reader) and the mock. */
export interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  body: { getReader(): BodyReader } | null;
}

export interface FetchInit {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  redirect: "error";
  signal: AbortSignal;
}

/** The fetch seam. Node's global fetch satisfies it; tests and the mock pass fakes. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export type EndpointKind = "loopback" | "remote";

export type GuardResult =
  | { ok: true; baseUrl: string; endpointKind: EndpointKind }
  | { ok: false; message: string };

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Literal loopback check on a URL hostname (already normalised by the WHATWG URL parser). */
export function isLoopbackLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "[::1]" || h === "::1") return true;
  const m = IPV4_LITERAL.exec(h);
  if (m === null) return false;
  const octets = m.slice(1).map((x) => Number(x));
  return octets.every((o) => o >= 0 && o <= 255) && octets[0] === 127;
}

/**
 * Validate an endpoint string (from --host or OLLAMA_HOST). Returns the base URL to use (scheme://host:port,
 * no trailing slash) or a refusal message. The message never echoes credentials.
 */
export function resolveEndpoint(raw: string, opts: { allowRemote: boolean }): GuardResult {
  const text = raw.trim();
  if (text === "") return { ok: false, message: "the Ollama host is empty" };
  if (/[\x00-\x20\x7f\\]/.test(text)) return { ok: false, message: "the Ollama host contains whitespace, controls or a backslash" };
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text);
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return { ok: false, message: "the Ollama host is not a valid URL (expected http://127.0.0.1:11434)" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "the Ollama host must use http:// or https://" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "the Ollama host must not contain credentials (user:password@)" };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    return { ok: false, message: "the Ollama host must be scheme://host[:port] with no path, query or fragment" };
  }
  if (!hasScheme && url.port === "") url.port = OLLAMA_DEFAULT_PORT;
  if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";

  const loopback = isLoopbackLiteral(url.hostname);
  const authority = (hasScheme ? text.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "") : text).split(/[/?#]/)[0] ?? "";
  const rawHost = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0] ?? "";
  if (loopback && rawHost.toLowerCase() !== "localhost" && !isLoopbackLiteral(rawHost)) {
    return { ok: false, message: "use a literal dotted IPv4 loopback, ::1 or localhost (numeric shorthand is refused)" };
  }
  if (!loopback && !opts.allowRemote) {
    const hint = url.hostname === "0.0.0.0" ? " (0.0.0.0 is a server bind address; use http://127.0.0.1:11434)" : "";
    return {
      ok: false,
      message: `the Ollama host is not a literal loopback address${hint}; pass --allow-remote to measure a remote server`,
    };
  }
  return { ok: true, baseUrl: `${url.protocol}//${url.host}`, endpointKind: loopback ? "loopback" : "remote" };
}

/**
 * Wrap a fetch so every request goes to `baseUrl` + an API path, with redirect: "error"; a 3xx response
 * that still arrives (a fetch implementation that ignored the option) becomes a thrown redirect error.
 */
export function guardedFetch(fetchImpl: FetchLike, baseUrl: string): (path: string, init: Omit<FetchInit, "redirect">) => Promise<FetchResponseLike> {
  return async (path, init) => {
    if (!path.startsWith("/api/")) throw new TypeError("guarded fetch only requests /api/ paths");
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, redirect: "error" });
    if (response.status >= 300 && response.status < 400) {
      if (response.body !== null) await response.body.getReader().cancel().catch(() => undefined);
      throw new TypeError(`redirect refused (HTTP ${response.status})`);
    }
    return response;
  };
}
