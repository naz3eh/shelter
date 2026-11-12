# Shelter Connect

What `packages/connect` implements: the confidential balance, usable in any dapp through WalletConnect, without linking the dapp to the user.
Written 2026-11-12.

## The gap it closes

near.com and the 1Click confidential balance keep funds private while they sit in the balance.
The moment the user wants to use them in a dapp, they withdraw to a wallet, and that wallet is usually one the dapp, and everyone watching the chain, can tie back to them.
Connect gives each dapp its own address instead, funds it from the confidential balance only when needed, refuses anything that would tie it to the user's other identities, and sweeps it back afterwards.

## One account per dapp

| Step | What happens | Outside effect |
| --- | --- | --- |
| `open` | The user approves a budget; Connect derives the next address from the local seed (`purpose: connect`), checks it has no history, and binds it to the dapp's origin | Base RPC reads |
| `fund` | A burner engine `fund` job withdraws the budget and opening gas from the confidential balance to that address | 1Click quotes, generate-intent, Meteor signature, submit-intent |
| `handle` | Each dapp request passes the linkage check, then the user's approval, then is signed by the dapp address | Base transactions, signatures returned to the dapp |
| top-up | When a transaction needs more ETH (gas or value) than the address holds, Connect withdraws the shortfall first, inside the same approval | Same as `fund` |
| `close` | Unsigned funding is cancelled; sent transactions are settled; every token 1Click lists on Base and the remaining ETH are deposited back into the confidential balance; the address is retired | 1Click deposits, Base transactions |

The address is derived from the local seed, never from Chain Signatures.
Chain Signatures addresses derive publicly from the NEAR account, so every dapp address would be tied to it by anyone who looks.

One open account per origin.
A dapp that connects again (a new WalletConnect session) gets the same address back if the user agrees, so its positions and approvals still work.
A different dapp always gets a different address.

## The linkage check

The identity set is everything the user wants kept apart from a dapp:

- public wallets and NEAR accounts the user adds with `connect link add` (or `SHELTER_LINKED_ADDRESSES`);
- the NEAR account that owns the confidential balance;
- every other address in the address book: other dapps' addresses, payout addresses, burners.

| Request | Blocked when | Warned when |
| --- | --- | --- |
| Any | It comes from an origin other than the one the address is bound to, or WalletConnect Verify flags the domain as a scam or a mismatch | Verify cannot vouch for the domain |
| `eth_sendTransaction` | The recipient is in the identity set; any identity address appears anywhere in the calldata (aligned words and packed encodings alike); a NEAR account id appears in it as UTF-8 (a bridge memo); it names another sender or chain; it creates a contract | An unlimited token approval |
| `personal_sign` | The message names an identity (with or without 0x, any case; a NEAR sub-account names its parent); a sign-in (EIP-4361) is for a domain other than the dapp's | A sign-in names another chain |
| `eth_signTypedData_v4` | Any value at any depth names an identity, or another signer | The domain is for another chain, or it grants an unlimited allowance |

Blocked requests are refused before the user is asked and before anything is signed, and the dapp gets an EIP-1193 4001 error whose message says why.
`eth_sign` (a raw hash nobody can read) and `eth_signTransaction` (a transaction Connect would not send itself) are refused as unsupported.

## Crash safety

Each account is a saved record with compare-and-swap on every write; requests on one account run one at a time.
A signed transaction is saved, with its hash, before it is broadcast.
If the process dies between the two, `close` finds it, asks the chain, and records it as sent or as never sent.
Sweeps follow the burner engine's rules: the quote and the signed transfer are saved before anything is sent, and a resume repeats the same bytes.
The close crash test kills the engine at each of the 70 outside calls a close makes, before and after each one (140 runs); every run finishes with each 1Click deposit address receiving exactly one transfer and the same totals returned as a clean run.
A deliberately broken engine (one that re-signs a saved sweep transfer after a restart) fails 27 of those runs.

## Funding and fees

The opening funds are what makes transactions work, not the top-ups.
Most dapps (every wagmi or viem dapp) estimate gas through their own RPC before they ask the wallet, from the dapp address and with the transaction's ETH value.
If the address cannot pay, the estimate fails ("OutOfFunds") and the request never reaches Shelter; seen live on 2026-11-12 with Reown's AppKit lab.
So the budget must already hold what the dapp will spend, and the opening gas covers about five typical transactions (300k gas each at current fees, doubled).

Just-in-time top-ups cover the rest: a dapp that lets the wallet estimate, fees that rose between the dapp's estimate and signing, and the address running low after several transactions.
The approval shows the top-up, and it is withdrawn before the transaction is signed; ETH value comes the same way, with its gas in the same withdrawal.
Every withdrawal is also shown and signed in Meteor, as in the burner engine.

A budget of 0 opens a sign-in-only account: it holds nothing and is meant for signatures (sign-in, off-chain orders, permits).

