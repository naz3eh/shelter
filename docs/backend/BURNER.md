# Burner engine (G6)

What `packages/burner` implements, how a job survives crashes, and what is still unverified.
Written 2026-11-08.

## What one job does

One public action (in this build, a USDC transfer on Base) from a one-time address, with gas plan A:

| Step | What happens | Outside effect |
| --- | --- | --- |
| `allocate` | Derives the next address from the seed (`purpose: burner`, label `burner-job:<id>`) and checks on chain that it has nonce 0 and no balance | Base RPC reads (reveal the address to the RPC) |
| `fund_gas` | Confidential withdrawal paid in USDC and delivered as native ETH on Base, sized from live fees | 1Click quote, generate-intent, Meteor signature, submit-intent |
| `fund_asset` | Confidential withdrawal of exactly the action amount (`EXACT_OUTPUT`) | Same as above |
| `act` | `assertUsable`, gas estimate, then the burner signs and sends its one transaction | Base transaction |
| `sweep` | If anything is left at or above the 1Click deposit minimum (0.15 USDC), deposits it back to the confidential balance; below that it is left as dust | Only when something is left, usually never |
| `retire` | Marks the address retired; the address book never hands it out again | None |

Gas is funded before the asset so the asset never sits on an address that cannot move it.
Every withdrawal comes from, and every refund returns to, the owner's confidential balance (`refundType: CONFIDENTIAL_INTENTS`); nothing touches a known address.
A recipient that is one of the user's own Shelter addresses is refused, because paying it from a burner would link the two.

## Private-move payouts

A job whose action is `hold` funds a fresh address and keeps it: `allocate` (purpose `destination`), `fund_gas`, `fund_asset`, done.
It never acts, sweeps or retires; the address waits, with gas for one later transfer, for the user to use as their new wallet.
This is the spec's private move step 4: the confidential balance pays out to fresh addresses, each with gas.

## Top-ups for addresses the user keeps

A job whose action is `fund` tops up an address that is already in the address book and still active, such as a Connect dapp address: `allocate` checks the record and the seed instead of deriving a new address, then `fund_gas` and `fund_asset` run only for what is asked, and the job ends.
It never acts, sweeps or retires the address, and cancelling it leaves the address active.
When the asset is ETH, the gas rides in the same withdrawal.
Its crash test kills it at every outside call, before and after, and checks the address receives exactly the amount and the gas once.

## Scheduling and the planner hand-off

A job can carry `notBefore`; `run` refuses to start it earlier (`pending`), and the check applies only before anything is allocated, so a started job always finishes.
`schedulePlan(engine, steps, start)` turns the planner's steps into jobs, keeping `@shelter/core`'s action names:

| Planner step | Becomes |
| --- | --- |
| `deposit` (asset, amount) | A step the user takes from the old wallet with `near deposit`; returned with its earliest time, no job |
| `wait` (durationMs, 0 to 30 days) | Shifts the start time of every later step |
| `withdraw` (asset, amount) | A `hold` job (payout address) |
| `fund-burner` (asset, amount, to) | An `erc20_transfer` burner job |

Every step's shape is checked before any job is created, and each job records its plan step in `planRef`.
`@shelter/core`'s `planRemediation` is still a stub owned by the core package; when it lands it should emit these `MoveStep`s, with amounts in base units.

## Gas sizing

- Budget before funding: 90,000 gas (a USDC transfer uses about 40k to 62k) at the live `maxFeePerGas`, plus the OP-stack L1 data fee, times 2, rounded up to 0.000001 ETH.
- Live on 2026-11-08 that was 0.000002 ETH (about $0.005): max fee 0.007 gwei, L1 fee about 0.0000000005 ETH.
- Before signing the action the engine estimates the real gas (the burner holds the USDC by then), adds 20 %, and re-prices; if the burner cannot cover the maximum fee it queues a gas top-up (at most 2) and funds it the same way.
- Gas is paid from the USDC balance: 1Click swaps on the way and delivers native ETH (live 2026-11-08: 0.007002 USDC at most for 0.000002 ETH, about 14 s).
  So the confidential balance only needs USDC; no ETH has to be deposited.
- The 1Click withdrawal fee for native ETH on Base was a flat 0.00000112 ETH (inside the 0.007 USDC above), for USDC a flat 0.0048 USDC (`docs/backend/ONECLICK.md`).
- One 0.25 USDC payment draws at most 0.263083 USDC from the balance in total (both legs, including fees and the 0.5 % slippage buffer).

## Crash safety

A job is a persisted state machine (`BurnerJob`, format v1); `run(id)` continues from the last saved state.
The rule: every outside effect is saved first in a form that is safe to repeat.

- **Allocation.** A crash after allocating but before saving leaves a book record labelled with the job id; the next run finds and reuses it (only while it is still active).
- **Withdrawals.** The quote is saved, then the signed intent, then it is submitted.
  A signed intent can be submitted again after a crash: `intents.far` accepts each nonce once, so it cannot pay twice.
  Before submitting, the status is read; anything other than `PENDING_DEPOSIT` means an earlier submit landed.
  An attempt that has not executed by the quote deadline (plus 2 minutes) is abandoned and requoted: after that deadline 1Click refunds anything that reaches the deposit address to the owner's balance.
  `REFUNDED` and `FAILED` also requote, up to 3 attempts, then the job stops for a person.
