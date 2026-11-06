import { describe, expect, it, vi } from "vitest";
import { FixtureReader } from "../src/reader/fixture.js";
import { bandForScore } from "../src/exposure/engine.js";
import { a, a2, checks, EXCHANGE_ADDR, eth, OFAC_ADDR, profile, readJson, scan, T, tx } from "./helpers.js";

const W1 = a(1);
const W2 = a(2);
const W3 = a(3);
const EXT = a(9);

describe("check A: exchange link", () => {
  it("fires when a wallet transacted with a labelled exchange", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [tx(EXCHANGE_ADDR, W1, eth(1), T - 100, 1)],
        },
      }),
    );
    expect(checks(r)).toContain("A");
    const f = r.findings.find((f) => f.check === "A")!;
    expect(f.points).toBe(25);
    expect(f.evidence.label).toBe("coinbase");
    expect(f.evidence.txHashes?.length).toBe(1);
  });

  it("does not fire for an unlabelled counterparty", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [tx(EXT, W1, eth(1), T - 100, 1)],
        },
      }),
    );
    expect(checks(r)).not.toContain("A");
  });
});

describe("check B: public name", () => {
  it("fires when the wallet has an ENS name", async () => {
    const r = await scan(
      profile({ [W1]: { chain: "ethereum", ensName: "victim.eth" } }),
    );
    expect(checks(r)).toContain("B");
    expect(r.findings[0]!.evidence.name).toBe("victim.eth");
  });

  it("fires for an existing named .near account", async () => {
    const r = await scan(
      profile(
        {},
        {
          wallets: [{ chain: "near", address: "victim.near" }],
          nearAccounts: { "victim.near": { exists: true } },
        },
      ),
    );
    expect(checks(r)).toContain("B");
  });

  it("does not fire with no name", async () => {
    const r = await scan(profile({ [W1]: { chain: "ethereum" } }));
    expect(checks(r)).not.toContain("B");
  });
});

describe("check C: first funder", () => {
  it("fires when the first funder is an exchange", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(EXCHANGE_ADDR, W1, eth(1), T - 200, 1),
            tx(EXT, W1, eth(1), T - 100, 2),
          ],
        },
      }),
    );
    const f = r.findings.find((f) => f.check === "C")!;
    expect(f.evidence.label).toBe("coinbase");
  });

  it("fires when the first funder is another scanned wallet", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", transactions: [tx(W1, W2, eth(1), T, 1)] },
        [W2]: { chain: "ethereum", transactions: [tx(W1, W2, eth(1), T, 1)] },
      }),
    );
    const f = r.findings.find((f) => f.check === "C" && f.wallet === W2)!;
    expect(f.linkedWallets).toContain(W1);
  });

  it("does not fire when the first funder is unlabelled and not scanned", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", transactions: [tx(EXT, W1, eth(1), T, 1)] },
      }),
    );
    expect(checks(r)).not.toContain("C");
  });
});

describe("check D: shared destination", () => {
  const shared = [
    tx(W1, EXT, eth(0.1), T, 1),
    tx(W2, EXT, eth(0.2), T + 60, 2),
  ];
  it("fires when two scanned wallets send to the same destination", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", transactions: [shared[0]!] },
        [W2]: { chain: "ethereum", transactions: [shared[1]!] },
      }),
    );
    expect(checks(r, W1)).toContain("D");
    expect(checks(r, W2)).toContain("D");
  });

  it("does not fire for distinct destinations", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", transactions: [tx(W1, EXT, eth(0.1), T, 1)] },
        [W2]: { chain: "ethereum", transactions: [tx(W2, a(8), eth(0.2), T, 2)] },
      }),
    );
    expect(checks(r)).not.toContain("D");
  });
});

describe("check E: direct transfer", () => {
  const t = tx(W1, W2, eth(0.5), T, 1);
  it("fires on both sides of a transfer between scanned wallets", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", transactions: [t] },
        [W2]: { chain: "ethereum", transactions: [t] },
      }),
    );
    expect(checks(r, W1)).toContain("E");
    expect(checks(r, W2)).toContain("E");
  });

  it("does not fire when the recipient is not scanned", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", transactions: [t] },
        [W3]: { chain: "ethereum", transactions: [] },
      }),
    );
    expect(checks(r)).not.toContain("E");
  });
});

describe("check F: public key exposed", () => {
  it("fires when nonce > 0", async () => {
    const r = await scan(profile({ [W1]: { chain: "ethereum", nonce: 1 } }));
    expect(checks(r)).toContain("F");
  });
  it("does not fire when nonce is 0", async () => {
    const r = await scan(profile({ [W1]: { chain: "ethereum", nonce: 0 } }));
    expect(checks(r)).not.toContain("F");
  });
});

