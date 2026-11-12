/**
 * The recorded mainnet run that `pnpm demo --dry-run` replays (G9).
 *
 * A recording holds only data that is public once used: 1Click quotes with
 * their signed wire responses, 1Click status reads, the signed withdrawal
 * intents and the burner's signed transactions. No key, seed, passphrase
 * or token. It does tie the owner's NEAR account to the burner and the
 * payee, so publishing it gives up the privacy of that demo run.
 *
 * The replay makes no network call. Everything it calls verified is
 * checked offline from the recording itself:
 * - every quote's ed25519 signature against the 1Click manager key;
 * - every signed intent's NEP-413 signature against the signer's key, and
 *   that it pays the quote's deposit address from the owner's account;
 * - every burner transaction: its hash is the keccak of the signed bytes,
 *   its sender recovers to the burner, and it does exactly the recorded
 *   transfer on Base.
 */

import type { BurnerJob, FundingLeg, SignedTx } from "@shelter/burner";
import { BURNER_ASSETS, BASE_CHAIN_ID } from "@shelter/burner";
import { formatBaseUnits, verifyNep413, verifyQuoteSignature, type Quote, type StatusResult } from "@shelter/intents";
import { base64 } from "@scure/base";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";

export const RECORDING_FORMAT = "shelter-demo-recording";

export interface DepositRecord {
  quote: Quote;
  txHash?: string;
  statuses: { at: string; status: StatusResult }[];
}

export interface DemoRecording {
  format: typeof RECORDING_FORMAT;
  v: 1;
  recordedAt: string;
  network: "mainnet";
  owner: string;
  deposits: DepositRecord[];
  burners: BurnerJob[];
}

export function buildRecording(owner: string, deposits: DepositRecord[], burners: BurnerJob[], now = new Date()): DemoRecording {
  return {
    format: RECORDING_FORMAT,
    v: 1,
    recordedAt: now.toISOString(),
    network: "mainnet",
    owner,
    deposits,
    burners: burners.map(({ lease: _lease, ...j }) => j as BurnerJob),
  };
}

export function parseRecording(raw: unknown): DemoRecording {
  const r = raw as Partial<DemoRecording> | null;
  if (!r || r.format !== RECORDING_FORMAT || r.v !== 1 || !Array.isArray(r.deposits) || !Array.isArray(r.burners)) {
    throw new Error("not a shelter demo recording (format v1)");
  }
  return r as DemoRecording;
}

const scan = (hash: string) => `https://basescan.org/tx/${hash}`;

interface Report {
  ok: number;
  failed: string[];
}

function check(rep: Report, label: string, pass: boolean, indent = "     ") {
  console.log(`${indent}[${pass ? "PASS" : "FAIL"}] ${label}`);
  if (pass) rep.ok++;
  else rep.failed.push(label);
}

function fmt(assetId: string, amount: string): string {
  const a = Object.values(BURNER_ASSETS).find((x) => x.assetId === assetId);
  return a ? `${formatBaseUnits(amount, a.decimals)} ${a.symbol}` : `${amount} ${assetId}`;
}

function timeline(statuses: { at: string; status: StatusResult }[]): string {
  if (!statuses.length) return "no status recorded";
  const t0 = Date.parse(statuses[0]!.at);
  return statuses.map((s) => `${s.status.status} (+${Math.round((Date.parse(s.at) - t0) / 1000)} s)`).join(" -> ");
}

async function checkTx(rep: Report, tx: SignedTx, burner: `0x${string}`, expect: { token: `0x${string}`; to: string; amount: bigint }) {
  console.log(`     tx ${tx.hash}`);
  console.log(`        ${scan(tx.hash)}`);
  check(rep, "hash is the keccak-256 of the signed bytes", keccak256(tx.raw) === tx.hash, "        ");
  let sender: string | undefined;
  try {
    sender = await recoverTransactionAddress({ serializedTransaction: tx.raw as Hex & `0x02${string}` });
  } catch {
    /* reported below */
  }
  check(rep, `signed by the burner ${burner}`, sender !== undefined && getAddress(sender) === getAddress(burner), "        ");
  let ok = false;
  try {
    const p = parseTransaction(tx.raw);
    const d = decodeFunctionData({ abi: erc20Abi, data: p.data! });
    ok =
      p.chainId === BASE_CHAIN_ID &&
      getAddress(p.to!) === getAddress(expect.token) &&
      d.functionName === "transfer" &&
      getAddress(d.args[0] as string) === getAddress(expect.to) &&
      (d.args[1] as bigint) === expect.amount;
  } catch {
    ok = false;
  }
  check(rep, `on Base, transfers ${formatBaseUnits(expect.amount.toString(), 6)} USDC to ${expect.to}`, ok, "        ");
  if (tx.receipt) console.log(`        mined in block ${tx.receipt.blockNumber}, ${tx.receipt.status}, fee ${formatBaseUnits(tx.receipt.feeWei, 18)} ETH`);
}

