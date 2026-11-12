/** Address and account-id validation for each recipient/refund type. */

import { isAddress } from "viem";
import { IntentsError } from "./errors.js";

/**
 * Chains Shelter accepts as an external origin or destination. 1Click lists
 * many more; anything else is rejected rather than guessed at.
 */
export const SUPPORTED_EVM_CHAINS = new Set(["eth", "base"]);

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * An account id inside NEAR Intents / Confidential Intents: a NEAR named
 * account (alice.near), a 64-hex implicit account, or a lowercase 0x address
 * (the documented signer id for erc191 keys).
 */
export function isIntentsAccountId(v: string): boolean {
  return v.length >= 2 && v.length <= 64 && NEAR_ACCOUNT.test(v);
}

/** EVM address; mixed case must carry a valid EIP-55 checksum. */
export function isEvmAddress(v: string): boolean {
  return isAddress(v, { strict: true });
}

export function assertIntentsAccountId(v: string, field: string): void {
  if (!isIntentsAccountId(v)) throw new IntentsError("validation", `${field} is not a valid Intents account id`);
}

export function assertChainAddress(v: string, blockchain: string, field: string): void {
  if (!SUPPORTED_EVM_CHAINS.has(blockchain)) {
    throw new IntentsError("unsupported", `${field}: chain "${blockchain}" is not supported by Shelter`);
  }
  if (!isEvmAddress(v)) throw new IntentsError("validation", `${field} is not a valid EVM address`);
  if (/^0x0{40}$/i.test(v)) throw new IntentsError("validation", `${field} is the zero address`);
}
