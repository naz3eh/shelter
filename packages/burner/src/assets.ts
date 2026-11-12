/**
 * Assets a burner can be funded with, on Base (chain 8453).
 *
 * 1Click asset ids and the deposit minimum were checked live on 2026-11-08
 * (docs/backend/ONECLICK.md). The USDC contract is Circle's native USDC on
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
  // Not measured for native ETH; a gas leftover is far below any useful
  // sweep, so the engine never tries to sweep ETH.
  depositMinimum: 2n ** 255n,
};

export const BURNER_ASSETS = { usdc: USDC_BASE, eth: ETH_BASE } as const;
export type BurnerAssetKey = keyof typeof BURNER_ASSETS;
