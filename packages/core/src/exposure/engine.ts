import type { WalletRef } from "../index";
import { buildLinkGraph, type LinkGraph } from "../graph/index";
import { createLabelStore, type LabelStore } from "../labels/index";
import type {
  ApprovalRecord,
  ChainReader,
  TokenTransferRecord,
  TxRecord,
} from "../reader/types";

export type CheckId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

/** The nine exposure checks with their weights and finding kinds. */
export const CHECKS: Record<
  CheckId,
  { weight: number; kind: string; name: string }
> = {
  A: { weight: 25, kind: "cex-link", name: "exchange link" },
  B: { weight: 20, kind: "named-address", name: "public name (ENS/Basename/.near)" },
  C: { weight: 15, kind: "first-funder", name: "first funder is an exchange or your wallet" },
  D: { weight: 15, kind: "shared-destination", name: "shared destination across your wallets" },
  E: { weight: 10, kind: "direct-transfer", name: "direct transfer between your wallets" },
  F: { weight: 5, kind: "pubkey-exposed", name: "public key exposed (nonce > 0)" },
  G: { weight: 4, kind: "timing-fingerprint", name: "shared send-time fingerprint" },
  H: { weight: 3, kind: "round-amount", name: "repeated or round amounts" },
  I: { weight: 3, kind: "approval-link", name: "approval to another of your wallets" },
} as const;

/**
 * Confidence applied per check. G's rule (a shared send-time fingerprint with
 * >= 2 outgoing txs each) is a definite hit when it fires, so only the
 * heuristic check H scores below 1.
 */
export const CHECK_CONFIDENCE: Record<CheckId, number> = {
  A: 1,
  B: 1,
  C: 1,
  D: 1,
  E: 1,
  F: 1,
  G: 1,
  H: 0.5,
  I: 1,
} as const;

export type ExposureBand = "clean" | "linkable" | "identifiable" | "doxxed";

export interface FindingEvidence {
  txHashes?: string[];
  name?: string;
  label?: string;
  addresses?: string[];
}

export interface ExposureFinding {
  check: CheckId;
  kind: string;
  /** The scanned wallet this finding applies to. */
  wallet: string;
  weight: number;
  /** 0-1; points = weight * confidence, capped at weight. */
  confidence: number;
  points: number;
  detail: string;
  /** Other scanned wallet addresses this finding links, if any. */
  linkedWallets?: string[];
  evidence: FindingEvidence;
}

export interface ScanWarning {
  kind: "address-poisoning" | "sanctioned-counterparty";
  wallet: string;
  detail: string;
  evidence: FindingEvidence;
}

export interface ExposureReport {
  wallet: WalletRef;
  /** 0 (private) to 100 (fully exposed). */
  score: number;
  band: ExposureBand;
  findings: ExposureFinding[];
  warnings: ScanWarning[];
}

export interface ScanReport {
  /** Headline number: worst-case exposure of the whole wallet set, 0-100. */
  score: number;
  band: ExposureBand;
  findings: ExposureFinding[];
  /** Zero-point warnings, listed separately: poisoning and OFAC hits. */
  warnings: ScanWarning[];
  /** How many of your wallets are linked to at least one other of yours. */
  linkedAddressCount: number;
  wallets: ExposureReport[];
  graph: LinkGraph;
}

export interface ScanOptions {
  labels?: LabelStore;
}

const SCORE_CAP = 100;
/** If check A or B fires the score can never fall below this. */
const NAMED_OR_EXCHANGE_FLOOR = 50;
/** Incoming value below this (wei) counts as dust for poisoning checks. */
const DUST_THRESHOLD_WEI = 10n ** 14n; // 0.0001 ETH
/** Outgoing amounts that are a whole multiple of this (wei) count as round. */
const ROUND_UNIT_WEI = 10n ** 17n; // 0.1 ETH