function checkLeg(rep: Report, job: BurnerJob, leg: FundingLeg, which: string) {
  const asset = BURNER_ASSETS[leg.asset];
  const pay = BURNER_ASSETS[leg.payWith ?? leg.asset];
  console.log(`   ${which}: ${formatBaseUnits(leg.amount, asset.decimals)} ${asset.symbol} into the burner, paid in ${pay.symbol} from the confidential balance`);
  leg.attempts.forEach((a, i) => {
    const q = a.quote;
    console.log(`     attempt ${i + 1}: pays ${fmt(q.request.originAssetId, q.amountIn)} for ${fmt(q.request.destinationAssetId, q.amountOut)}, outcome ${a.outcome ?? "unfinished"}`);
    check(rep, `1Click quote ${q.quoteId} signature`, verifyQuoteSignature(q.wire));
    check(rep, `confidentiality ${q.confidentiality}`, q.confidentiality === "advanced");
    if (a.prepared) {
      const sd = a.prepared.signedData;
      const sigOk = verifyNep413(
        { message: sd.payload.message, nonce: base64.decode(sd.payload.nonce), recipient: sd.payload.recipient },
        sd.public_key,
        sd.signature,
      );
      check(rep, `withdrawal intent signed by ${job.owner} (${sd.public_key}) on ${sd.payload.recipient}`, sigOk);
      let shapeOk = false;
      try {
        const m = JSON.parse(sd.payload.message) as { signer_id: string; intents: { intent: string; receiver_id: string }[] };
        shapeOk = m.signer_id === job.owner && m.intents.every((t) => t.intent === "transfer" && t.receiver_id === q.depositAddress);
      } catch {
        shapeOk = false;
      }
      check(rep, "intent only transfers to the quote's deposit address", shapeOk);
    }
    if (a.submitted?.intentHash) console.log(`     intent hash ${a.submitted.intentHash}`);
  });
  if (leg.confirmedBalance) console.log(`     burner balance confirmed on chain: ${formatBaseUnits(leg.confirmedBalance, asset.decimals)} ${asset.symbol}`);
}

/** Prints the replay and returns the number of failed checks. */
export async function replay(rec: DemoRecording): Promise<number> {
  const rep: Report = { ok: 0, failed: [] };
  console.log(`Shelter demo replay: a mainnet run recorded ${rec.recordedAt} by ${rec.owner}.`);
  console.log("No network, keys or funds are used; every check below runs on the recorded data.\n");

  rec.deposits.forEach((d, i) => {
    const q = d.quote;
    console.log(`${i + 1}. Private deposit into the confidential balance of ${q.request.recipient}`);
    console.log(`   send ${fmt(q.request.originAssetId, q.amountIn)} on Base to 1Click deposit address ${q.depositAddress}`);
    check(rep, `1Click quote ${q.quoteId} signature`, verifyQuoteSignature(q.wire), "   ");
    check(rep, `confidentiality ${q.confidentiality}, refunds to the confidential balance`, q.confidentiality === "advanced" && q.request.refundType === "CONFIDENTIAL_INTENTS", "   ");
    if (d.txHash) console.log(`   deposit tx ${scan(d.txHash)}`);
    console.log(`   status ${timeline(d.statuses)}`);
    const last = d.statuses.at(-1)?.status;
    for (const t of last?.originChainTxs ?? []) console.log(`   origin tx ${t.explorerUrl || t.hash}`);
    console.log("");
  });

  for (const [k, job] of rec.burners.entries()) {
    const n = rec.deposits.length + k + 1;
    const asset = BURNER_ASSETS[job.action.asset];
    const amount = `${formatBaseUnits(job.action.amount, asset.decimals)} ${asset.symbol}`;
    const hold = job.action.kind === "hold";
    const act = job.action;
    console.log(
      act.kind === "hold"
        ? `${n}. Private payout ${job.id}: a fresh address receives ${amount} plus gas from the confidential balance`
        : `${n}. Burner action ${job.id}: send ${amount} to ${act.to}`,
    );
    console.log(`   ${hold ? "payout address" : "burner"} ${job.burner?.address ?? "(not allocated)"}, final state ${job.status}/${job.step}`);
    job.gas.forEach((leg, i) => checkLeg(rep, job, leg, i === 0 ? "gas" : `gas top-up ${i}`));
    if (job.asset) checkLeg(rep, job, job.asset, "asset");
    if (job.act?.tx && job.burner && job.action.kind === "erc20_transfer") {
      console.log(`   action (${job.act.outcome ?? "unconfirmed"})`);
      await checkTx(rep, job.act.tx, job.burner.address, { token: asset.token!, to: job.action.to, amount: BigInt(job.action.amount) });
    }
    const sw = job.sweep;
    if (sw) {
      console.log(`   after the action: ${formatBaseUnits(sw.assetLeft ?? "0", asset.decimals)} ${asset.symbol} and ${formatBaseUnits(sw.ethLeft ?? "0", 18)} ETH left; ${sw.decision}`);
      if (sw.tx && job.burner && sw.quote?.depositAddress) {
        await checkTx(rep, sw.tx, job.burner.address, { token: asset.token!, to: sw.quote.depositAddress, amount: BigInt(sw.quote.amountIn) });
      }
    }
    if (hold) {
      console.log(`   payout address kept for later use; it has never sent a transaction\n`);
    } else {
      const retired = job.events.some((e) => e.message.endsWith("retired"));
      console.log(`   burner ${retired ? "retired: never used again" : "not retired yet"}\n`);
    }
  }

  console.log(`${rep.ok} checks passed, ${rep.failed.length} failed.`);
  for (const f of rep.failed) console.log(`  FAILED: ${f}`);
  return rep.failed.length;
}
