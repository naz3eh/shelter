# Shelter spec

Source: the Shelter design doc (Oct 31, 2026), converted from PDF, plus decisions settled through Nov 3, 2026. The settled sections at the end take precedence over the doc text.

```text
Shelter (working name): architecture and user flow

Shelter (working name): architecture and user
flow
​Oct 31, 2026

· ​@dev

Summary
Shelter keeps your real wallet off public chains: it finds what your addresses leak, moves
funds through Confidential Intents to fresh addresses with no public link, and runs each
later public action from a one-time burner address.
Problem. Anyone can trace a large holder from one known address to the rest. That drives
wrench attacks, spear-phishing and address poisoning. Every address that has signed
also has its public key on-chain, which matters if ECDSA breaks early (Justin Drake's
"bunker mode" post, Oct 7 2026). Existing tools scan or sweep, but the sweep itself is a
public transfer, so the new address is linked to the old one.
What is new. The link between old and new addresses is broken by routing through a
Confidential Intents balance owned by one NEAR account. That same balance funds a
fresh, never-signed address for every public action. On-chain, each action comes from a
different, unconnected address, and the NEAR identity never appears.
Hackathon fit. Tracks: privacy (primary) and security , listed together in the
submission's tracks array. Stack: Confidential Intents via the 1Click API, NEAR accounts,
NEAR AI Cloud private inference with attestation. The pitch leads with the private move
and the burner, not the scan: NEAR's own example prompt for this track is an attested
analyzer, so many teams will build scanners. The name is a placeholder: "Bunker" is already
used by three projects, one with a token.

Fit with the hackathon and the NEAR ecosystem
Shelter submits once with two tracks, privacy and security ; HACKATHON.md says to
list every track a project fits. It turns holders on Ethereum and Base into Confidential
Intents users with a NEAR account.
How it differs from the track's example prompt. NEAR's Privacy prompt is a private
expense auditor: a TEE-hosted model on NEAR AI Cloud, attestation verified with a fresh
nonce, a "Verified" panel, nothing kept server-side, and fictional sample data. Shelter
meets every one of those requirements in its scan, then goes further: it acts on the
findings with private moves and one-time burners.
Hackathon tracks

Page 1 of 16

Shelter (working name): architecture and user flow

Track

Fit

Why

Privacy & Private AI

Primary

Private analysis on NEAR AI Cloud with
attestation, plus private moves through
Confidential Intents. This is the track's core
stack.

AI Security &
Defense

Listed, second
track

Cuts exposure to wrench attacks, spearphishing, address poisoning and early ECDSA
breaks.

Unstoppable DeFi

Partial

Every move and burner action runs on Intents
across chains.

Real-World Money

Partial

Burner payments in USDC: pay anyone without
showing your main wallet.

Judges this speaks to
Illia: "near.com is your bunker", privacy by default, never panic.
Mert: privacy, wrench attacks, and moving calmly rather than in a rush.
Eddy: private, cheap, cross-chain stablecoin use.
Avichal: privacy guardrails and private inference.
Haseeb: security, as long as the threat model is honest.
What it adds to NEAR
NEAR piece

How Shelter uses it

What NEAR gets back

Confidential Intents

Every private move and every
burner is funded from a
confidential balance.

New deposits and volume on
the private shard. Its
confidential TVL is about
$100M to $148M, depending on
the source.

1Click API and the
Intents fee switch

Every swap and withdrawal is a
1Click quote.

Fee revenue, which funds
NEAR buybacks, plus partner
fees for the integrator.

NEAR accounts

One named account is the
user's private identity across
all chains.

Users of other chains hold a
NEAR account, which is chain
abstraction in practice.

Page 2 of 16

Shelter (working name): architecture and user flow

NEAR piece

How Shelter uses it

What NEAR gets back

NEAR AI Cloud

The explainer runs on a private,
attested model.

Paid private-inference usage,
and a clear example of "private
AI" for consumers.

near.com Confidential
Mode

Shelter does the diagnosis,
planning and burners;
near.com holds the balance.

A front door that sends
worried holders to near.com.

Shelter is not a feature NEAR would ship itself. NEAR provides the private rail; Shelter
decides what to move, when, and to where, and adds the burner flow on top.

NEAR tooling
Shelter is built on six NEAR tools, all usable on day 1 without approvals. The hackathon
FAQ settles the two biggest setup questions: no 1Click key is needed, and there is no
Intents testnet.
Tool

What Shelter uses it for

Facts that shape the build

NEAR AI Cloud

Private explainer for scan
findings

OpenAI-compatible API at
https://cloud-api.near.ai/v1 .

Pick a TEE-hosted model from the
models endpoint, not a proxied
one. Credits: buy at cloud.near.ai
or claim $10 via NEAR Builders
(FAQ Q-000).
NEAR AI Cloud
verification

"Verified" panel and
verify-attestation

script

1Click API

Every deposit, withdrawal
and burner funding

Fetch the attestation report with
a fresh random nonce and check
it as the docs describe. Start from
the verification example repo and
the near-ai-cloud agent skill.
POST /v0/quote with
confidentiality: "advanced" ,
recipientType and refundType

set to CONFIDENTIAL_INTENTS .
No JWT needed: without one the
fee is 0.2% (Q-006). No testnet:
mainnet, tiny amounts, dry:
true quotes while building (Q007).

Page 3 of 16

Shelter (working name): architecture and user flow

Tool

What Shelter uses it for

Facts that shape the build

Confidential Intents and
near.com Confidential
Mode

The private balance
between old and new
addresses

Private shard with permissioned
validators; deposits and
withdrawals are not publicly
linkable. Reading the balance
needs a User-Session token
signed by the user's wallet.

NEAR accounts and
wallet selector

The user's single identity;
signs intents

A named account such as
alice.near . Also the prize
payout account the submission
asks for.

NEAR RPC

Reading the .near
account during the scan

Public providers are free (Q-009).

Outside NEAR: viem for EVM keys and transactions; native USDC on Base, whose
transferWithAuthorization (EIP-3009) enables the gasless fallback; a USDC paymaster

as the second fallback.
FAQ rules that apply: list every library in the README (Q-005); a hosted demo counts in
your favour, kept up to Nov 18 and ideally Nov 25 (Q-012); add a LICENSE file (Q-014);
Claude Code and Codex check reproducibility and features before humans decide (Q017).

Goals and limits
Shelter reduces how easily you can be found and targeted. It does not stop malware or a
stolen seed phrase.
Goals
Show a holder, privately, what their addresses reveal and how they link together.
Move funds to fresh, never-signed addresses with no public trail from the old ones.
Let each later public action come from a one-time address, funded privately.
Stay calm and staged: a plan the user reviews, nothing moves automatically.
Non-goals
Quantum-safe signatures. Ethereum still uses ECDSA; Shelter only shortens how long a
key is exposed.
Mixing other people's funds. Users move their own funds to their own addresses.
Rotating-owner Safes (built by Bunker Wallet) and hash-signature vaults (built by
BunkerERC). Both can sit alongside Shelter.

Page 4 of 16

Shelter (working name): architecture and user flow

Receiving payments at fresh addresses (Fluidkey does this).
What it does not protect against
A compromised device or leaked seed. The Oct 29 Binance theft (about $6.3B) started
from an engineer's compromised laptop.
KYC leaks. If an exchange or tax office leaks your identity, Shelter cannot undo that.
Trust in Confidential Intents. Its private shard runs on permissioned validators, which
users must trust.
Careless use. Withdrawing the same amount you deposited, minutes later, re-links you.

Architecture
Three layers: the user's device does all thinking and signing, NEAR provides the private
rail and private model, and public chains only ever see unlinked addresses.

Architecture: three layers, eleven components

Page 5 of 16

Shelter (working name): architecture and user flow

The chain reader also reads public chains directly through the user's own RPCs, and
burners sweep leftover funds back to the confidential balance through a 1Click deposit;
these, and the optional gas relayer (plan B), are left out of the picture to keep it readable.

Components
Twelve components; ten run on the user's device. Keys and the address book never leave
the user's device; only the model call (inside a TEE) and the optional gas relayer (plan B)
run remotely.
Component

Layer

Runs
where

Responsibility

Built with

Web app

Client

Browser

Scan, plan, approve and
track screens. Connects
existing wallets.

Next.js,
wagmi/viem, NEAR
wallet selector

CLI

Client

User's
machine

Same flows from a
terminal; powers the
one-command demo for
judges.

Node + TypeScript,
shares the core
packages

Local key
vault

Client

Browser
or
machine

One BIP-39 seed.
Creates fresh EVM keys
by hardened derivation,
one index per address.
Encrypted at rest.

viem accounts,
Argon2id + AESGCM

Address book

Client

Browser
or
machine

Which address was
made for what, its
status (fresh, funded,
used, swept) and its
links. Never uploaded.

IndexedDB in the
app, SQLite in the
CLI

Chain reader

Data

User's
device

Reads balances,
transaction history and
names from the user's
own RPC endpoints, so
no indexer sees the
whole address set.

viem, NEAR RPC,
ENS and .near
lookups

Page 6 of 16

Shelter (working name): architecture and user flow

Component

Layer

Runs
where

Responsibility

Built with

Exposure
engine

Core

User's
device

Deterministic checks
per address: public key
exposed, exchange
links, name links, first
funder, shared
counterparties, dust
and poisoning, round
amounts. Lists findings
by severity with
evidence, counts linked
addresses, builds a link
graph.

TypeScript rules + a
bundled exchange
label list

Private
explainer

AI

NEAR AI
Cloud
(TEE)

Turns findings into
plain-language risks and
plan reasons. Returns
an attestation with
every answer. Never
decides amounts.

NEAR AI Cloud
private model,
attestation API

Attestation
verifier

Core

User's
device

Checks the TEE
attestation (Intel TDX +
NVIDIA) before showing
an AI answer. Also ships
as a script for judges.

NEAR AI
attestation tooling

Planner

Core

User's
device

Splits amounts into
round chunks, spaces
them in time, picks a
fresh address per chunk
and adds gas. Enforces
limits the AI cannot
change.

TypeScript

Page 7 of 16

Shelter (working name): architecture and user flow

Component

Layer

Runs
where

Responsibility

Built with

Intents
executor

Integration

User's
device +
1Click

Gets quotes with

1Click API
( /v0/quote ), no
JWT (0.2% fee),
NEAR account
signing

confidentiality:
"advanced" , sends

deposits, tracks status,
withdraws from the
confidential balance to
fresh addresses.
Refunds always return
to the confidential
balance.
Burner
engine

Integration

User's
device

For one public action:
makes a fresh address,
funds the exact asset
amount plus gas (plan A,
B or C), signs one
action, sweeps leftovers
back, marks the key
burned.

viem, Intents
executor

Gas relayer
(plan B only)

Integration

Small
hosted
service

Submits a burner's
signed USDC
authorization and pays
the gas. Holds no user
funds or keys and keeps
no logs after submitting.

viem, EIP-3009, a
hot wallet with a
small ETH float

The NEAR account (for example alice.near ) is the user's single identity. It owns the
confidential balance, signs intents, and is never used on a public chain.

Exposure findings
The scan lists findings by severity, each with its evidence, instead of one opaque score.
The headline number is "addresses linked to you", which should drop to zero for the new
addresses after the move.
Check

Severity

Evidence shown

Linked to an exchange deposit address

High

The transfer and the exchange
label

Page 8 of 16

Shelter (working name): architecture and user flow

Check

Severity

Evidence shown

Named (ENS or .near )

High

The name record

Shares a first funder with another of your
addresses

High

The funding transactions

Public key exposed (the address has signed)

Medium

First outgoing transaction

Shared counterparties or matching amounts
with your other addresses

Medium

The matching transactions

Open token approvals

Medium

Spender and allowance

Poisoning dust or look-alike senders

Low

The dust transfers

Label list. A static list of exchange addresses ships inside the app, built from an open
dataset such as Dune's labelled exchange addresses. Looking up each address in a label
API would leak the user's address set, so the app never does that. Users can also tag their
own addresses ("this is my Coinbase deposit").
Checking our own result. After the move, the re-scan runs the standard clustering
checks (shared funder, shared counterparties, matching amounts and times) between
the old address and the new ones, and shows that none match. An explorer screenshot of
the fresh address in the demo adds evidence from outside our own engine.
Sample data. Fictional wallets with recorded histories ship in the repo, so judges can run
the scan without real addresses, as the track's example prompt asks.

Gas: plan A and fallbacks
Every fresh address and burner needs gas, and gas from a known address re-links it. The
day-1 check decides which plan ships; all three keep the gas source unlinked.
Plan

How the burner pays gas

Trade-off

A. Gas through
Intents

The same 1Click withdrawal (or a
second quote to the same address)
delivers native ETH with the USDC.

No extra parts. Depends on
1Click delivering small native
amounts to a never-used
address; minimum quote sizes
may make it costly.

Page 9 of 16

Shelter (working name): architecture and user flow

Plan

How the burner pays gas

Trade-off

B. Gasless
USDC

The burner signs a USDC
3009) off-chain; a Shelter relayer
submits it and pays gas. The burner
never holds ETH.

Simplest for the demo's USDC
payment. The relayer is a
shared link between burners,
but it only shows "uses
Shelter", like Railgun's
broadcasters. Works only for
USDC transfers.

The burner is a smart account (or an
EIP-7702 account) and a USDC
paymaster pays gas in USDC.

Works for any action, not just
transfers. More code and an
extra dependency.

C. Paymaster

transferWithAuthorization (EIP-

Rules for all plans
Fund the exact amount plus gas, so there is usually no leftover and no sweep
transaction.
Fresh addresses from the private move get gas the same way, since they will need it
later to move funds.
Never top up gas from the old address, the user's main wallet, or an exchange account.

User flow
Six steps, each needing the user's approval: set up, scan, plan, move, act, re-scan. Step 5
repeats for every later public action.
1. Set up. The user signs in with a NEAR account and creates or restores the local seed.
They add the addresses they want checked: EVM addresses (Ethereum, Base) and
their .near account.
2. Scan. The chain reader pulls history from the user's own RPCs. The exposure engine
scores each address and draws the link graph. The private explainer, running in a TEE,
explains each risk in plain words, and the app shows its verified attestation.
Example finding: "0xA1 has signed 214 times, so its public key is public. It was
funded from your Coinbase deposit address. It is named alice.eth."
3. Plan. The planner proposes a calm, staged move: round chunks, spread over hours or
days, each to a new address. The plan also revokes open token approvals on the old
address. The user can edit the window, chunk size and chains, then approves.
4. Private move. For each chunk, the old address sends funds to a 1Click deposit address.
They land in the user's confidential balance. Later, at a different time and amount, the
balance pays out to fresh addresses. The app tracks each step.

Page 10 of 16

Shelter (working name): architecture and user flow

5. Burner action (repeatable). To pay someone or use an app, the user picks the action.
The burner engine funds a one-time address with the exact amount plus gas, signs the
one action, then returns any leftover to the confidential balance.
6. Re-scan. The scan runs again and shows a before-and-after: addresses linked to you
(zero for the new ones), clustering checks passed, keys exposed. The user can export a
report.
What the public sees: old address sent funds to a 1Click deposit address; unrelated fresh
addresses later received funds from Intents; a payment came from an address that never
acted before or after.

Sequence flows
Both flows pass through the private balance, so no public transaction connects the old
address, the fresh addresses and the burners.

Page 11 of 16

Shelter (working name): architecture and user flow

Sequence: private move (7 steps) and burner action (6 steps)

In the move, step 6 happens hours or days after step 4, with a different round amount. The
burner flow shows gas plan A. Steps 5 and 6 happen only if something is left over, so the
one-time address usually signs once and is retired; its key stays recoverable from the
seed but is never used again.

Trust, keys and threat model
The user trusts their own device, the NEAR AI Cloud TEE for the model call, and the
Confidential Intents operators. Nothing else sees the address set.

Page 12 of 16

Shelter (working name): architecture and user flow

Who

Sees

Must be
trusted for

Mitigation

User's device

Everything: seed,
address book, plan

Key safety

Encrypted vault;
hardware wallet
support later

User's RPC provider

Each address
queried, one at a time

Not linking
queries

User picks their own
RPCs; queries spread
over time; self-hosted
node optional

NEAR AI Cloud TEE

Findings sent for
explanation

Privacy of the
model call

Attestation checked
before use; send
findings, not raw keys

Confidential Intents
(private shard,
permissioned
validators)

Deposits, balance,
withdrawals

Not revealing
the link

Stated plainly in the
README; the attack
surface is far smaller
than a public chain

1Click solvers

Quote amounts and
assets

Filling at a fair
price

Quotes compared;
slippage limits

Public chain observers

Deposit to Intents;
unrelated fresh
addresses

Nothing

Round chunks, random
delays, different
chains and times

Gas relayer (plan B
only)

Each burner it
submits for, and
when

Not keeping
or sharing
logs

Open source, no logs;
it never sees the
confidential balance or
the NEAR account

Key rules
Fresh keys come from the local seed by hardened derivation. Leaking one child key
does not expose the seed or other children.
Burners are not made with Chain Signatures. Its addresses are derived from one public
root key with a public offset, so an ECDSA break would expose all of them at once.
Chain Signatures is fine for a privacy-only mode.
NEAR access keys are public in account state, so rotating NEAR keys does not hide
them. The "never-signed address" claims cover EVM only in this build.
Each burner is funded with the exact amount, signs once, and is never used again. A
sweep happens only if something is left over.

Page 13 of 16

Shelter (working name): architecture and user flow

Recovery: address indexes come from the seed, so a lost device is recovered by
scanning the next N indexes. The address book also has an encrypted export.
Known ways to get re-linked
Matching amounts or close timing between deposit and withdrawal.
A small anonymity set: on a quiet route (for example USDC to Base), even rounded
amounts can be matched by time. The app shows recent confidential traffic on the
route and defaults to busy routes and common amounts.
Refunds landing publicly. A failed quote refunds to refundTo ; Shelter always sets
refunds to the confidential balance.
Sending a fresh address's funds back to a known address, or to a KYC exchange
account.
Reusing a burner, or approving the same spender from many burners in a row.
Gas funded from a known address instead of through Intents or the relayer.
Demo timings. The demo shortens delays to minutes, which would be linkable in real
use; the video says so.
Other limits. 1Click may refuse or refund deposits from sanctioned or flagged addresses;
the README says so. Approvals that need a second transaction (approve then swap)
need Permit2 and are out of scope; the demo uses a plain USDC transfer.

Hackathon scope and submission
Build window: Nov 1 00:00 to Nov 14 23:59 UTC. Ship one complete path on mainnet with
small amounts (about $20), not many half paths.
In scope
Scan of Ethereum and Base addresses plus one .near account, with fictional sample
wallets so judges need no real data.
Private explainer on a TEE-hosted NEAR AI Cloud model, with a "Verified" panel listing
each attestation check (fresh nonce).
Planner with round chunks, random delays, approval revokes, and a demo mode with
short delays.
Private move: one exposed address to the confidential balance to two fresh addresses,
each with gas.
One burner action: a USDC payment on Base, using the gas plan the day-1 check picks.
Re-scan showing addresses linked to you and the clustering checks.
Hosted web demo, kept up until Nov 25 (FAQ Q-012).
Out of scope (listed in the README)

Page 14 of 16

Shelter (working name): architecture and user flow

Bitcoin, Solana, hardware wallets, mobile, DeFi positions (Aave, LPs, NFTs), receiving at
fresh addresses, rotating-owner Safes, hash-signature vaults, any token.
Repo layout
apps/web

Next.js app

apps/cli

CLI and the judge demo

packages/core

exposure engine, planner, address book

packages/keys
packages/intents

seed vault, hardened derivation
1Click client, confidential balance, status tracking

packages/burner

one-time address lifecycle

packages/attest
scripts/demo

NEAR AI attestation check
recorded mainnet run for dry-run replay

docs/THREAT_MODEL.md

Build plan
1. Nov 1 to 3: 1Click confidential quote, deposit and withdraw end to end on mainnet
( dry: true first, then tiny amounts). Run the gas check and pick plan A, B or C. Seed
vault and hardened derivation.
2. Nov 4 to 6: chain reader, exposure checks, label list, link graph, sample wallets.
3. Nov 7 to 9: planner, burner engine with the chosen gas plan, NEAR AI explainer and
"Verified" panel.
4. Nov 10 to 12: web app screens, re-scan, hosted demo, record the mainnet demo run.
5. Nov 13 to 14: README, threat model, LICENSE, video, X post, then submit after the
team confirms the payload.
Submission checklist
Public repo with a LICENSE file (Q-014), frozen before submitting; the submission
cannot be edited.
README in HACKATHON.md style: what it is, the problem, "do X - see Y" steps for AI
judges, every library listed (Q-005), and a plain statement that nothing is kept serverside.
pnpm demo --dry-run : replays the recorded mainnet run and prints transaction

hashes, no keys or funds needed.
pnpm verify-attestation : lets judges check the TEE attestation with a fresh nonce.

Fictional sample wallets in the repo.
Hosted demo live until at least Nov 18, ideally Nov 25.
docs/THREAT_MODEL.md with every limit from this doc.
Demo video under 2 minutes and a public X post saying it was built at NEAR
HACKATHON.

Page 15 of 16

Shelter (working name): architecture and user flow

Submission: tracks = privacy , security ; description of 20 to 2,000 characters; a
named .near payout account; payload confirmed by the team before it is sent.

Open questions and day-1 checks
Gas plan A: can 1Click deliver a small amount of native ETH on Base to a never-used
address, alone or with USDC? What is the minimum quote size?
Is there an Intents testnet? No, and none is planned (Q-007). Use mainnet, separate
dev accounts, tiny amounts, dry: true quotes.
Is a 1Click JWT needed? No; without it the fee is 0.2% (Q-006). No server needed to
hide a key.
Exact flow to withdraw from the confidential balance to an outside address:
recipientType , Signed Intent Execution, and the User-Session token for reading the

balance.
Is a 1Click deposit address unique per quote? If yes, it can also serve as a one-time
receive address.
Which models on the NEAR AI Cloud models endpoint are TEE-hosted, and what the
attestation report contains.
Should the chain reader later run in a TEE worker (OutLayer or similar) instead of on
the device?
Final product name.

Sources
NEAR Hackathon and HACKATHON.md, including FAQ Q-000 to Q-017
Privacy track example prompt
NEAR AI Cloud quickstart and verification docs
NEAR AI Cloud verification example
1Click confidential swaps
EIP-3009: transfer with authorization
Justin Drake's bunker mode post, quoted in this reply
Bunker Wallet (SilentCicero)
BunkerERC/bunker
Fluidkey on L2BEAT
2026 Binance hack

Page 16 of 16

```

## Scoring (settled)
- Checks and weights: A exchange link 25; B ENS/Basename/.near name 20; C first funder is an exchange or another scanned wallet 15; D shared destination 15; E direct transfers between scanned wallets 10; F public key exposed 5; G fee or time-of-day fingerprint 4; H repeated or round amounts 3; I approval from one scanned wallet to another 3.
- Each check adds at most weight x confidence. Total capped at 100. Floor of 50 if A or B fires.
- Bands: 0-19 clean, 20-49 linkable, 50-79 identifiable, 80-100 doxxed.
- Address poisoning and sanctioned (OFAC) counterparties are warnings worth 0 points.
- The headline is the score; linkedAddressCount is secondary.
- Labels: dawsbot/eth-labels (MIT) and the 0xB10C OFAC list.

## Chain reader (settled)
- Blockscout REST API v2 behind a ChainReader interface, instance URL configurable per chain (self-hostable).
- viem RPC for balances, nonce and ENS; NEAR RPC view_account for .near names.
- The addresses sent to the Blockscout instance are a known leak and go in docs/THREAT_MODEL.md.
