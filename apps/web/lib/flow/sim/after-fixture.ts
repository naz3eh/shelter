/**
 * Builds the fictional "after" dataset for the re-scan. The new destination
 * set is generated here in the web app — the recorded core fixtures are never
 * touched. Every address, hash and amount is deterministic fiction derived
 * from the approved plan and the completed simulation; nothing here claims a
 * real mainnet move happened.
 */

import type {
  FixtureAccount,
  FixtureProfile,
  TokenTransferRecord,
  TxRecord,
} from "@shelter/core";
import { decimalToBase, ETH_DECIMALS } from "../money";
import { demoAddress } from "../plan";
import type {
  BurnerPlan,
  BurnerSimSnapshot,
  MoveSimSnapshot,
  SampleId,
} from "../types";

/** Base USDC contract — same address the core fixtures use for token transfers. */
export const USDC_BASE_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** Fictional timestamps, deterministic per chunk/leg. */
const AFTER_EPOCH = 1767225600; // 2026-01-01T00:00:00Z, arbitrary fiction

async function fictionalHash(
  kind: string,
  seed: string,
  index: number,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`shelter:demo:tx:${kind}:${seed}:${index}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

export interface AfterProfileResult {
  profile: FixtureProfile;
  /** Human-readable notes for the comparison UI. */
  notes: string[];
  /** Which simulated chunks produced funded destinations. */
  fundedChunks: number;
  totalChunks: number;
  burnerIncluded: boolean;
}

/**
 * The post-move wallet set: one entry per chunk whose USDC leg completed,
 * plus the burner when it has any recorded history. Wallets that never
 * finished funding are left out — the UI explains the partial case instead
 * of hiding it.
 */
export async function buildAfterProfile(input: {
  profileId: SampleId;
  planHash: string;
  moveSim: MoveSimSnapshot;
  burnerSim: BurnerSimSnapshot | null;
  burnerPlan: BurnerPlan | null;
}): Promise<AfterProfileResult> {
  const { moveSim, burnerSim, burnerPlan, planHash, profileId } = input;
  const notes: string[] = [];
  const wallets: FixtureProfile["wallets"] = [];
  const accounts: Record<string, FixtureAccount> = {};

  const funded = moveSim.chunks.filter((c) => c.usdcWithdrawn);
  for (const chunk of funded) {
    const addr = chunk.destination.toLowerCase();
    wallets.push({
      chain: "base",
      address: chunk.destination,
      label: `fresh destination ${chunk.index + 1} (fictional)`,
    });

    const payoutUsdc = await demoAddress("payout-usdc", planHash, chunk.index);
    const payoutEth = await demoAddress("payout-eth", planHash, chunk.index);
    const tsBase = AFTER_EPOCH + chunk.index * 7200;

    const transactions: TxRecord[] = [
      {
        hash: await fictionalHash("fund-eth", planHash, chunk.index),
        chain: "base",
        from: payoutEth,
        to: addr,
        valueWei: chunk.ethWei,
        timestamp: tsBase + 60,
      },
    ];
    const tokenTransfers: TokenTransferRecord[] = [
      {
        hash: await fictionalHash("fund-usdc", planHash, chunk.index),
        chain: "base",
        token: USDC_BASE_CONTRACT,
        symbol: "USDC",
        from: payoutUsdc,
        to: addr,
        value: chunk.usdcBase,
        timestamp: tsBase,
      },
    ];

    accounts[addr] = {
      chain: "base",
      balanceWei: chunk.ethWei,
      nonce: 0,
      ensName: null,
      transactions,
      tokenTransfers,
      approvals: [],
    };
  }

  if (moveSim.chunks.length > funded.length) {
    notes.push(
      `${moveSim.chunks.length - funded.length} of ${moveSim.chunks.length} chunks never completed funding — those funds stay on the original wallets, which keep their exposure.`,
    );
  }

  let burnerIncluded = false;
  if (burnerSim && burnerPlan) {
    const actionStep = burnerSim.steps.find((s) => s.id === "action");
    const fundedSteps = burnerSim.steps.filter(
      (s) => s.id === "fund-usdc" || s.id === "fund-eth",
    );
    const hasHistory =
      actionStep?.status === "completed" ||
      fundedSteps.some((s) => s.status === "completed");
    if (hasHistory) {
      burnerIncluded = true;
      const addr = burnerSim.burnerAddress.toLowerCase();
      wallets.push({
        chain: "base",
        address: burnerSim.burnerAddress,
        label: "used burner (fictional)",
      });

      const payoutUsdc = await demoAddress("payout-usdc", planHash, 90);
      const payoutEth = await demoAddress("payout-eth", planHash, 90);
      const tsBase = AFTER_EPOCH + 90000;
      const used = actionStep?.status === "completed";

      const transactions: TxRecord[] = [
        {
          hash: await fictionalHash("burner-fund-eth", planHash, 0),
          chain: "base",
          from: payoutEth,
          to: addr,
          valueWei: burnerPlan.fundingEthWei,
          timestamp: tsBase,
        },
      ];
      const tokenTransfers: TokenTransferRecord[] = [
        {
          hash: await fictionalHash("burner-fund-usdc", planHash, 0),
          chain: "base",
          token: USDC_BASE_CONTRACT,
          symbol: "USDC",
          from: payoutUsdc,
          to: addr,
          value: burnerPlan.fundingUsdcBase,
          timestamp: tsBase - 60,
        },
      ];
      if (used) {
        tokenTransfers.push({
          hash: await fictionalHash("burner-pay", planHash, 0),
          chain: "base",
          token: USDC_BASE_CONTRACT,
          symbol: "USDC",
          from: addr,
          to: burnerPlan.payment.recipient.toLowerCase(),
          value: burnerPlan.payment.amountUsdcBase,
          timestamp: tsBase + 120,
        });
      }

      // A used burner has signed once: nonce 1 exposes its public key — the
      // scanner will (correctly) report check F for it. dustEth is the ETH
      // remaining after the run; before any terminal state, fall back to the
      // planned funding amount.
      const remainingEthWei = burnerSim.dustEth
        ? (decimalToBase(burnerSim.dustEth, ETH_DECIMALS) ?? 0n).toString()
        : burnerPlan.fundingEthWei;
      accounts[addr] = {
        chain: "base",
        balanceWei: remainingEthWei,
        nonce: used ? 1 : 0,
        ensName: null,
        transactions,
        tokenTransfers,
        approvals: [],
      };
    }
  }

  notes.push(
    "Post-move dataset is fictional and generated by this demo from the approved plan — it is not a real mainnet record and proves nothing about unlinkability.",
  );
  notes.push(
    "The original wallets' public history is not erased: their deposits to Intents addresses remain visible, and any unmoved funds stay exposed.",
  );

  return {
    profile: {
      name: `post-move-${profileId}`,
      wallets,
      accounts,
    },
    notes,
    fundedChunks: funded.length,
    totalChunks: moveSim.chunks.length,
    burnerIncluded,
  };
}
