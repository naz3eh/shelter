/**
 * Display helpers for the Connect screens: shortening, Basescan links,
 * amounts and friendly identity labels. Pure functions, no package imports.
 */

export const BASESCAN_TX = (hash: string) => `https://basescan.org/tx/${hash}`;
export const BASESCAN_ADDRESS = (address: string) => `https://basescan.org/address/${address}`;

export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Base units -> trimmed decimal string with symbol, e.g. "1.5 USDC". */
export function formatToken(amount: string, decimals: number, symbol: string): string {
  try {
    const v = BigInt(amount);
    const s = v.toString().padStart(decimals + 1, "0");
    const int = s.slice(0, s.length - decimals) || "0";
    const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 8) : "";
    return `${int}${frac ? `.${frac}` : ""} ${symbol}`;
  } catch {
    return `${amount} ${symbol}`;
  }
}

/** Wei -> ETH string with up to 6 decimals, trailing zeros trimmed. */
export function formatEth(wei: string): string {
  return formatToken(wei, 18, "ETH");
}

/**
 * The label a person sees for an identity in findings and lists: the
 * confidential-balance owner reads "your NEAR account", linked entries keep
 * their recorded label ("your main wallet"), anything else is its id.
 */
export function identityLabel(
  id: string,
  opts: { owner?: string; linked?: { id: string; label: string }[] },
): string {
  if (opts.owner && id.toLowerCase() === opts.owner.toLowerCase()) return "your NEAR account";
  const hit = opts.linked?.find((l) => l.id.toLowerCase() === id.toLowerCase());
  if (hit) return hit.label;
  return shortAddress(id);
}

/** Replace full 0x addresses inside a finding message with shortened forms. */
export function shortenAddresses(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, (m) => shortAddress(m));
}
