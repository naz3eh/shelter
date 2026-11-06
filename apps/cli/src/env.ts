import { fileURLToPath } from "node:url";

/** Loads the repo-root .env when present (Node 20.6+ built-in). */
export function loadEnv(): void {
  try {
    process.loadEnvFile(
      fileURLToPath(new URL("../../../.env", import.meta.url)),
    );
  } catch {
    // No .env — rely on the ambient environment.
  }
}

/** process.argv after the (optional) subcommand name. */
export function subArgs(command: string): string[] {
  const args = process.argv.slice(2);
  return args[0] === command ? args.slice(1) : args;
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function nearAiKey(): string {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) {
    console.error(
      "NEAR_AI_API_KEY is not set. Add it to .env at the repo root " +
        "(get a key at https://cloud.near.ai) — it never leaves the process.",
    );
    process.exit(1);
  }
  return key;
}
