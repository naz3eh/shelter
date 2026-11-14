import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Next.js only loads `.env*` files from `apps/web`, but this repo keeps
 * secrets in the root `.env` (see README). API routes call this so a judge
 * who followed the README's `cp .env.example .env` gets a working backend
 * from `pnpm --filter web dev` without duplicating the file. Existing
 * environment variables always win; nothing is logged.
 */
export function ensureRootEnv(): void {
  for (const dir of [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
  ]) {
    const file = path.join(dir, ".env");
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      const key = m?.[1];
      const value = m?.[2];
      if (key === undefined || value === undefined || process.env[key] !== undefined) continue;
      process.env[key] = value.replace(/^['"]|['"]$/g, "");
    }
    return;
  }
}
