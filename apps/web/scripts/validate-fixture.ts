import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAccount } from "@shelter/connect";
import { parseJob } from "@shelter/burner";

const raw = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "fixtures", "connect-recording.json"), "utf8"));
if (raw.format !== "shelter-demo-recording" || raw.v !== 1) throw new Error("bad recording header");
for (const c of raw.connect ?? []) parseAccount(c.account);
for (const b of raw.burners ?? []) parseJob(b);
console.log("recording OK:", raw.connect?.length ?? 0, "connect session(s),", raw.burners?.length ?? 0, "burner job(s)");
