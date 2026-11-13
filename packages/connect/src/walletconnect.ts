/**
 * WalletConnect transport for Connect: Shelter acts as a WalletConnect
 * wallet (Reown WalletKit), so any dapp that offers WalletConnect can use
 * the confidential balance through a Connect account.
 *
 * - A session proposal opens (or reuses) the Connect account bound to the
 *   dapp's origin, after the user chooses a budget. Shelter offers exactly
 *   one chain (Base) and one account (that dapp's address); a dapp that
 *   requires anything else is refused.
 * - Each session request goes to `engine.handle` with the origin and the
 *   WalletConnect Verify verdict; the answer (or an EIP-1193 error) goes
 *   back to the dapp.
 * - One-click auth (`session_authenticate`) is not offered: without a
 *   listener the dapp falls back to a normal session proposal, which is
 *   where Connect binds the address to the origin.
 *
 * WalletKit keeps its session keys in `storageDir`; anyone who reads them
 * can read and answer this wallet's WalletConnect traffic (not move funds:
 * every signature still needs the vault and the user's approval). The CLI
 * keeps the directory 0700 under ~/.shelter.
 */

import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import type { ProposalTypes, SessionTypes, Verify } from "@walletconnect/types";
import { originOf, type Budget, type ConnectAccount, type DappInfo } from "./account.js";
import type { ConnectEngine, RequestSource } from "./engine.js";
import { ConnectError, toRpcError } from "./errors.js";
import { BASE_CHAIN_ID, SIGNING_METHODS } from "./requests.js";

export const CAIP_CHAIN = `eip155:${BASE_CHAIN_ID}`;
const METHODS = [...SIGNING_METHODS, "wallet_switchEthereumChain"];
const EVENTS = ["accountsChanged", "chainChanged"];

type Listener = (args: never) => unknown;

/** The part of Reown WalletKit the bridge uses (so tests can stand in for it). */
export interface WalletKitLike {
  on(event: "session_proposal" | "session_request" | "session_delete", listener: Listener): unknown;
  off(event: "session_proposal" | "session_request" | "session_delete", listener: Listener): unknown;
  pair(params: { uri: string }): Promise<unknown>;
  approveSession(params: { id: number; namespaces: SessionTypes.Namespaces }): Promise<unknown>;
  rejectSession(params: { id: number; reason: { code: number; message: string } }): Promise<unknown>;
  respondSessionRequest(params: { topic: string; response: { id: number; jsonrpc: "2.0"; result?: unknown; error?: { code: number; message: string } } }): Promise<unknown>;
  getActiveSessions(): Record<string, SessionTypes.Struct>;
  disconnectSession(params: { topic: string; reason: { code: number; message: string } }): Promise<unknown>;
}

export interface Proposal {
  dapp: DappInfo;
  verified: NonNullable<RequestSource["verified"]>;
  scam: boolean;
  /** The open account already bound to this origin, if any; reusing it keeps the dapp on one address. */
  existing: ConnectAccount | null;
}

export interface BridgeOptions {
  kit: WalletKitLike;
  engine: ConnectEngine;
  /** The user's answer to a dapp asking to connect: reuse the open account, open one with a budget, or refuse. */
  decide(p: Proposal): Promise<{ reuse: true } | { budget: Budget; gasWei?: string } | null>;
  /** Progress and errors that have no request to report them to. */
  log?(message: string, error?: unknown): void;
  onDisconnect?(account: ConnectAccount | null): void;
}

export interface Bridge {
  pair(uri: string): Promise<void>;
  /** Live sessions and the account each one uses. */
  sessions(): Promise<{ topic: string; dapp: string; account: ConnectAccount | null }[]>;
  disconnect(topic: string): Promise<void>;
  stop(): void;
}

const verdict = (v: Verify.Context | undefined): { verified: NonNullable<RequestSource["verified"]>; scam: boolean } => ({
  verified: v?.verified.validation === "VALID" ? "valid" : v?.verified.validation === "INVALID" ? "invalid" : "unknown",
  scam: v?.verified.isScam === true,
});

/** The session's one account address, from its approved namespaces. */
function sessionAddress(s: SessionTypes.Struct | undefined): string | null {
  const acct = s?.namespaces?.eip155?.accounts?.[0];
  return acct ? (acct.split(":")[2] ?? null) : null;
}

