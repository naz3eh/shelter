import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, getAddress, maxUint256, stringToHex, verifyMessage, verifyTypedData } from "viem";
import type { RequestSource } from "../src/engine.js";
import { isConnectError, toRpcError } from "../src/errors.js";
import { Faults, MAIN, opened, ORIGIN, OUT, OWNER, rig, ROUTER, routerAbi, UNLISTED, untilDone, USDC, type Rig } from "./harness.js";

const src: RequestSource = { origin: ORIGIN, verified: "valid" };
const approveTx = (spender = ROUTER, amount = 2_000_000n) => ({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });
const swapTx = (recipient: `0x${string}`, amount = 2_000_000n, tokenOut: `0x${string}` = OUT) => ({
  to: ROUTER,
  data: encodeFunctionData({ abi: routerAbi, functionName: "swap", args: [USDC, amount, tokenOut, recipient] }),
});
const send = (r: Rig, id: string, from: `0x${string}`, tx: Record<string, unknown>, source: RequestSource = src) =>
  r.engine().handle(id, { method: "eth_sendTransaction", params: [{ from, ...tx }], rpcId: 1 }, source);

/** A swap done through the dapp: approve then swap, both sent. */
async function swapped(r: Rig) {
  const a = await opened(r);
  const self = a.address.address;
  await send(r, a.id, self, approveTx());
  await send(r, a.id, self, swapTx(self));
  return (await r.engine().get(a.id))!;
}

/** Crash at the k-th outside call from now. */
function crashIn(r: Rig, k: number, phase: "before" | "after") {
  const f = new Faults(r.world.faults.calls + k, phase);
  f.calls = r.world.faults.calls;
  r.world.faults = f;
}

async function rejectsWith(p: Promise<unknown>, kind: string, rpcCode?: number) {
  try {
    await p;
    expect.unreachable("expected a rejection");
  } catch (e) {
    expect(isConnectError(e), String(e)).toBe(true);
    expect((e as { kind: string }).kind).toBe(kind);
    if (rpcCode !== undefined) expect(toRpcError(e).code).toBe(rpcCode);
  }
}

describe("open and fund", () => {
  it("gives the dapp a fresh address funded from the confidential balance, never from a known wallet", async () => {
    const r = await rig();
    const a = await opened(r);
    expect(a.status).toBe("open");
    expect(a.dapp.origin).toBe(ORIGIN);
    const rec = await r.book.get(a.address.address);
    expect(rec).toMatchObject({ purpose: "connect", status: "active" });
    expect(r.world.bal(USDC, a.address.address)).toBe(5_000_000n);
    expect(r.world.eth.get(a.address.address)).toBe(21_000_000_000_000n); // 5 txs x 300k gas x 7e6 wei x2
    expect(r.approvals.map((x) => x.kind)).toEqual(["open", "withdraw", "withdraw"]);
    // Funded only by 1Click deliveries: no transaction ever sent to it from elsewhere.
    expect(r.world.broadcasts).toBe(0);
  });

  it("allows one open account per origin and normalizes the origin", async () => {
    const r = await rig();
    await opened(r);
    await rejectsWith(r.engine().open({ dapp: { origin: "HTTPS://APP.SWAP.EXAMPLE/path" }, budget: { asset: "usdc", amount: "1", payWith: "usdc" } }), "busy");
    await rejectsWith(r.engine().open({ dapp: { origin: "http://insecure.example" }, budget: { asset: "usdc", amount: "1", payWith: "usdc" } }), "validation");
  });

  it("allocates nothing when the user declines opening", async () => {
    const r = await rig();
    r.answer = (x) => x.kind !== "open";
    await rejectsWith(r.engine().open({ dapp: { origin: ORIGIN }, budget: { asset: "usdc", amount: "1", payWith: "usdc" } }), "rejected");
    expect(await r.book.list()).toEqual([]);
  });
});