describe("check G: shared send-time fingerprint", () => {
  const at = (h: number, n: number) => 1760544000 + h * 3600 + n * 60; // same day, hour h
  it("fires when two wallets share their top send hour", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(W1, EXT, eth(0.11), at(14, 1), 1),
            tx(W1, a(8), eth(0.12), at(14, 2), 2),
          ],
        },
        [W2]: {
          chain: "ethereum",
          transactions: [
            tx(W2, a(7), eth(0.13), at(14, 3), 3),
            tx(W2, a(6), eth(0.14), at(14, 4), 4),
          ],
        },
      }),
    );
    expect(checks(r, W1)).toContain("G");
    expect(checks(r, W2)).toContain("G");
  });

  it("does not fire for different top hours", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(W1, EXT, eth(0.11), at(3, 1), 1),
            tx(W1, a(8), eth(0.12), at(3, 2), 2),
          ],
        },
        [W2]: {
          chain: "ethereum",
          transactions: [
            tx(W2, a(7), eth(0.13), at(14, 3), 3),
            tx(W2, a(6), eth(0.14), at(14, 4), 4),
          ],
        },
      }),
    );
    expect(checks(r)).not.toContain("G");
  });
});

describe("check H: repeated or round amounts", () => {
  it("fires for two round-amount sends", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(W1, EXT, eth(1), T, 1),
            tx(W1, a(8), eth(0.5), T + 60, 2),
          ],
        },
      }),
    );
    expect(checks(r)).toContain("H");
  });

  it("fires for a repeated non-round amount", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(W1, EXT, "123456789000000000", T, 1),
            tx(W1, a(8), "123456789000000000", T + 60, 2),
          ],
        },
      }),
    );
    expect(checks(r)).toContain("H");
  });

  it("does not fire for a single round send", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [tx(W1, EXT, eth(1), T, 1)],
        },
      }),
    );
    expect(checks(r)).not.toContain("H");
  });
});

describe("check I: approval to a scanned wallet", () => {
  it("fires on both wallets", async () => {
    const approval = {
      txHash: "0x" + "9".repeat(64),
      chain: "ethereum",
      token: a(5),
      owner: W1,
      spender: W2,
    };
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", approvals: [approval] },
        [W2]: { chain: "ethereum" },
      }),
    );
    expect(checks(r, W1)).toContain("I");
    expect(checks(r, W2)).toContain("I");
  });

  it("does not fire when the spender is not scanned", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          approvals: [
            {
              txHash: "0x" + "9".repeat(64),
              chain: "ethereum",
              token: a(5),
              owner: W1,
              spender: EXT,
            },
          ],
        },
      }),
    );
    expect(checks(r)).not.toContain("I");
  });
});

describe("scoring", () => {
  it("floors at 50 when check A fires alone", async () => {
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [tx(EXCHANGE_ADDR, W1, eth(1), T - 100, 1)],
        },
      }),
    );
    expect(checks(r)).toEqual(new Set(["A", "C"])); // first funder is the exchange too
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.band).toBe("identifiable");
  });

  it("dedupes each check once for the set: two wallets with only F score 5", async () => {
    const r = await scan(
      profile({
        [W1]: { chain: "ethereum", nonce: 2 },
        [W2]: { chain: "ethereum", nonce: 4 },
      }),
    );
    expect(r.findings.filter((f) => f.check === "F")).toHaveLength(2);
    expect(r.score).toBe(5);
  });

  it("floors at 50 when A fires on one wallet and B on another", async () => {
    // A(25) + B(20) = 45 -> max(45, 50) = 50. The exchange tx is not the
    // first funder, so check C does not add anything.
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(EXT, W1, eth(1), T - 200, 1),
            tx(EXCHANGE_ADDR, W1, eth(1), T - 100, 2),
          ],
        },
        [W2]: { chain: "ethereum", ensName: "named.eth" },
      }),
    );
    expect(checks(r)).toEqual(new Set(["A", "B"]));
    expect(r.score).toBe(50);
  });

  it("never exceeds the 100 cap (all nine checks = 98.5)", async () => {
    // Fires every check A-I; per-check-once scoring tops out at
    // 25+20+15+15+10+5+4+1.5+3 = 98.5.
    const r = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          nonce: 3,
          ensName: "a.eth",
          transactions: [
            tx(EXCHANGE_ADDR, W1, eth(1), T - 100, 1),
            tx(W1, W2, eth(1), T + 300, 2),
            tx(W1, EXT, eth(0.5), T + 400, 3),
            tx(W1, a(8), eth(1), T + 500, 4),
            tx(W1, a(7), eth(0.33), T + 600, 5),
          ],
          approvals: [
            { txHash: "0x" + "8".repeat(64), chain: "ethereum", token: a(5), owner: W1, spender: W2 },
          ],
        },
        [W2]: {
          chain: "ethereum",
          nonce: 2,
          transactions: [
            tx(W1, W2, eth(1), T + 300, 2),
            tx(W2, EXT, eth(0.4), T + 700, 6),
            tx(W2, a(6), eth(0.4), T + 800, 7),
          ],
        },
      }),
    );
    expect(checks(r)).toEqual(new Set(["A", "B", "C", "D", "E", "F", "G", "H", "I"]));
    expect(r.score).toBe(98.5);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.band).toBe("doxxed");
  });

  it("bands: 0-19 clean, 20-49 linkable, 50-79 identifiable, 80-100 doxxed", () => {
    expect(bandForScore(0)).toBe("clean");
    expect(bandForScore(19)).toBe("clean");
    expect(bandForScore(20)).toBe("linkable");
    expect(bandForScore(49)).toBe("linkable");
    expect(bandForScore(50)).toBe("identifiable");
    expect(bandForScore(79)).toBe("identifiable");
    expect(bandForScore(80)).toBe("doxxed");
    expect(bandForScore(100)).toBe("doxxed");
  });
});

