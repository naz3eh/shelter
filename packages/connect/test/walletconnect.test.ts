import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi } from "viem";
import { createConnectBridge, createWalletKit, type BridgeOptions, type WalletKitLike } from "../src/walletconnect.js";
import { MAIN, ORIGIN, rig, ROUTER, USDC, type Rig } from "./harness.js";

type Handler = (ev: never) => Promise<unknown>;

class FakeKit implements WalletKitLike {
  handlers = new Map<string, Handler>();
  approved: { id: number; namespaces: Record<string, { accounts: string[]; chains?: string[]; methods: string[] }> }[] = [];
  rejected: { id: number; reason: { code: number } }[] = [];
  responses: { topic: string; response: { id: number; result?: unknown; error?: { code: number; message: string } } }[] = [];
  sessions: Record<string, never> = {};
  on(e: string, l: Handler) {
    this.handlers.set(e, l);
  }
  off(e: string) {
    this.handlers.delete(e);
  }
  async pair() {}
  async approveSession(p: { id: number; namespaces: never }) {
    this.approved.push(p);
    const ns = p.namespaces as { eip155: { accounts: string[] } };
    this.sessions[`topic${p.id}`] = { topic: `topic${p.id}`, namespaces: ns, peer: { metadata: { url: ORIGIN } } } as never;
  }
  async rejectSession(p: { id: number; reason: { code: number; message: string } }) {
    this.rejected.push(p);
  }
  async respondSessionRequest(p: (typeof this.responses)[number]) {
    this.responses.push(p);
  }
  getActiveSessions() {
    return this.sessions;
  }
  async disconnectSession() {}
  emit(e: string, ev: unknown) {
    return this.handlers.get(e)!(ev as never);
  }
}

const verified = (origin = ORIGIN, validation = "VALID", isScam?: boolean) => ({ verified: { origin, validation, verifyUrl: "", ...(isScam ? { isScam } : {}) } });

const proposal = (id: number, chains = ["eip155:8453"], optional = false) => ({
  id,
  params: {
    id,
    expiryTimestamp: 0,
    relays: [],
    pairingTopic: "p",
    proposer: { publicKey: "k", metadata: { name: "Swap", description: "", url: ORIGIN, icons: [] } },
    requiredNamespaces: optional ? {} : { eip155: { chains, methods: ["eth_sendTransaction", "personal_sign"], events: ["chainChanged"] } },
    optionalNamespaces: optional ? { eip155: { chains, methods: ["eth_sendTransaction"], events: [] } } : {},
  },
  verifyContext: verified(),
});

async function setup(decide: BridgeOptions["decide"] = async () => ({ budget: { asset: "usdc", amount: "3000000", payWith: "usdc" } })) {
  const r: Rig = await rig();
  const kit = new FakeKit();
  const engine = r.engine();
  const logs: string[] = [];
  createConnectBridge({ kit, engine, decide, log: (m) => logs.push(m) });
  return { r, kit, engine, logs };
}

/** Lets the background funding started after approval finish. */
const settle = () => new Promise((res) => setTimeout(res, 50));

