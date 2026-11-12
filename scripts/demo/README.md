# Demo recording

`recording.json` here is the recorded mainnet run that `pnpm demo --dry-run` replays with no network, keys or funds.
It does not exist until the approved mainnet run has happened.

## What the replay checks, offline

- Every 1Click quote's ed25519 signature against the 1Click manager key, and that it is `advanced` confidentiality.
- Every withdrawal intent's NEP-413 signature against the signer's key, and that it only transfers to the quote's deposit address from the owner's account.
- Every burner transaction: its hash is the keccak-256 of the signed bytes, its sender recovers to the burner address, and it is exactly the recorded USDC transfer on Base.

Any failed check makes the command exit with status 1.
The replay prints Basescan links so the transactions can also be checked on chain.

## Making it

After the run, from the machine that ran it:

```sh
pnpm --filter @shelter/cli demo record --account viraz.near --job bj_... --deposit 0x... 
```

It reads the job from `~/.shelter/burner.db` and the deposit saved by `near deposit` from `~/.shelter/deposits/`.

## Privacy

The recording holds no key, seed, passphrase or token: only quotes, statuses, signed intents and signed transactions, which are public once used.
It does tie the owner's NEAR account to the burner and the payee, so committing it gives up the privacy of that demo run.
Use a demo account and payee you are happy to make public.