Sweeping a token costs one Base transaction; if the address is out of gas, Connect asks to top it up first.
Amounts below 1Click's minimum for a token are left as dust, and so are tokens 1Click does not list; both stay on the retired address, whose key the seed can still recover.

## Running it

```sh
pnpm --filter @shelter/cli connect link add 0xYourMainWallet --label "main wallet"
pnpm --filter @shelter/cli connect start --account you.near --budget 5    # runs as a WalletConnect wallet
wc link> wc:...                                                            # paste each dapp's WalletConnect link at the prompt
pnpm --filter @shelter/cli connect start --sandbox                        # throwaway seed, no funds: signatures and blocks only
pnpm --filter @shelter/cli connect list                                   # no account or network needed
pnpm --filter @shelter/cli connect close ca_... --account you.near        # sweep back and retire
```

The running wallet keeps one reader on the terminal: a pasted `wc:` link pairs another dapp, and while a question is open the next line answers it, so prompts and pasting never fight over the terminal.
A link can also be given on the command line (`connect start 'wc:...'`).

Each request record keeps the dapp's params as sent, so `demo record --connect ca_...` can produce a recording whose replay re-checks every signature and re-runs every block offline (records made before 2026-11-12 lack them, and the replay says so).

Needs `ONECLICK_JWT`, `BASE_RPC_URL` and `WALLETCONNECT_PROJECT_ID` (a free project at https://cloud.reown.com).
WalletConnect's session keys live in `~/.shelter/walletconnect/` (0700); accounts in `~/.shelter/connect.db`; linked identities in `~/.shelter/linked.json`.

## What it does not hide

- The dapp sees its own address and everything done with it; Connect only keeps that address apart from the user's others.
- Timing and amounts: an address funded by the Intents treasury minutes before it trades a matching amount is easy to pair with that withdrawal on a quiet route.
- Off-chain links: the dapp's own logs, IP addresses, browser fingerprints, and anything the user types into it.
- The Base RPC sees every address Connect reads; 1Click and the Confidential Intents operators see the owner account, amounts and destinations.
- WalletConnect's relay sees which dapp talks to which wallet session, though not the content.

## Verified live (2026-11-12, nothing funded or spent)

- A real dapp, Reown's AppKit lab (https://lab.reown.com, wagmi), paired with Connect over the WalletConnect relay using the project id; WalletConnect Verify rated the origin `VALID`, and the dapp showed itself connected on Base with the account's fresh address.
- `personal_sign` and `eth_signTypedData_v4` from the dapp were answered; the dapp verified the message signature as valid.
- With the dapp's sample wallet linked, its typed-data request was refused by the linkage check (`typed_data_linked`) before any approval, and the dapp showed the error.
- A transaction from an empty address never reached Shelter: the dapp's own gas estimate failed first (see Funding and fees).
- 1Click lists 18 tokens on Base; native ETH has no contract address; deposit minimums from dry quotes: USDC 0.15, ETH 0.0000001 (1e11 wei); WETH and cbBTC accepted the smallest probe (0.000001).

These ran through a scratch driver around the same bridge and engine (a throwaway seed, automatic answers), since the CLI's prompts need a terminal; `connect start --sandbox` is the same setup with the prompts.

## Verified on mainnet (2026-11-12, funded)

A real session with Uniswap (https://app.uniswap.org) on Base, from a 1 USDC budget, all signed by the user in Meteor and in the CLI:

- Funding: 1 USDC plus opening gas withdrawn from the confidential balance to the Uniswap-only address in about 90 s.
- A Permit2 approval ([tx](https://basescan.org/tx/0x585db734409d91ac9d042184c78f912b7b4c66fdd02cbf48839002daf6b207e9)), a PermitSingle signature and the swap of 0.5 USDC to ETH ([tx](https://basescan.org/tx/0x275f09eb16cd56aa956b3c197b79e21cb56bb4eb6ea3ef13ed88b89818e52f60)); Shelter warned on both unlimited allowances.
- A Uniswap Send of 0.1 USDC to the user's linked main wallet was blocked (`calldata_linked`) before any approval.
- Close swept 0.5 USDC ([tx](https://basescan.org/tx/0xb349eb79941c5384c8bcd41b9b38f27e757ec463e9103916ea0afbb7c15bef6e)) and 0.000268 ETH ([tx](https://basescan.org/tx/0xf06540278420fa2b906e1d9cacfb1162ee6a02f7b793c23274b45d2064171f7d)) back into the confidential balance; both 1Click deposits reached SUCCESS within a minute, and the address was retired with about 2.3e-7 ETH of dust.
- 1Click's Base deposit addresses accept a plain ETH transfer.
- `/v0/deposit/submit` answered 500 ("Empty AMQP response") for both sweeps; the notice is optional and 1Click found both transfers on chain anyway.
