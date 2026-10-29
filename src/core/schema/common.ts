// Shared zod building blocks for the v1 contracts. Every string and array is bounded.
import { z } from "zod";

/** A finite, non-negative number (JSON overflow such as 1e999 parses to Infinity and is rejected). */
export const nonNegNumber = z.number().finite().nonnegative();
export const nonNegInt = z.number().int().nonnegative();
export const posInt = z.number().int().positive();
export const fraction = z.number().finite().min(0).max(1);

/** Identifier: printable ASCII without spaces, 1..200 chars. */
export const idString = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:@/-]+$/, "identifier may contain only letters, digits and . _ : @ / -");

/** Short free text (names, versions). */
export const shortText = z.string().min(1).max(200);

/** Lowercase hex sha256 (64 chars). */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters (sha256)");

/**
 * UTC timestamp in exactly the shape Date.prototype.toISOString produces: YYYY-MM-DDTHH:MM:SS.sssZ.
 * Fixed width and UTC only, so timestamps compare correctly as strings (supersession, D15).
 * Core never reads a clock; these values are supplied by the CLI or the viewer.
 * Field ranges: month 01-12, day 01-31, hour 00-23, minute and second 00-59 (day-of-month is not
 * checked against the month).
 */
export const isoUtc = z
  .string()
  .regex(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/,
    "expected a UTC timestamp like 2026-10-24T15:00:00.000Z (month 01-12, day 01-31, hour < 24, minute and second < 60)",
  );

/** Bounded list of short messages (warnings, flags). */
export const messageList = z.array(z.string().min(1).max(500)).max(200);
