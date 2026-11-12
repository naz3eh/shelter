/**
 * Terminal prompts: hidden input for secrets, y/N confirmations.
 * Secrets are read only from an interactive terminal, never from flags or
 * the environment, so they do not end up in shell history or `ps`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function shelterHome(): string {
  return process.env.SHELTER_HOME?.trim() || join(homedir(), ".shelter");
}

function requireTty(what: string) {
  if (!process.stdin.isTTY) {
    console.error(`${what} needs an interactive terminal. Run this command in a terminal window, not through a pipe.`);
    process.exit(1);
  }
}

/** Reads a line without echoing it. */
export function askHidden(question: string): Promise<string> {
  requireTty("Entering a secret");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s: string) => {
      if (!muted || s.includes("\n") || s.includes("\r")) process.stderr.write(muted ? "\n" : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

export function ask(question: string): Promise<string> {
  requireTty("This step");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(question: string): Promise<boolean> {
  const a = (await ask(`${question} [y/N] `)).toLowerCase();
  return a === "y" || a === "yes";
}

export async function newPassphrase(): Promise<string> {
  for (;;) {
    const a = await askHidden("New vault passphrase (at least 8 characters): ");
    if (a.length < 8) {
      console.error("Too short.");
      continue;
    }
    const b = await askHidden("Repeat it: ");
    if (a === b) return a;
    console.error("They do not match. Try again.");
  }
}
