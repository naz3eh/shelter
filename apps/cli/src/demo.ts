import { createAddressBook } from "@shelter/core";

const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  console.log("dry-run replay not recorded yet");
} else {
  const book = createAddressBook();
  console.log(`Shelter demo: live mode not implemented yet (${book.list().length} wallets loaded).`);
  console.log("Try: pnpm demo -- --dry-run");
}
