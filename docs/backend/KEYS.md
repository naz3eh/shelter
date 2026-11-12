# Seed vault and address book (G5)

What `packages/keys` implements, the exact formats it stores, and the limits it does not overcome.
Written 2026-11-07.

## Libraries

| Library | Version | Used for |
| --- | --- | --- |
| `@scure/bip39` | 2.4.0 (MIT) | Mnemonic generation, validation, seed (PBKDF2-HMAC-SHA512, empty BIP-39 passphrase) |
| `@scure/bip32` | 2.4.0 (MIT) | BIP-32 derivation |
| `@noble/hashes` | 2.4.0 (MIT) | Argon2id, HKDF-SHA256, SHA-256, Keccak-256 |
| `@noble/curves` | 2.4.0 (MIT) | secp256k1 public keys and signatures |
| `viem` | 2.57.x (MIT) | Address checksums, message/typed-data hashing, transaction serialisation, `LocalAccount` shape |
| WebCrypto | browser / Node 24+ | AES-256-GCM |
| `node:sqlite` | Node 24+ built-in | CLI persistence |
| `fake-indexeddb` | 6.2.7 (Apache-2.0, tests only) | IndexedDB in Node tests |

The noble/scure libraries are the ones viem itself depends on; no other cryptography is added.
`hash-wasm` was considered for faster Argon2id and not used: pure-JS Argon2id at the chosen cost takes about 0.5 s in Node, which is acceptable, and the candidate release was published the same day.

## Derivation

- Path `m/44'/60'/0'/0'/n'`, hardened at every level, `n` in `0 .. 2^31 - 1`.
- Hardened change and index levels mean a leaked child key plus public data reveals neither the parent nor any sibling.
- Consequence: these addresses differ from what MetaMask and most wallets show for the same phrase (they use the non-hardened `m/44'/60'/0'/0/n`), and no xpub can watch them.
- Derivation is local; NEAR Chain Signatures are not used.
- Test vectors for the public BIP-39 test phrase (indexes 0, 1 and 2^31 - 1) were computed independently with Python's standard library and are checked in `test/vault.test.ts`.

## Vault format (version 1)

The vault stores the 64-byte BIP-39 seed, never the mnemonic, so the phrase can only be shown once, at creation.
Stored as JSON:

```json
{
  "format": "shelter-vault",
  "v": 1,
  "kdf": { "alg": "argon2id", "m": 65536, "t": 3, "p": 4, "salt": "<16 random bytes, base64>" },
  "cipher": { "alg": "AES-256-GCM", "iv": "<12 random bytes, base64>" },
  "vaultId": "<32 hex chars>",
  "createdAt": "<ISO-8601>",
  "ct": "<ciphertext + 16-byte tag, base64>"
}
```

- Key: Argon2id over the NFKC-normalised passphrase, 32 bytes.
- Default cost is RFC 9106 section 4's second recommended option: 64 MiB, t=3, p=4.
- Accepted range when opening: m 19456..262144 KiB, t 2..10, p 1..8.
  The floor is the OWASP Argon2id minimum; the ceiling stops a planted file from demanding unbounded memory.
- Every seal draws a fresh salt and IV, including a passphrase change.
- Associated data: the JSON of every field except `ct`, rebuilt in a fixed order from validated values.
  Changing, adding or removing any header field fails decryption or parsing.
- `vaultId`: the first 16 bytes of SHA-256 over `shelter/vault-id/v1` and the BIP-32 master public key.
  It is public, lets storage refuse a second seed without unlocking, and binds backups to the seed.
- Passphrases must be at least 8 characters.
  Wrong passphrase and tampering both report `decrypt_failed`; AES-GCM cannot tell them apart.

## Address book

Each derived address has one record:

| Field | Meaning |
| --- | --- |
| `index` | Hardened index, unique, never reused |
| `address` | Checksummed EVM address, unique |
| `chain` | Chain it was issued for (`base`); the key works on every EVM chain |
| `purpose` | `burner`, `destination`, `recovered`, or another string |
| `status` | `active` or `retired`; retirement is permanent |
| `label`, `createdAt`, `retiredAt` | Local notes and times |

- **Allocation** reads `nextIndex`, derives the address, writes the record and advances `nextIndex` in one atomic store update.
  A crash before commit leaves nothing; a crash after commit leaves a used index.
  Either way, no index is handed out twice.