- **Delivery.** `SUCCESS` from 1Click is not enough: the burner's balance must show the amount on chain.
- **Burner transactions.** Signed with a fixed nonce and saved with their hash before broadcast; a resume re-broadcasts the same bytes, so the action cannot happen twice.
  "Already known" and "nonce too low" after a lost response are resolved by asking the node for the hash.
- **One runner.** Every save is a compare-and-swap on a revision, and a run holds a 10-minute lease renewed on each save.
  A second runner gets `busy`; the SQLite store enforces this across processes.
- **Stops.** `pending` (a status or receipt has not settled) and `rejected` (an approval was declined) leave the job active to run again.
  `needs_attention` records why; running the job again retries.
  `cancel` is allowed only before any withdrawal was signed.

The job holds no secret (quotes, signed intents and signed transactions are public once used), but it links the burner to the action, so it stays on the device like the address book.

## Approvals

Nothing is spent without `approve`:

- each withdrawal, after the generated intent has passed every check and before Meteor is asked, showing what the burner receives, the most the balance pays, the fee and the exact transfer being signed;
- each burner transaction, before it is signed, showing what it does and its maximum fee.

Meteor then shows the withdrawal again before the user signs.

## Storage

| Adapter | Import | Notes |
| --- | --- | --- |
| SQLite (CLI) | `@shelter/burner/sqlite` | `~/.shelter/burner.db`; conditional `UPDATE ... WHERE rev = ?`; WAL, `synchronous=FULL`; 0600 file in a 0700 directory |
| IndexedDB (browser) | `@shelter/burner/idb` | Database `shelter-burner`; read and write of the revision in one `readwrite` transaction, `durability: "strict"`; IndexedDB serialises them across tabs |
| Memory | `createMemoryJobStore` | Not durable |

The engine itself has no Node dependency, so the web app can run jobs with the IndexedDB store; the CLI is the only caller in this build.

## CLI

```sh
pnpm --filter @shelter/cli vault create                # once: 24-word phrase, shown once
pnpm --filter @shelter/cli near deposit --account viraz.near --asset usdc --amount 0.5
                                                       # prints a Base deposit address; you send from your wallet
pnpm --filter @shelter/cli burner preview --account viraz.near --to 0x... --amount 0.25
pnpm --filter @shelter/cli burner payout  --account viraz.near --amount 0.2 --in 3h   # private-move payout, scheduled
pnpm --filter @shelter/cli burner new     --account viraz.near --to 0x... --amount 0.25
pnpm --filter @shelter/cli burner run     bj_... --account viraz.near   # resumable; Ctrl-C is safe
pnpm --filter @shelter/cli burner list | show bj_... | cancel bj_...
```

`vault recover` rebuilds the address book after `vault import` by scanning derived addresses on Base (nonce, ETH or USDC); each check reveals that address to the RPC.
Found addresses are added as retired: their keys still sign, but they are never handed out for a new action.

`run` asks for the vault passphrase (hidden), opens the Meteor signing page, and asks y/N in the terminal before every spend.
It needs `ONECLICK_JWT`; set `BASE_RPC_URL` to your own Base RPC, since the RPC sees the burner address.

## Verified live (2026-11-08, read-only)

- `preview`: gas budget 0.000002 ETH, both dry quotes `advanced` with verified signatures.
- A job on a throwaway in-memory seed ran `allocate` and `fund_gas` up to the first approval and was declined there: fresh address checked on chain, real quote reserved, 1Click's generated `intents.far` intent passed every check, nothing signed or sent, lease released.
- SQLite compare-and-swap across two connections: the stale writer gets `busy`.

## Offline tests

`packages/burner/test` runs the real engine, vault and address book against a simulated 1Click and Base ledger (signed transactions are really parsed and their senders recovered).

- **Crash matrix.** A clean run makes about 60 outside calls (1Click, RPC, job writes).
  For each one, the job is killed once just before and once just after the call takes effect, then resumed by a fresh runner; a killed process writes nothing more.
  Every one of these runs must end with the payee paid exactly once, each funding leg delivered once, no quote paid by two different signed intents, one burner transaction, one address allocated, and that address retired.
- **Mutation checks.** Submitting a withdrawal before saving its signed intent, or broadcasting before saving the signed transaction, each makes the matrix fail (double spend, or a stop for a person); the real engine passes.
- Refund then requote, 3 failed attempts stopping for a person, an intent never executed before the quote deadline, a quote expired before signing, declined approvals, cancel before and after signing, own-address recipient, invalid actions, a live lease held elsewhere, a derived address with history, a job of another owner, gas top-up, sweep after a reverted action, and dust.

Payouts have their own crash matrix: the address must end with exactly the amount and its gas, no transaction sent, still active.
Also covered: scheduled start, the planner hand-off (start times, refusing a malformed plan before creating anything, a scheduled payout and burner running end to end), and one store contract run against the memory, SQLite and IndexedDB stores (duplicate ids, stale writers, persistence across a reopen).

`packages/intents/test/execution.test.ts` checks the `intents.far` withdrawal path with a real ed25519 wallet: the live intent shape is accepted and signed unchanged, 17 malformed intents are refused before the wallet is asked, plus forged signatures, unregistered keys, the prepare/submit split and the partner-key guard.

## Not yet verified

- A real withdrawal, delivery and action on mainnet (the approved run).
- Whether a key registered only on `intents.near` can sign `intents.far` withdrawals.