describe("inherited identity (A and B)", () => {
  // Wallet 1 carries the identity hits (exchange counterparty + ENS); the
  // wallets are clustered by a direct transfer (E). The first funder is
  // unlabelled so check C stays out of the arithmetic.
  const accounts = {
    [W1]: {
      chain: "ethereum",
      ensName: "victim.eth",
      transactions: [
        tx(EXT, W1, eth(1), T - 200, 1),
        tx(EXCHANGE_ADDR, W1, eth(1), T - 100, 2),
        tx(W1, W2, eth(0.5), T, 3),
      ],
    },
    [W2]: {
      chain: "ethereum",
      // Funded first by an unlabelled address so check C does not fire; the
      // later W1->W2 transfer only creates the E link.
      transactions: [
        tx(EXT, W2, eth(0.2), T - 300, 4),
        tx(W1, W2, eth(0.5), T, 3),
      ],
    },
  };

  it("a clustered wallet inherits A and B and the floor of 50", async () => {
    const r = await scan(profile(accounts));
    const w2 = r.wallets.find((w) => w.wallet.address.toLowerCase() === W2)!;

    const inherited = w2.findings.filter(
      (f) => (f.check === "A" || f.check === "B") && f.wallet === W2,
    );
    expect(new Set(inherited.map((f) => f.check))).toEqual(new Set(["A", "B"]));
    for (const f of inherited) {
      expect(f.detail).toContain("inherited");
      expect(f.detail).toContain(W1);
      expect(f.linkedWallets).toContain(W1);
    }
    expect(w2.score).toBeGreaterThanOrEqual(50);
    expect(["identifiable", "doxxed"]).toContain(w2.band);

    // Set-level scoring still counts each check once: A(25)+B(20)+E(10) = 55.
    expect(r.score).toBe(55);
  });

  it("does not invent A or B for the same wallet scanned alone", async () => {
    const p = profile(accounts, {
      wallets: [{ chain: "ethereum", address: W2 }],
    });
    const r = await scan(p);
    expect(checks(r, W2)).not.toContain("A");
    expect(checks(r, W2)).not.toContain("B");
    expect(r.score).toBeLessThan(50);
    expect(r.wallets).toHaveLength(1);
  });
});

describe("sample fixtures", () => {
  it("exposed sample fires all checks, both warnings, identifiable/doxxed", async () => {
    const p = readJson("../fixtures/sample-wallets/exposed.json");
    const r = await scan(p);
    expect(checks(r)).toEqual(
      new Set(["A", "B", "C", "D", "E", "F", "G", "H", "I"]),
    );
    expect(r.warnings.map((w) => w.kind).sort()).toEqual([
      "address-poisoning",
      "sanctioned-counterparty",
    ]);
    expect(["identifiable", "doxxed"]).toContain(r.band);
  });
});

describe("warnings", () => {
  it("flags sanctioned counterparties and poisoning without changing the score", async () => {
    const withWarnings = await scan(
      profile({
        [W1]: {
          chain: "ethereum",
          transactions: [
            tx(W1, OFAC_ADDR, eth(0.1), T, 1),
            tx(a2(1), W1, "5000", T + 10, 2),
          ],
        },
      }),
    );
    const without = await scan(
      profile({ [W1]: { chain: "ethereum", transactions: [] } }),
    );
    expect(withWarnings.warnings.map((w) => w.kind).sort()).toEqual([
      "address-poisoning",
      "sanctioned-counterparty",
    ]);
    expect(withWarnings.score).toBe(without.score);
  });
});

describe("FixtureReader", () => {
  it("makes no network calls", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network is off"));
    const p = profile({
      [W1]: {
        chain: "ethereum",
        nonce: 2,
        balanceWei: eth(1),
        transactions: [tx(EXT, W1, eth(1), T, 1)],
      },
    });
    const r = await scanWalletsProfile(p);
    expect(r.wallets[0]!.score).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

async function scanWalletsProfile(p: Parameters<typeof scan>[0]) {
  return scan(p);
}
