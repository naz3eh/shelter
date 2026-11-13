/**
 * @shelter/connect: use the confidential balance in any dapp without
 * linking the dapp to you.
 *
 * Each dapp origin gets its own address from the local seed, funded just in
 * time from the confidential balance through 1Click; every request passes
 * the linkage check before the user approves it; closing sweeps the
 * leftovers back and retires the address. See ./engine.ts.
 *
 * Node-only SQLite store: `@shelter/connect/sqlite`.
 * WalletConnect transport: `@shelter/connect/walletconnect`.
 */

export { ACCOUNT_FORMAT_VERSION, createMemoryAccountStore, originOf, parseAccount } from "./account.js";
export type {
  AccountEvent,
  AccountStatus,
  AccountStore,
  Budget,
  ConnectAccount,
  DappInfo,
  Funding,
  RequestDecision,
  RequestRecord,
  StoredAccount,
  SweepItem,
  SweepState,
} from "./account.js";
export { createConnectEngine } from "./engine.js";
export type { ConnectApproval, ConnectDeps, ConnectEngine, ConnectOptions, OpenInput, RequestSource } from "./engine.js";
export { ConnectError, isConnectError, toRpcError } from "./errors.js";
export type { ConnectErrorKind } from "./errors.js";
export { blocks, buildIdentity, inspect } from "./linkage.js";
export type { Finding, FindingCode, Identity, InspectContext } from "./linkage.js";
export { BASE_CHAIN_ID, decodeErc20, describeRequest, messageText, parseRequest, SERVED_METHODS, SIGNING_METHODS } from "./requests.js";
export type { DappRequest, TxParams, TypedData } from "./requests.js";
