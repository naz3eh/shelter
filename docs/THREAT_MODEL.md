# Threat Model

## Chain reader

The scan runs entirely on the user's device, but the queries it makes are not
free of leakage:

- **Blockscout history queries.** Transaction history, token transfers and
  approvals are read per-address from a Blockscout instance (default:
  `eth.blockscout.com` / `base.blockscout.com`). Each query reveals to that
  Blockscout instance which addresses were scanned and when. Queries are made
  one address at a time, but an observer of the instance can still correlate
  the set of queried addresses.
  - Mitigation: the Blockscout base URL is configurable per chain
    (`ChainReaderConfig.blockscoutUrls`), so a user can point the reader at a
    self-hosted Blockscout instance and remove this leakage entirely.
- **RPC queries.** Balance, nonce and ENS reverse lookups go to the user's
  configured RPC (`ETH_RPC_URL`, `BASE_RPC_URL`), or viem's default public
  transports when unset. The provider sees each queried address individually.
  - Mitigation: users pick their own RPC endpoints; running a personal node
    removes the third party.
- **NEAR RPC.** `.near` accounts are checked via `view_account` against
  `rpc.mainnet.near.org` (configurable). The RPC sees the queried account id.
- **Labels are local only.** The exchange label set (dawsbot/eth-labels) and
  the OFAC list (0xB10C) are bundled as static JSON inside `packages/core`.
  Lookups are local `Set`/`Map` reads — the user's address set is never sent
  to a label API.

## Limits

TODO