describe("dapp requests", () => {
  it("answers chain and account queries and only serves Base", async () => {
    const r = await rig();
    const a = await opened(r);
    const e = r.engine();
    expect(await e.handle(a.id, { method: "eth_chainId" }, src)).toBe("0x2105");
    expect(await e.handle(a.id, { method: "eth_accounts" }, src)).toEqual([a.address.address]);
    expect(await e.handle(a.id, { method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }, src)).toBeNull();
    await rejectsWith(e.handle(a.id, { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }, src), "unsupported", 4200);
    await rejectsWith(e.handle(a.id, { method: "eth_sign", params: [a.address.address, "0x00"] }, src), "unsupported", 4200);
  });

  it("does a real swap: approve and swap are signed by the dapp address, sent, and recorded", async () => {
    const r = await rig();
    const a = await swapped(r);
    const self = a.address.address;
    expect(r.world.bal(OUT, self)).toBe(6_000_000n);
    expect(r.world.bal(USDC, self)).toBe(3_000_000n);
    expect(a.requests.map((q) => [q.method, q.decision])).toEqual([
      ["eth_sendTransaction", "sent"],
      ["eth_sendTransaction", "sent"],
    ]);
    expect(a.requests.every((q) => r.world.txs.has(q.tx!.hash))).toBe(true);
    expect(a.requests[0]!.summary).toContain(`lets ${ROUTER} spend 2000000`);
    expect(r.approvals.filter((x) => x.kind === "dapp_transaction")).toHaveLength(2);
  });

  const blockedCases: [string, (self: `0x${string}`) => Record<string, unknown>, string][] = [
    ["sending ETH to the main wallet", () => ({ to: MAIN, value: "0x1" }), "recipient_linked"],
    ["a token transfer to the main wallet", () => ({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MAIN, 1n] }) }), "calldata_linked"],
    ["a swap paying the main wallet", () => swapTx(MAIN), "calldata_linked"],
  ];
  for (const [what, tx, code] of blockedCases) {
    it(`blocks ${what} before anything is asked or signed`, async () => {
      const r = await rig();
      const a = await opened(r);
      const before = r.approvals.length;
      await rejectsWith(send(r, a.id, a.address.address, tx(a.address.address)), "blocked", 4001);
      const after = (await r.engine().get(a.id))!;
      expect(after.requests.at(-1)).toMatchObject({ decision: "blocked" });
      expect(after.requests.at(-1)!.findings.map((f) => f.code)).toContain(code);
      expect(after.requests.at(-1)!.tx).toBeUndefined();
      expect(r.approvals.length).toBe(before);
      expect(r.world.nonces.get(a.address.address) ?? 0).toBe(0);
    });
  }

  it("blocks paying another dapp's Shelter address, which would link the two dapps", async () => {
    const r = await rig();
    const a = await opened(r);
    const e = r.engine();
    const b = await e.open({ dapp: { origin: "https://other.example" }, budget: { asset: "usdc", amount: "1000000", payWith: "usdc" } });
    await rejectsWith(send(r, a.id, a.address.address, swapTx(b.address.address)), "blocked");
    expect((await e.get(a.id))!.requests.at(-1)!.findings[0]!.message).toContain("your Shelter connect address");
  });

  it("blocks a request from another origin, a scam domain, or a domain that fails verification", async () => {
    const r = await rig();
    const a = await opened(r);
    const self = a.address.address;
    await rejectsWith(send(r, a.id, self, approveTx(), { origin: "https://other.example", verified: "valid" }), "blocked");
    await rejectsWith(send(r, a.id, self, approveTx(), { ...src, scam: true }), "blocked");
    await rejectsWith(send(r, a.id, self, approveTx(), { origin: ORIGIN, verified: "invalid" }), "blocked");
    expect(r.world.broadcasts).toBe(0);
  });

  it("warns, but does not block, on an unverified domain and an unlimited approval", async () => {
    const r = await rig();
    const a = await opened(r);
    await send(r, a.id, a.address.address, approveTx(ROUTER, maxUint256), { origin: ORIGIN, verified: "unknown" });
    const ask = r.approvals.at(-1)!;
    expect(ask.kind).toBe("dapp_transaction");
    expect((ask as { warnings: { code: string }[] }).warnings.map((w) => w.code).sort()).toEqual(["dapp_unverified", "unlimited_approval"]);
  });

  it("signs nothing when the user declines, and records it", async () => {
    const r = await rig();
    const a = await opened(r);
    r.answer = (x) => x.kind !== "dapp_transaction";
    await rejectsWith(send(r, a.id, a.address.address, approveTx()), "rejected", 4001);
    expect((await r.engine().get(a.id))!.requests.at(-1)).toMatchObject({ decision: "rejected" });
    expect(r.world.broadcasts).toBe(0);
  });

  it("reports a transaction that would revert, without signing it", async () => {
    const r = await rig();
    const a = await opened(r);
    await rejectsWith(send(r, a.id, a.address.address, swapTx(a.address.address)), "chain", -32000); // no approval yet
    expect((await r.engine().get(a.id))!.requests.at(-1)).toMatchObject({ decision: "failed" });
    expect(r.world.broadcasts).toBe(0);
  });

  it("tops up gas just in time when the address runs low", async () => {
    const r = await rig();
    const a = await opened(r, "5000000", "1000000000000"); // gas for about one transaction
    const self = a.address.address;
    await send(r, a.id, self, approveTx());
    r.world.maxFeePerGas = 20_000_000n; // fees rise
    await send(r, a.id, self, swapTx(self));
    const acc = (await r.engine().get(a.id))!;
    expect(acc.fundings.map((f) => f.reason)).toEqual(["open", "gas"]);
    const ask = r.approvals.filter((x) => x.kind === "dapp_transaction").at(-1) as { topUpWei?: string };
    expect(BigInt(ask.topUpWei!)).toBeGreaterThan(0n);
    expect(r.world.bal(OUT, self)).toBe(6_000_000n);
  });

  it("funds ETH value from the confidential balance when a dapp asks the address to send ETH", async () => {
    const r = await rig();
    const a = await opened(r);
    const pay = getAddress("0x00000000000000000000000000000000000b0b00");
    await send(r, a.id, a.address.address, { to: pay, value: "0x38d7ea4c68000" }); // 0.001 ETH
    expect(r.world.eth.get(pay)).toBe(1_000_000_000_000_000n);
    const acc = (await r.engine().get(a.id))!;
    expect(acc.fundings.map((f) => f.reason)).toEqual(["open", "value"]);
  });

  it("signs messages and typed data with the dapp address", async () => {
    const r = await rig();
    const a = await opened(r);
    const self = a.address.address;
    const e = r.engine();
    const msg = stringToHex("Welcome to Swap! Nonce: 42");
    const sig = (await e.handle(a.id, { method: "personal_sign", params: [msg, self] }, src)) as `0x${string}`;
    expect(await verifyMessage({ address: self, message: { raw: msg }, signature: sig })).toBe(true);
    // The record keeps what the dapp asked to sign, so a replay can re-check the signature offline.
    const recorded = (await e.get(a.id))!.requests.at(-1)!;
    expect(recorded).toMatchObject({ method: "personal_sign", params: [msg, self], signature: sig, decision: "signed" });

    const permit = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
      message: { owner: self, spender: ROUTER, value: "2000000", nonce: "0", deadline: "1893456000" },
    };
    const tsig = (await e.handle(a.id, { method: "eth_signTypedData_v4", params: [self, JSON.stringify(permit)] }, src)) as `0x${string}`;
    const { EIP712Domain: _d, ...types } = permit.types;
    expect(
      await verifyTypedData({
        address: self,
        domain: { ...permit.domain, chainId: 8453 },
        types,
        primaryType: "Permit",
        message: { owner: self, spender: ROUTER, value: 2_000_000n, nonce: 0n, deadline: 1_893_456_000n },
        signature: tsig,
      }),
    ).toBe(true);
    expect((await e.get(a.id))!.requests.map((q) => q.decision)).toEqual(["signed", "signed"]);
  });

  it("blocks a message naming the owner's NEAR account and a sign-in for another domain", async () => {
    const r = await rig();
    const a = await opened(r);
    const self = a.address.address;
    const e = r.engine();
    await rejectsWith(e.handle(a.id, { method: "personal_sign", params: [stringToHex(`link to ${OWNER}`), self] }, src), "blocked");
    const siwe = stringToHex(`evil.example wants you to sign in with your Ethereum account:\n${self}\n\nURI: https://evil.example\nVersion: 1\nChain ID: 8453\nNonce: 1`);
    await rejectsWith(e.handle(a.id, { method: "personal_sign", params: [siwe, self] }, src), "blocked");
  });
});

