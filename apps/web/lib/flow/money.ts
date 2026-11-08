/**
 * Decimal/base-unit helpers for the demo plan. All asset math uses integer
 * base units (USDC = 6 decimals, ETH = 18 decimals) or validated decimal
 * strings — never floats.
 */

export const USDC_DECIMALS = 6;
export const ETH_DECIMALS = 18;

/** Parse a non-negative decimal string into base units. Null when invalid. */
export function decimalToBase(
  value: string,
  decimals: number,
): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) return null;
  const base = BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return base;
}

/** Format integer base units as a decimal string without trailing zeros. */
export function baseToDecimal(base: bigint, decimals: number): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

export function baseToDecimalString(base: string, decimals: number): string {
  return baseToDecimal(BigInt(base), decimals);
}

/** "1234567" wei -> "0.001234567" ETH-ish display, trimmed. */
export function formatUnits(base: string, decimals: number): string {
  try {
    return baseToDecimal(BigInt(base), decimals);
  } catch {
    return base;
  }
}

export function isValidEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function shortenAddress(address: string, keep = 6): string {
  if (address.length <= keep * 2 + 2) return address;
  return `${address.slice(0, keep + 2)}…${address.slice(-keep)}`;
}

export function isNearAccountId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.trim());
}
