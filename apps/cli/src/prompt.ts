/**
 * Terminal prompts: hidden input for secrets, y/N confirmations.
 * Secrets are read only from an interactive terminal, never from flags or
 * the environment, so they do not end up in shell history or `ps`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";

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

/**
 * A long-running command (the Connect wallet) keeps one reader on the terminal
 * so the user can type at any time. While it is on, `ask` answers come from it:
 * a line goes to the oldest open question, and only when none is open to the
 * idle handler. Two readers on one terminal would each see every keystroke.
 */
export const isPairingLink = (line: string) => /^wc:/i.test(line);

let shared: { rl: Interface; idlePrompt: string; questions: { text: string; resolve: (a: string) => void }[] } | undefined;

export function listenWhileIdle(idlePrompt: string, onIdleLine: (line: string) => void): () => void {
  requireTty("This step");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const s = (shared = { rl, idlePrompt, questions: [] as { text: string; resolve: (a: string) => void }[] });
  // With a reader on the terminal, Ctrl-C reaches the reader, not the process; pass it on.
  rl.on("SIGINT", () => process.emit("SIGINT"));
  // Output that arrives while a prompt is showing goes above it, and the prompt (with what was typed) is redrawn.
  const log = console.log;
  console.log = (...a: unknown[]) => {
    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
    log(...a);
    rl.prompt(true);
  };
  rl.on("line", (raw) => {
    const line = raw.trim();
    // A pairing link is never an answer: pasted while a question is open, it would
    // silently answer (and so decline) that question and never pair.
    if (isPairingLink(line) && s.questions.length) {
      console.log("  That is a WalletConnect link, not an answer: pairing it. The question above is still open.");
      onIdleLine(line);
    } else {
      const q = s.questions.shift();
      if (q) q.resolve(line);
      else onIdleLine(line);
    }
    showPrompt();
  });
  showPrompt();
  return () => {
    if (shared === s) shared = undefined;
    console.log = log;
    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
    rl.close();
    for (const q of s.questions.splice(0)) q.resolve("");
  };
}

/** Shows the oldest open question, or the idle prompt; call it again after printing a block of output. */
export function showPrompt(): void {
  if (!shared) return;
  // Redraw on a clean line: the previous prompt (and anything typed) may still be on it.
  clearLine(process.stderr, 0);
  cursorTo(process.stderr, 0);
  shared.rl.setPrompt(shared.questions[0]?.text ?? shared.idlePrompt);
  shared.rl.prompt(true);
}

export function ask(question: string): Promise<string> {
  requireTty("This step");
  const s = shared;
  if (s) {
    return new Promise((resolve) => {
      s.questions.push({ text: question, resolve });
      if (s.questions.length === 1) showPrompt();
    });
  }
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
