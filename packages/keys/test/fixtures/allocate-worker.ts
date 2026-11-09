// Child process for the multi-process allocation test: unlocks the shared
// vault and allocates N addresses, printing their indexes as JSON.
// argv: dbPath count [crashAfter]
import { createAddressBook } from "../../src/address-book.js";
import { MIN_KDF } from "../../src/envelope.js";
import { createSqliteStore } from "../../src/sqlite.js";
import { createSeedVault } from "../../src/vault.js";

const [path, countArg, crashAfterArg] = process.argv.slice(2);
const store = createSqliteStore(path!, { busyTimeoutMs: 20_000 });
const vault = createSeedVault({ store, kdf: MIN_KDF });
await vault.unlock("correct horse battery staple");
const book = createAddressBook(vault);
const out: number[] = [];
for (let i = 0; i < Number(countArg); i++) {
  out.push((await book.allocate({ purpose: "burner", chain: "base" })).index);
  // Simulated crash: exit hard without closing the database.
  if (crashAfterArg !== undefined && out.length === Number(crashAfterArg)) process.exit(0);
}
process.stdout.write(JSON.stringify(out));
store.close?.();