- **Retired addresses** are never handed out again, and `assertUsable(address)` throws `retired`.
  G6 must call it before using an address for a new action.
- This book is separate from `@shelter/core`'s `AddressBook`, which holds user labels for scanned public wallets.

## Persistence adapters

| Adapter | Import | Atomicity |
| --- | --- | --- |
| IndexedDB (browser) | `@shelter/keys/idb` | One `readwrite` transaction over both object stores, `durability: "strict"`. Browsers serialise overlapping `readwrite` transactions, including across tabs. |
| SQLite (CLI) | `@shelter/keys/sqlite` | `BEGIN IMMEDIATE` per update, WAL, `synchronous=FULL`, 5 s busy timeout. The file is created 0600 in a 0700 directory. |
| Memory | `createMemoryStore` | Serialised in-process queue; not durable. |

All allocation and merge rules are pure functions shared by every adapter, so behaviour is identical.
Tests cover: restart persistence, 30 concurrent allocations per adapter, two connections at once, 4 separate Node processes allocating 60 addresses on one SQLite file, a process killed after committing, and rollback on a failed update.

## Backup, restore and recovery

- `exportBackup()` returns an AES-256-GCM envelope (`shelter-address-book-backup`, v1) of all records and `nextIndex`.
  The key is HKDF-SHA256 from the seed, so the backup is useless without the seed and needs no second passphrase.
- `restoreBackup()` needs the same seed unlocked.
  Every record's address is re-derived and must match.
  The merge never lowers `nextIndex`, and a retirement on either side wins.
- `recover({ isUsed, gapLimit = 20, from = 0, maxScan = 1000 })` scans derived addresses for on-chain use until `gapLimit` consecutive unused, unknown indexes.
  Found addresses are added as `retired` with purpose `recovered`.
  `nextIndex` moves past the whole scanned window, because an index in the trailing gap may have been given out (for example as a receive address) without on-chain use yet.
  To widen the search, call it again with a larger `gapLimit` or a higher `from`.
- **Key recovery is not reuse permission.**
  A recovered or retired address can still sign through `vault.account(index)`, for example to sweep leftovers, but the address book never issues it for a new action.
- `isUsed` is supplied by the caller, typically a nonce, balance or token-history check through the user's RPC.
  Each check reveals that address to the RPC.

## Usage

```ts
import { createAddressBook, createSeedVault } from "@shelter/keys";
import { createIndexedDbStore } from "@shelter/keys/idb";   // browser
// import { createSqliteStore } from "@shelter/keys/sqlite"; // CLI: createSqliteStore(`${home}/.shelter/keys.db`)

const store = await createIndexedDbStore();
const vault = createSeedVault({ store });

if (!(await vault.exists())) {
  const { mnemonic } = await vault.create(passphrase); // show once, user writes it down
} else {
  await vault.unlock(passphrase); // throws KeysError "decrypt_failed" on a wrong passphrase
}

const book = createAddressBook(vault);
const burner = await book.allocate({ purpose: "burner", chain: "base" });
const account = vault.account(burner.index); // viem LocalAccount; signing throws "locked" after vault.lock()
// ... sign the one action with `account` ...
await book.retire(burner.address);
vault.lock();
```

## Limits

- **Memory erasure.** `lock()` zeroes the seed and the BIP-32 root, and each signing call zeroes its child key.
  JavaScript cannot guarantee erasure: the mnemonic and passphrase arrive as immutable strings, and the engine may have copied buffers.
  Locking stops further use; it does not prove the bytes are gone.
- **Local address book is not encrypted.**
  Records are public data (addresses, purposes, labels), but together they link the user's addresses.
  Anyone who can read the browser profile or `keys.db` sees those links; the backup export is encrypted.
- **No BIP-39 passphrase** (the "25th word") and English word list only.
- **No hardware wallet** in this build.
- **The NEAR key** that owns the confidential balance (`nep413`) is never held by Shelter.
  It stays in the user's Meteor wallet; the CLI asks Meteor for each NEP-413 signature through a one-shot page on `127.0.0.1` and verifies it (`apps/cli/src/near/meteor-signer.ts`, threat model "Confidential balance owner").