describe("close", () => {
  it("sweeps every token 1Click takes back, then ETH, and retires the address", async () => {
    const r = await rig();
    const a = await swapped(r);
    const self = a.address.address;
    r.world.setBal(UNLISTED, self, 77n);
    const closed = await r.engine().close(a.id);
    expect(closed.status).toBe("closed");
    expect(r.world.bal(USDC, self)).toBe(0n);
    expect(r.world.bal(OUT, self)).toBe(0n);
    expect(r.world.bal(UNLISTED, self)).toBe(77n); // not listed by 1Click: stays, recoverable from the seed
    expect(closed.sweep!.items.map((x) => [x.symbol, x.outcome])).toEqual([
      ["USDC", "returned"],
      ["OUT", "returned"],
      ["ETH", "returned"],
    ]);
    expect(r.world.returned.get("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")).toBe(3_000_000n);
    expect((await r.book.get(self))!.status).toBe("retired");
    const plan = r.approvals.find((x) => x.kind === "sweep") as { items: { symbol: string }[] };
    expect(plan.items.map((x) => x.symbol)).toEqual(["USDC", "OUT", "ETH"]);
    await rejectsWith(send(r, a.id, self, approveTx()), "busy");
  });

  it("tells the user, before the sweep, which received tokens 1Click cannot take back", async () => {
    const r = await rig();
    const a = await opened(r);
    const self = a.address.address;
    await send(r, a.id, self, approveTx(ROUTER, 3_000_000n));
    await send(r, a.id, self, swapTx(self, 1_000_000n)); // into OUT, which 1Click lists
    await send(r, a.id, self, swapTx(self, 1_000_000n, UNLISTED)); // into a token it does not
    const closed = await r.engine().close(a.id);
    expect(closed.status).toBe("closed");
    const plan = r.approvals.find((x) => x.kind === "sweep") as { items: { symbol: string }[]; unsupported: string[] };
    expect(plan.unsupported).toEqual([`token ${UNLISTED} (3000000 in base units)`]);
    expect(plan.items.map((x) => x.symbol)).toEqual(["USDC", "OUT", "ETH"]);
    expect(closed.sweep!.unsupported).toEqual(plan.unsupported);
    expect(r.world.bal(UNLISTED, self)).toBe(3_000_000n);
  });

  it("leaves amounts below 1Click's minimum as dust instead of failing", async () => {
    const r = await rig();
    const a = await opened(r, "100000"); // 0.1 USDC, below the 0.15 minimum
    const closed = await r.engine().close(a.id);
    expect(closed.status).toBe("closed");
    expect(closed.sweep!.items.find((x) => x.symbol === "USDC")).toMatchObject({ decision: "dust" });
    expect(r.world.bal(USDC, a.address.address)).toBe(100_000n);
  });

  it("stays closing when the user declines the sweep, and finishes on the next close", async () => {
    const r = await rig();
    const a = await swapped(r);
    r.answer = (x) => x.kind !== "sweep";
    await rejectsWith(r.engine().close(a.id), "rejected");
    expect((await r.engine().get(a.id))!.status).toBe("closing");
    r.answer = () => true;
    expect((await r.engine().close(a.id)).status).toBe("closed");
  });

  it("records a transaction signed but never broadcast (crash) as not sent", async () => {
    // Find where the broadcast happens in a clean run of the same request.
    const probe = await rig();
    const pa = await opened(probe);
    const start = probe.world.faults.calls;
    await send(probe, pa.id, pa.address.address, approveTx());
    const k = probe.world.faults.log.slice(start).lastIndexOf("sendRaw") + 1;

    const r = await rig();
    const a = await opened(r);
    crashIn(r, k, "before");
    await expect(send(r, a.id, a.address.address, approveTx())).rejects.toThrow(); // the process died at the broadcast
    r.world.faults.dead = false;
    const stored = (await r.engine().get(a.id))!;
    expect(stored.requests[0]!.tx).toBeDefined(); // persisted signed before the broadcast
    const closed = await r.engine().close(a.id);
    expect(closed.requests[0]!.decision).toBe("not_sent");
    expect(r.world.txs.has(stored.requests[0]!.tx!.hash)).toBe(false);
  });

  /**
   * Kills the engine at every outside call a close makes, before and after
   * each one, and checks that every run still ends closed with each 1Click
   * deposit address paid once and the same totals returned as a clean run.
   */
  async function closeMatrix(onRestart?: (r: Rig, accountId: string) => Promise<void>) {
    const clean = await rig();
    const ca = await swapped(clean);
    const start = clean.world.faults.calls;
    await clean.engine().close(ca.id);
    const total = clean.world.faults.calls - start;
    const failures: string[] = [];
    for (const phase of ["before", "after"] as const) {
      for (let k = 1; k <= total; k++) {
        const r = await rig();
        const a = await swapped(r);
        crashIn(r, k, phase);
        try {
          const { value } = await untilDone(r, (e) => e.close(a.id), 10, onRestart && (() => onRestart(r, a.id)));
          expect(value.status).toBe("closed");
          expect(r.world.bal(USDC, a.address.address)).toBe(0n);
          expect(r.world.bal(OUT, a.address.address)).toBe(0n);
          for (const s of r.world.settlements.values()) expect(s.deposits).toBeLessThanOrEqual(1);
          expect([...r.world.returned.values()].reduce((x, y) => x + y, 0n)).toBe([...clean.world.returned.values()].reduce((x, y) => x + y, 0n));
        } catch (x) {
          failures.push(`${phase} #${k} (${clean.world.faults.log[start + k - 1]}): ${x instanceof Error ? x.message : String(x)}`);
        }
      }
    }
    return { total, failures };
  }

  it("survives a crash at every outside call during close without sending any deposit twice", async () => {
    const { total, failures } = await closeMatrix();
expect(total).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  }, 300_000);

  it("catches an engine that re-signs a saved sweep transfer after a restart", async () => {
    // The mutant: after each crash, saved sweep transfers that have no outcome yet are forgotten,
    // so the restarted engine signs a fresh one (as an engine that did not persist before sending would).
    const { failures } = await closeMatrix(async (r, id) => {
      const stored = (await r.accounts.get(id))!;
      const forgot = stored.account.sweep?.items.filter((x) => x.tx && !x.outcome) ?? [];
      if (!forgot.length) return;
      for (const x of forgot) delete x.tx;
      await r.accounts.update(stored.account, stored.rev);
    });
    // Measured 2026-11-13: 38 of the 144 runs fail (docs/backend/CONNECT.md); any failure shows the matrix bites.
expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => /expected [2-9]/.test(f) || /BUG/.test(f))).toBe(true);
  }, 300_000);
});

describe("sign-in-only accounts", () => {
  it("open with nothing, sign messages, and fund a transaction only when it comes", async () => {
    const r = await rig();
    const e = r.engine();
    const a = await e.open({ dapp: { origin: ORIGIN }, budget: { asset: "usdc", amount: "0", payWith: "usdc" }, gasWei: "0" });
    expect(a.fundings).toEqual([]);
    const self = a.address.address;
    const sig = (await e.handle(a.id, { method: "personal_sign", params: [stringToHex("sign in"), self] }, src)) as `0x${string}`;
    expect(await verifyMessage({ address: self, message: "sign in", signature: sig })).toBe(true);
    expect(r.approvals.filter((x) => x.kind === "withdraw")).toEqual([]);
    // A transaction later: its gas is withdrawn just in time, inside the same approval.
    await send(r, a.id, self, approveTx());
    expect((await e.get(a.id))!.fundings.map((f) => f.reason)).toEqual(["gas"]);
    expect((await e.close(a.id)).status).toBe("closed");
  });
});
