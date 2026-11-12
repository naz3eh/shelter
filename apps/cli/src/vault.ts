/**
 * `shelter vault ...`: the local seed vault and address book (G5) in
 * ~/.shelter/keys.db (or $SHELTER_HOME/keys.db).
 *
 *   vault status            whether a vault exists, its id, and the derived addresses
 *   vault create            new 24-word seed, shown once; encrypted with your passphrase
 *   vault import            restore from an existing Shelter phrase
 *   vault recover [--gap 20] [--from 0]
 *                           rebuild the address book after an import: scans derived
 *                           addresses on Base for use (nonce, ETH or USDC); each check
 *                           reveals that address to the RPC (BASE_RPC_URL)
 *
 * The phrase and passphrase are read from the terminal with echo off and
 * are never written anywhere but the encrypted vault.
 */

import { join } from "node:path";
import { createBaseChain, USDC_BASE } from "@shelter/burner";
import { createAddressBook, createSeedVault, isKeysError } from "@shelter/keys";
import { createSqliteStore } from "@shelter/keys/sqlite";
import { flag, loadEnv, subArgs } from "./env.js";
import { askHidden, confirm, newPassphrase, shelterHome } from "./prompt.js";

loadEnv();

const usage = `shelter vault status
shelter vault create
shelter vault import
shelter vault recover [--gap 20] [--from 0]`;

const args = subArgs("vault");
const sub = args[0];
const path = join(shelterHome(), "keys.db");
const store = createSqliteStore(path);
const vault = createSeedVault({ store });
const book = createAddressBook(vault);

try {
  if (sub === "status") {
    const id = await vault.vaultId();
    if (!id) {
      console.log(`No vault in ${path}. Create one with: shelter vault create`);
    } else {
      const records = await book.list();
      console.log(`Vault ${id} in ${path}`);
      console.log(`Next index ${await book.nextIndex()}; ${records.length} address(es):`);
      for (const r of records) {
        console.log(`  ${String(r.index).padStart(4)}  ${r.address}  ${r.purpose.padEnd(11)} ${r.status}${r.label ? `  ${r.label}` : ""}`);
      }
    }
  } else if (sub === "create") {
    if (await vault.exists()) {
      console.error(`A vault already exists in ${path}.`);
      process.exit(1);
    }
    const pass = await newPassphrase();
    const { mnemonic, vaultId } = await vault.create(pass, { words: 24 });
    console.log(`\nVault ${vaultId} created in ${path}.\n`);
    console.log("Your recovery phrase. Write it down on paper now; it is shown only this once:\n");
    const words = mnemonic.split(" ");
    for (let i = 0; i < words.length; i += 6) {
      console.log("  " + words.slice(i, i + 6).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(9)}`).join(" "));
    }
    console.log("\nThese addresses use hardened paths (m/44'/60'/0'/0'/n'), so other wallets show different addresses for this phrase.");
    while (!(await confirm("\nHave you written the phrase down?"))) {
      /* ask again */
    }
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear the screen and scrollback
    console.log("Phrase cleared from the screen. Vault ready.");
  } else if (sub === "import") {
    if (await vault.exists()) {
      console.error(`A vault already exists in ${path}.`);
      process.exit(1);
    }
    const phrase = await askHidden("Recovery phrase (hidden): ");
    const pass = await newPassphrase();
    const { vaultId } = await vault.importMnemonic(phrase, pass);
    console.log(`Vault ${vaultId} imported into ${path}. Next, rebuild the address book: shelter vault recover`);
  } else if (sub === "recover") {
    if (!(await vault.exists())) {
      console.error(`No vault in ${path}.`);
      process.exit(1);
    }
    const gapLimit = Number(flag(args, "gap") ?? 20);
    const from = Number(flag(args, "from") ?? 0);
    const rpcUrl = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
    console.log(`Scanning derived addresses on Base through ${new URL(rpcUrl).host}; it sees every address checked.`);
    if (!(await confirm("Continue?"))) process.exit(1);
    await vault.unlock(await askHidden("Vault passphrase: "));
    const chain = createBaseChain({ rpcUrl });
    const r = await book.recover({
      from,
      gapLimit,
      isUsed: async (a) => {
        const [n, eth, usdc] = await Promise.all([chain.nonce(a), chain.nativeBalance(a), chain.tokenBalance(USDC_BASE.token!, a)]);
        return n > 0 || eth > 0n || usdc > 0n;
      },
    });
    console.log(`Scanned through index ${r.scannedThrough}; next index is now ${r.nextIndex}.`);
    console.log(r.recovered.length ? `Recovered ${r.recovered.length} used address(es), all marked retired:` : "No used addresses found that were missing from the book.");
    for (const x of r.recovered) console.log(`  ${String(x.index).padStart(4)}  ${x.address}`);
  } else {
    console.log(usage);
  }
} catch (e) {
  console.error(isKeysError(e) ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  vault.lock();
  store.close?.();
}
