/**
 * Base-unit token amounts as decimal integer strings, handled with bigint.
 * No floating point touches a token amount anywhere in this package.
 */

import { IntentsError } from "./errors.js";

const UINT = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
/** Largest value an ERC-20 / NEP-141 balance can hold. */
const MAX_UINT256 = (1n << 256n) - 1n;

/** Parses a base-unit amount ("1500000"), rejecting signs, decimals, leading zeros and overflow. */
export function parseBaseUnits(value: unknown, field = "amount"): bigint {
  if (typeof value !== "string" || !UINT.test(value)) {
    throw new IntentsError("validation", `${field} must be a base-unit integer string, got ${describe(value)}`);
  }
  const n = BigInt(value);
  if (n > MAX_UINT256) throw new IntentsError("validation", `${field} exceeds uint256`);
  return n;
}

/** Like parseBaseUnits but also rejects zero. Returns the canonical string. */
export function assertPositiveBaseUnits(value: unknown, field = "amount"): string {
  const n = parseBaseUnits(value, field);
  if (n === 0n) throw new IntentsError("validation", `${field} must be greater than zero`);
  return n.toString();
}

/** Converts a human decimal ("0.15") to base units for `decimals` places ("150000" for 6). */
export function toBaseUnits(decimal: string, decimals: number): string {
  assertDecimals(decimals);
  if (!DECIMAL.test(decimal)) {
    throw new IntentsError("validation", `not a plain decimal amount: ${describe(decimal)}`);
  }
  const [whole = "0", frac = ""] = decimal.split(".");
  if (frac.length > decimals) {
    throw new IntentsError("validation", `${decimal} has more than ${decimals} fractional digits`);
  }
  const n = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (n > MAX_UINT256) throw new IntentsError("validation", "amount exceeds uint256");
  return n.toString();
}

/** Formats base units for display ("150000", 6 → "0.15"). Display only; never parse it back for execution. */
export function formatBaseUnits(value: string, decimals: number): string {
  assertDecimals(decimals);
  const n = parseBaseUnits(value);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new IntentsError("validation", `invalid token decimals: ${decimals}`);
  }
}

function describe(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : typeof v;
}
