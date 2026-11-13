import { ReplaySource } from "../lib/connect-source";
import fixture from "../lib/fixtures/connect-recording.json" with { type: "json" };
import { parseRequest } from "@shelter/connect";
import { decodeDappRequest } from "../lib/request-decode";
import { verifySession } from "../lib/connect-verify";

const src = ReplaySource.fromJson(fixture);
const accounts = await src.listAccounts();
console.log("accounts:", accounts.map((a) => `${a.id} ${a.dapp.origin} ${a.status}`));
const view = await src.getAccount(accounts[0]!.id);
for (const r of view!.account.requests) {
  const d = decodeDappRequest(parseRequest(r.method, r.params));
  console.log(`\nreq ${r.seq} [${r.decision}] ${d.headline}`);
  for (const f of d.fields) console.log(`   ${f.label}: ${f.value}`);
  for (const w of d.warnings) console.log(`   WARN: ${w}`);
  for (const f of r.findings) console.log(`   finding ${f.level}/${f.code}: ${f.message}`);
}
const checks = await verifySession(view!);
const fails = checks.filter((c) => c.status === "fail");
console.log(`\nverify: ${checks.length} checks, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL", f.id, f.label);
