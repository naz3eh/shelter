/**
 * Assets a burner can be funded with, on Base (chain 8453).
 *
 * 1Click asset ids and the USDC deposit minimum were checked live on
 * 2026-11-08 and again on 2026-11-12, the ETH minimum on 2026-11-12, with dry
 * deposit quotes (docs/backend/ONECLICK.md). The USDC contract is Circle's native USDC on
 * Base, the token behind the 1Click asset id.
 */

export const BASE_CHAIN_ID = 8453;

export interface BurnerAsset {
  key: "usdc" | "eth";
  symbol: string;
  decimals: number;
  /** 1Click asset id. */
  assetId: string;
  /** ERC-20 contract; absent for the native asset. */
  token?: `0x${string}`;
  /** Smallest amount 1Click accepts as a deposit from Base (a sweep below it is left as dust). */
  depositMinimum: bigint;
}

export const USDC_BASE: BurnerAsset = {
  key: "usdc",
  symbol: "USDC",
  decimals: 6,
  assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  depositMinimum: 150_000n,
};

export const ETH_BASE: BurnerAsset = {
  key: "eth",
  symbol: "ETH",
  decimals: 18,
  assetId: "nep141:base.omft.near",
  // 1e11 wei (0.0000001 ETH): smaller dry deposit quotes are refused with
  // "try at least 100000000000". The burner engine still never sweeps its
  // ETH (a burner's gas leftover is not worth a transfer); Connect does.
  depositMinimum: 100_000_000_000n,
};

export const BURNER_ASSETS = { usdc: USDC_BASE, eth: ETH_BASE } as const;
export type BurnerAssetKey = keyof typeof BURNER_ASSETS;
