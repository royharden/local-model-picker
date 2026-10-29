// ProviderFailure: the error adapters throw. Carries a ProviderErrorCode (src/core/providers/types.ts).
// Messages never contain the endpoint address; callers still redact and sanitise before display.
import type { ProviderError, ProviderErrorCode } from "../../src/core/index.js";

export class ProviderFailure extends Error {
  code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderFailure";
    this.code = code;
  }

  toProviderError(): ProviderError {
    return { code: this.code, message: this.message };
  }
}

export function isProviderFailure(e: unknown): e is ProviderFailure {
  return e instanceof ProviderFailure;
}

/** A short, address-free description of any thrown value. */
export function describeError(e: unknown): string {
  if (e instanceof ProviderFailure) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message.slice(0, 300);
  return String(e).slice(0, 300);
}