describe("WalletConnect bridge", () => {
  it("approves a Base session with exactly the dapp's own address and funds it", async () => {
    const { r, kit, engine } = await setup();
    await kit.emit("session_proposal", proposal(1));
    await settle();
    expect(kit.approved).toHaveLength(1);
    const [account] = await engine.list();
    expect(kit.approved[0]!.namespaces.eip155!.accounts).toEqual([`eip155:8453:${account!.address.address}`]);
    expect(kit.approved[0]!.namespaces.eip155!.methods).toContain("eth_signTypedData_v4");
    expect(r.world.bal(USDC, account!.address.address)).toBe(3_000_000n);
  });

  it("accepts Base offered only as an optional namespace", async () => {
    const { kit } = await setup();
    await kit.emit("session_proposal", proposal(2, ["eip155:1", "eip155:8453"], true));
    expect(kit.approved[0]!.namespaces.eip155!.accounts[0]).toMatch(/^eip155:8453:0x/);
  });

  it("refuses a dapp that requires another chain, a scam domain, and a user's no", async () => {
    const a = await setup();
    await a.kit.emit("session_proposal", proposal(3, ["eip155:1"]));
    expect(a.kit.rejected.map((x) => x.id)).toEqual([3]);
    expect(a.kit.approved).toEqual([]);

    const b = await setup();
    await b.kit.emit("session_proposal", { ...proposal(4), verifyContext: verified(ORIGIN, "VALID", true) });
    expect(b.kit.rejected.map((x) => x.id)).toEqual([4]);
    expect(await b.engine.list()).toEqual([]);

    const c = await setup(async () => null);
    await c.kit.emit("session_proposal", proposal(5));
    expect(c.kit.rejected.map((x) => x.id)).toEqual([5]);
    expect(await c.engine.list()).toEqual([]);
  });

  it("reuses the open account when the same dapp connects again", async () => {
    const { kit, engine } = await setup(async (p) => (p.existing ? { reuse: true } : { budget: { asset: "usdc", amount: "1000000", payWith: "usdc" } }));
    await kit.emit("session_proposal", proposal(6));
    await settle();
    await kit.emit("session_proposal", proposal(7));
    expect(await engine.list()).toHaveLength(1);
    expect(kit.approved[0]!.namespaces.eip155!.accounts).toEqual(kit.approved[1]!.namespaces.eip155!.accounts);
  });

  it("answers requests through the engine, and blocked ones with a 4001 error", async () => {
    const { kit, engine } = await setup();
    await kit.emit("session_proposal", proposal(8));
    await settle();
    const [account] = await engine.list();
    const self = account!.address.address;
    const req = (id: number, method: string, params: unknown, chainId = "eip155:8453") =>
      kit.emit("session_request", { id, topic: "topic8", params: { request: { method, params }, chainId }, verifyContext: verified() });

    await req(100, "eth_sendTransaction", [{ from: self, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, 1n] }) }]);
    expect(kit.responses.at(-1)!.response.result).toMatch(/^0x[0-9a-f]{64}$/);

    await req(101, "eth_sendTransaction", [{ from: self, to: MAIN, value: "0x1" }]);
    expect(kit.responses.at(-1)!.response.error).toMatchObject({ code: 4001 });
    expect(kit.responses.at(-1)!.response.error!.message).toContain("Blocked by Shelter");

    await req(102, "eth_sign", [self, "0x00"]);
    expect(kit.responses.at(-1)!.response.error!.code).toBe(4200);

    await req(103, "eth_chainId", [], "eip155:1");
    expect(kit.responses.at(-1)!.response.error!.code).toBe(4200);
    expect(kit.responses.map((x) => x.response.id)).toEqual([100, 101, 102, 103]);
  });

  it("does not let a missing Verify origin pass the origin check by default", async () => {
    const { r, kit, engine } = await setup();
    await kit.emit("session_proposal", proposal(9));
    await settle();
    const [account] = await engine.list();
    const self = account!.address.address;
    const sign = (id: number) =>
      kit.emit("session_request", { id, topic: "topic9", params: { request: { method: "personal_sign", params: ["0x6869", self] }, chainId: "eip155:8453" }, verifyContext: undefined });

    // No Verify verdict: the dapp's own metadata URL stands in, and the user is warned it is unverified.
    await sign(200);
    expect(kit.responses.at(-1)!.response.result).toMatch(/^0x[0-9a-f]{130}$/);
    const asked = r.approvals.at(-1) as { kind: string; warnings: { code: string }[] };
    expect(asked.kind).toBe("dapp_signature");
    expect(asked.warnings.map((w) => w.code)).toContain("dapp_unverified");

    // A peer that now claims another site is refused, instead of being treated as the account's own origin.
    (kit.sessions as Record<string, { peer: { metadata: { url: string } } }>).topic9!.peer.metadata.url = "https://evil.example";
    await sign(201);
    expect(kit.responses.at(-1)!.response.error).toMatchObject({ code: 4001 });
    expect(kit.responses.at(-1)!.response.error!.message).toContain("https://evil.example");
  });

  it("validates pairing URIs and project ids before touching the network", async () => {
    const { kit, engine } = await setup();
    const bridge = createConnectBridge({ kit, engine, decide: async () => null });
    await expect(bridge.pair("https://example.com")).rejects.toThrow("pairing URI");
    await expect(createWalletKit({ projectId: "nope", storageDir: "/tmp/x" })).rejects.toThrow("project id");
  });
});