export function createConnectBridge(o: BridgeOptions): Bridge {
  const log = o.log ?? (() => {});

  const onProposal = async (ev: { id: number; params: ProposalTypes.Struct; verifyContext: Verify.Context }) => {
    const { id, params } = ev;
    const meta = params.proposer.metadata;
    try {
      const v = verdict(ev.verifyContext);
      const origin = originOf(ev.verifyContext?.verified.origin || meta.url);
      if (v.scam) throw new ConnectError("blocked", `${origin} is flagged as a scam by WalletConnect Verify`);
      const dapp: DappInfo = { origin, ...(meta.name ? { name: meta.name } : {}), ...(meta.url ? { url: meta.url } : {}) };
      const existing = await o.engine.findOpen(origin);
      const answer = await o.decide({ dapp, ...v, existing });
      if (!answer || ("reuse" in answer && !existing)) {
        await o.kit.rejectSession({ id, reason: getSdkError("USER_REJECTED") });
        return;
      }
      const account = "reuse" in answer ? existing! : await o.engine.open({ dapp, budget: answer.budget, ...(answer.gasWei !== undefined ? { gasWei: answer.gasWei } : {}) });
      let namespaces: SessionTypes.Namespaces;
      try {
        namespaces = buildApprovedNamespaces({
          proposal: params,
          supportedNamespaces: {
            eip155: { chains: [CAIP_CHAIN], methods: METHODS, events: EVENTS, accounts: [`${CAIP_CHAIN}:${account.address.address}`] },
          },
        });
      } catch (e) {
        await o.kit.rejectSession({ id, reason: getSdkError("UNSUPPORTED_CHAINS") });
        log(`${origin} requires chains or methods Shelter does not offer (only Base)`, e);
        return;
      }
      // Offer every method Connect serves, not only those the dapp declared: many ask for typed data later.
      namespaces.eip155 = { ...namespaces.eip155!, methods: METHODS };
      await o.kit.approveSession({ id, namespaces });
      log(`connected ${origin} as ${account.address.address}`);
      // The opening budget lands in the background; requests wait for it.
      o.engine.fund(account.id).then(
        (a) => log(a.fundings.length ? `${origin}: funding delivered` : `${origin}: sign-in only, nothing to fund`),
        (e) => log(`${origin}: funding stopped`, e),
      );
    } catch (e) {
      log(`could not connect ${meta.url}`, e);
      await o.kit.rejectSession({ id, reason: getSdkError("USER_REJECTED") }).catch(() => {});
    }
  };

  const onRequest = async (ev: {
    id: number;
    topic: string;
    params: { request: { method: string; params: unknown }; chainId: string };
    verifyContext: Verify.Context;
  }) => {
    const { id, topic, params } = ev;
    const reply = (body: { result: unknown } | { error: { code: number; message: string } }) =>
      o.kit.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", ...body } }).catch((e) => log("could not answer the dapp", e));
    try {
      if (params.chainId !== CAIP_CHAIN) throw new ConnectError("unsupported", `Shelter Connect only serves Base, not ${params.chainId}`);
      const session = o.kit.getActiveSessions()[topic];
      const address = sessionAddress(session);
      const account = address ? await o.engine.byAddress(address) : null;
      if (!account) throw new ConnectError("not_found", "this session has no Shelter account");
      // Without a Verify origin, fall back to what the dapp says about itself, never to the
      // account's own origin: that would make the origin check pass by construction.
      const verifiedOrigin = ev.verifyContext?.verified.origin;
      const source: RequestSource = verifiedOrigin
        ? { origin: verifiedOrigin, ...verdict(ev.verifyContext) }
        : { origin: session?.peer?.metadata?.url ?? "", verified: "unknown", scam: verdict(ev.verifyContext).scam };
      const result = await o.engine.handle(account.id, { method: params.request.method, params: params.request.params, rpcId: id }, source);
      await reply({ result });
    } catch (e) {
      if (!(e instanceof ConnectError)) log(`request ${params.request.method} failed`, e);
      await reply({ error: toRpcError(e) });
    }
  };

  const onDelete = async (ev: { topic: string }) => {
    log(`dapp disconnected (${ev.topic.slice(0, 8)})`);
    o.onDisconnect?.(null);
  };

  o.kit.on("session_proposal", onProposal as Listener);
  o.kit.on("session_request", onRequest as Listener);
  o.kit.on("session_delete", onDelete as Listener);

  return {
    async pair(uri) {
      if (!/^wc:[0-9a-f]+@2\?/i.test(uri)) throw new ConnectError("validation", "not a WalletConnect v2 pairing URI (wc:...@2?...)");
      await o.kit.pair({ uri });
    },
    async sessions() {
      return Promise.all(
        Object.values(o.kit.getActiveSessions()).map(async (s) => {
          const address = sessionAddress(s);
          return { topic: s.topic, dapp: s.peer.metadata.url, account: address ? await o.engine.byAddress(address) : null };
        }),
      );
    },
    async disconnect(topic) {
      await o.kit.disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
    },
    stop() {
      o.kit.off("session_proposal", onProposal as Listener);
      o.kit.off("session_request", onRequest as Listener);
      o.kit.off("session_delete", onDelete as Listener);
    },
  };
}

export interface WalletKitOptions {
  /** Reown (WalletConnect) Cloud project id. */
  projectId: string;
  /** Directory for WalletConnect's session keys. */
  storageDir: string;
  metadata?: { name: string; description: string; url: string; icons: string[] };
}

/** Starts a real Reown WalletKit. Loaded lazily so the engine and tests do not pull in the relay client. */
export async function createWalletKit(opts: WalletKitOptions): Promise<WalletKitLike> {
  if (!/^[0-9a-f]{32}$/i.test(opts.projectId)) throw new ConnectError("validation", "WalletConnect project id must be 32 hex characters (Reown Cloud)");
  const [{ Core }, { WalletKit }] = await Promise.all([import("@walletconnect/core"), import("@reown/walletkit")]);
  const core = new Core({ projectId: opts.projectId, storageOptions: { database: opts.storageDir } });
  const kit = await WalletKit.init({
    core,
    metadata: opts.metadata ?? {
      name: "Shelter",
      description: "Use your confidential NEAR Intents balance in any dapp, without linking it to you",
      url: "https://github.com/naz3eh/shelter",
      icons: [],
    },
  });
  return kit as unknown as WalletKitLike;
}