export function bandForScore(score: number): ExposureBand {
  if (score >= 80) return "doxxed";
  if (score >= 50) return "identifiable";
  if (score >= 20) return "linkable";
  return "clean";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const low = (a: string) => a.toLowerCase();

interface WalletData {
  wallet: WalletRef;
  addr: string;
  balanceWei: string;
  nonce: number;
  name: string | null;
  nearExists: boolean;
  txs: TxRecord[];
  tokenTransfers: TokenTransferRecord[];
  approvals: ApprovalRecord[];
}

const isNear = (w: WalletRef) =>
  w.chain === "near" || w.address.endsWith(".near");

/** Look-alike address: same visible prefix/suffix, different middle. */
const looksAlike = (a: string, b: string) =>
  a !== b && a.slice(0, 6) === b.slice(0, 6) && a.slice(-4) === b.slice(-4);

async function gather(wallets: WalletRef[], reader: ChainReader) {
  return Promise.all(
    wallets.map(async (wallet): Promise<WalletData> => {
      if (isNear(wallet)) {
        const info = await reader.getNearAccount(wallet.address);
        return {
          wallet,
          addr: low(wallet.address),
          balanceWei: "0",
          nonce: 0,
          name: info.exists ? wallet.address : null,
          nearExists: info.exists,
          txs: [],
          tokenTransfers: [],
          approvals: [],
        };
      }
      const [balanceWei, nonce, name, txs, tokenTransfers, approvals] =
        await Promise.all([
          reader.getBalance(wallet.chain, wallet.address),
          reader.getNonce(wallet.chain, wallet.address),
          reader.getEnsName(wallet.chain, wallet.address),
          reader.getTransactions(wallet.chain, wallet.address),
          reader.getTokenTransfers(wallet.chain, wallet.address),
          reader.getApprovals(wallet.chain, wallet.address),
        ]);
      return {
        wallet,
        addr: low(wallet.address),
        balanceWei,
        nonce,
        name,
        nearExists: false,
        txs,
        tokenTransfers,
        approvals,
      };
    }),
  );
}

function makeFinding(
  check: CheckId,
  wallet: string,
  detail: string,
  evidence: FindingEvidence,
  linkedWallets?: string[],
): ExposureFinding {
  const { weight, kind } = CHECKS[check];
  const confidence = CHECK_CONFIDENCE[check];
  return {
    check,
    kind,
    wallet,
    weight,
    confidence,
    points: round2(weight * confidence),
    detail,
    evidence,
    ...(linkedWallets?.length ? { linkedWallets } : {}),
  };
}

/**
 * Set score: each check contributes at most weight x confidence ONCE for the
 * whole wallet set (the max confidence across all findings of that check).
 * Firing A or B on any wallet floors the set score at 50. Secondary detail:
 * the same rule applied per wallet produces each wallet's own score.
 */
function checkDedupedScore(findings: ExposureFinding[]): number {
  const byCheck = new Map<CheckId, number>();
  for (const f of findings) {
    byCheck.set(f.check, Math.max(byCheck.get(f.check) ?? 0, f.points));
  }
  const total = [...byCheck.values()].reduce((s, p) => s + p, 0);
  const floored = byCheck.has("A") || byCheck.has("B")
    ? Math.max(total, NAMED_OR_EXCHANGE_FLOOR)
    : total;
  return round2(Math.min(SCORE_CAP, floored));
}

const outgoing = (d: WalletData) => d.txs.filter((t) => low(t.from) === d.addr);
const incoming = (d: WalletData) =>
  d.txs.filter((t) => t.to && low(t.to) === d.addr);
const outgoingTransfers = (d: WalletData) =>
  d.tokenTransfers.filter((t) => low(t.from) === d.addr);
const incomingTransfers = (d: WalletData) =>
  d.tokenTransfers.filter((t) => t.to && low(t.to) === d.addr);

function counterparties(d: WalletData): Map<string, string[]> {
  /** counterparty address -> tx hashes that connect it to the wallet. */
  const map = new Map<string, string[]>();
  const add = (other: string | null, hash: string) => {
    if (!other) return;
    const key = low(other);
    if (key === d.addr) return;
    map.set(key, [...(map.get(key) ?? []), hash]);
  };
  for (const t of d.txs)
    add(low(t.to ?? "") === d.addr ? t.from : t.to, t.hash);
  for (const t of d.tokenTransfers)
    add(low(t.to ?? "") === d.addr ? t.from : t.to, t.hash);
  return map;
}

export async function scanWallets(
  wallets: WalletRef[],
  reader: ChainReader,
  opts: ScanOptions = {},
): Promise<ScanReport> {
  const labels = opts.labels ?? createLabelStore();
  const data = await gather(wallets, reader);
  const scannedAddrs = new Set(data.map((d) => d.addr));

  const findings: ExposureFinding[] = [];
  const warnings: ScanWarning[] = [];

  // ---- per-wallet checks: A, B, C, F, H + warnings ---------------------

  for (const d of data) {
    const cps = counterparties(d);

    // A: exchange link
    const exchangeHits = [...cps.entries()].flatMap(([cp, hashes]) => {
      const label =
        labels.exchangeLabel(d.wallet.chain, cp) ?? labels.userLabel(cp);
      return label ? [{ cp, label, hashes }] : [];
    });
    if (exchangeHits.length) {
      findings.push(
        makeFinding(
          "A",
          d.addr,
          `transacted with ${exchangeHits.map((h) => h.label).join(", ")}`,
          {
            txHashes: [...new Set(exchangeHits.flatMap((h) => h.hashes))],
            label: exchangeHits.map((h) => h.label).join(", "),
            addresses: exchangeHits.map((h) => h.cp),
          },
        ),
      );
    }

    // B: public name
    if (d.name) {
      findings.push(
        makeFinding("B", d.addr, `publicly named ${d.name}`, {
          name: d.name,
        }),
      );
    }

    // C: first funder
    const funding = [...incoming(d), ...incomingTransfers(d)].sort(
      (a, b) => a.timestamp - b.timestamp,
    )[0];
    if (funding) {
      const funder = low(funding.from);
      const funderLabel = labels.exchangeLabel(d.wallet.chain, funder);
      if (funderLabel) {
        findings.push(
          makeFinding("C", d.addr, `first funded by ${funderLabel}`, {
            txHashes: [funding.hash],
            label: funderLabel,
            addresses: [funder],
          }),
        );
      } else if (scannedAddrs.has(funder)) {
        findings.push(
          makeFinding(
            "C",
            d.addr,
            `first funded by your wallet ${funder}`,
            { txHashes: [funding.hash], addresses: [funder] },
            [funder],
          ),
        );
      }
    }

    // F: public key exposed
    if (d.nonce > 0) {
      findings.push(
        makeFinding(
          "F",
          d.addr,
          `public key exposed: ${d.nonce} outgoing transactions`,
          { txHashes: outgoing(d).map((t) => t.hash).slice(0, 5) },
        ),
      );
    }

    // H: repeated or round amounts
    const values = outgoing(d).map((t) => BigInt(t.valueWei || "0"));
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v.toString(), (counts.get(v.toString()) ?? 0) + 1);
    const roundTxs = outgoing(d).filter((t) => {
      const v = BigInt(t.valueWei || "0");
      return v > 0n && v % ROUND_UNIT_WEI === 0n;
    });
    const repeated = [...counts.entries()].some(([, n]) => n >= 2);
    if (roundTxs.length >= 2 || repeated) {
      const evidenceTx = [
        ...new Set([
          ...roundTxs.map((t) => t.hash),
          ...(repeated
            ? outgoing(d)
                .filter((t) => (counts.get(t.valueWei) ?? 0) >= 2)
                .map((t) => t.hash)
            : []),
        ]),
      ];
      findings.push(
        makeFinding(
          "H",
          d.addr,
          `${roundTxs.length} round-amount sends${repeated ? " and repeated amounts" : ""}`,
          { txHashes: evidenceTx },
        ),
      );
    }

    // warnings: sanctioned counterparties
    const sanctionedHits = [...cps.entries()].filter(([cp]) =>
      labels.isSanctioned(cp),
    );
    const sanctionedSpenders = d.approvals
      .map((a) => low(a.spender))
      .filter((s) => labels.isSanctioned(s));
    if (sanctionedHits.length || sanctionedSpenders.length) {
      warnings.push({
        kind: "sanctioned-counterparty",
        wallet: d.addr,
        detail: `interacted with OFAC-sanctioned ${
          sanctionedHits.length + sanctionedSpenders.length === 1
            ? "address"
            : "addresses"
        }: ${[...sanctionedHits.map(([cp]) => cp), ...sanctionedSpenders].join(", ")}`,
        evidence: {
          txHashes: [
            ...new Set(sanctionedHits.flatMap(([, hashes]) => hashes)),
          ],
          label: "OFAC sanctioned",
        },
      });
    }

    // warnings: poisoning (dust in, or look-alike senders)
    const dust = [
      ...incoming(d).filter((t) => {
        const v = BigInt(t.valueWei || "0");
        return v > 0n && v < DUST_THRESHOLD_WEI;
      }),
    ];
    const dustTransfers = incomingTransfers(d).filter(
      (t) => BigInt(t.value || "0") > 0n && BigInt(t.value || "0") < 10n ** 4n,
    );
    const lookalikes = [...cps.keys()].filter((cp) =>
      [...scannedAddrs].some((w) => looksAlike(cp, w)),
    );
    if (dust.length || dustTransfers.length || lookalikes.length) {
      const parts: string[] = [];
      if (dust.length || dustTransfers.length)
        parts.push(`${dust.length + dustTransfers.length} dust transfer(s)`);
      if (lookalikes.length)
        parts.push(`look-alike sender(s): ${lookalikes.join(", ")}`);
      warnings.push({
        kind: "address-poisoning",
        wallet: d.addr,
        detail: `possible address poisoning: ${parts.join("; ")}`,
        evidence: {
          txHashes: [
            ...new Set([
              ...dust.map((t) => t.hash),
              ...dustTransfers.map((t) => t.hash),
            ]),
          ],
          ...(lookalikes.length ? { addresses: lookalikes } : {}),
        },
      });
    }
  }

  // ---- cross-wallet checks: D, E, G, I ----------------------------------

  // D: shared destination across scanned wallets (destinations outside the set)
  const destToWallets = new Map<string, Map<string, string[]>>();
  for (const d of data) {
    for (const t of [...outgoing(d), ...outgoingTransfers(d)]) {
      const dest = t.to ? low(t.to) : null;
      if (!dest || scannedAddrs.has(dest)) continue;
      const per = destToWallets.get(dest) ?? new Map<string, string[]>();
      per.set(d.addr, [...(per.get(d.addr) ?? []), t.hash]);
      destToWallets.set(dest, per);
    }
  }
  for (const [dest, per] of destToWallets) {
    if (per.size < 2) continue;
    const others = (a: string) => [...per.keys()].filter((w) => w !== a);
    for (const [addr, hashes] of per) {
      findings.push(
        makeFinding(
          "D",
          addr,
          `shares destination ${dest} with ${others(addr).join(", ")}`,
          { txHashes: hashes, addresses: [dest] },
          others(addr),
        ),
      );
    }
  }

  // E: direct transfers between scanned wallets
  for (const d of data) {
    for (const t of [...outgoing(d), ...outgoingTransfers(d)]) {
      const dest = t.to ? low(t.to) : null;
      if (!dest || !scannedAddrs.has(dest)) continue;
      findings.push(
        makeFinding("E", d.addr, `sent directly to your wallet ${dest}`, {
          txHashes: [t.hash],
          addresses: [dest],
        }, [dest]),
      );
      findings.push(
        makeFinding(
          "E",
          dest,
          `received directly from your wallet ${d.addr}`,
          { txHashes: [t.hash], addresses: [d.addr] },
          [d.addr],
        ),
      );
    }
  }

  // G: shared send-time fingerprint (top UTC hour of outgoing txs)
  const topHour = new Map<string, number>();
  for (const d of data) {
    const perHour = new Map<number, number>();
    for (const t of outgoing(d)) {
      const h = new Date(t.timestamp * 1000).getUTCHours();
      perHour.set(h, (perHour.get(h) ?? 0) + 1);
    }
    const best = [...perHour.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) topHour.set(d.addr, best[0]);
  }
  const hourGroups = new Map<number, string[]>();
  for (const [addr, h] of topHour) {
    hourGroups.set(h, [...(hourGroups.get(h) ?? []), addr]);
  }
  for (const [hour, addrs] of hourGroups) {
    if (addrs.length < 2) continue;
    for (const addr of addrs) {
      findings.push(
        makeFinding(
          "G",
          addr,
          `same send-time fingerprint as ${addrs.filter((a) => a !== addr).join(", ")} (mostly sends around ${hour}:00 UTC)`,
          {},
          addrs.filter((a) => a !== addr),
        ),
      );
    }
  }

  // I: approval from one scanned wallet to another scanned wallet
  for (const d of data) {
    for (const a of d.approvals) {
      const spender = low(a.spender);
      if (!scannedAddrs.has(spender)) continue;
      findings.push(
        makeFinding(
          "I",
          d.addr,
          `token approval granted to your wallet ${spender}`,
          { txHashes: [a.txHash], addresses: [spender] },
          [spender],
        ),
      );
      findings.push(
        makeFinding(
          "I",
          spender,
          `holds a token approval from your wallet ${d.addr}`,
          { txHashes: [a.txHash], addresses: [d.addr] },
          [d.addr],
        ),
      );
    }
  }

  // ---- inherited identity: A and B propagate across linked wallets ------
  // An observer who clustered the wallets can attach one wallet's identity to
  // the rest. Build connected components from the findings that carry
  // linkedWallets (C, D, E, G, I), then give every member of a component the
  // A and B findings held by any other member. Inherited findings keep the
  // same check, weight, confidence and points; the set-level score is
  // unchanged because each check still counts once via checkDedupedScore.
  // Non-identity checks (F, G, H, ...) never propagate.
  {
    const parent = new Map<string, string>();
    const find = (a: string): string => {
      let root = a;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cur = a;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const d of data) parent.set(d.addr, d.addr);
    for (const f of findings) {
      for (const w of f.linkedWallets ?? []) union(f.wallet, w);
    }
    const components = new Map<string, string[]>();
    for (const d of data) {
      const root = find(d.addr);
      components.set(root, [...(components.get(root) ?? []), d.addr]);
    }
    for (const members of components.values()) {
      if (members.length < 2) continue;
      for (const check of ["A", "B"] as const) {
        const source = findings.find(
          (f) => f.check === check && members.includes(f.wallet),
        );
        if (!source) continue;
        for (const member of members) {
          if (member === source.wallet) continue;
          if (findings.some((f) => f.check === check && f.wallet === member))
            continue;
          findings.push({
            ...source,
            wallet: member,
            detail: `inherited: clustered with ${source.wallet}, which ${source.detail}`,
            linkedWallets: [source.wallet],
            evidence: { ...source.evidence },
          });
        }
      }
    }
  }

  // ---- assemble ---------------------------------------------------------

  const linked = new Set<string>();
  for (const f of findings) {
    if (!f.linkedWallets) continue;
    linked.add(f.wallet);
    for (const w of f.linkedWallets) linked.add(w);
  }

  const perWallet: ExposureReport[] = data.map((d) => {
    const f = findings.filter((x) => x.wallet === d.addr);
    const w = warnings.filter((x) => x.wallet === d.addr);
    const score = checkDedupedScore(f);
    return { wallet: d.wallet, score, band: bandForScore(score), findings: f, warnings: w };
  });

  const score = checkDedupedScore(findings);
  return {
    score,
    band: bandForScore(score),
    findings,
    warnings,
    linkedAddressCount: linked.size,
    wallets: perWallet,
    graph: buildLinkGraph(
      data.map((d) => ({
        address: d.addr,
        chain: d.wallet.chain,
        transactions: d.txs,
        tokenTransfers: d.tokenTransfers,
        approvals: d.approvals,
      })),
      (chain, addr) =>
        labels.exchangeLabel(chain, addr) ??
        labels.userLabel(addr) ??
        (labels.isSanctioned(addr) ? "OFAC sanctioned" : null),
    ),
  };
}
