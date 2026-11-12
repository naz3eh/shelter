/**
 * NEP-413 signer backed by the user's Meteor wallet, for the CLI (option A:
 * the key stays in Meteor; the CLI never holds it).
 *
 * How it works:
 * - A one-shot HTTP server listens on 127.0.0.1 (random port).
 * - The browser opens http://127.0.0.1:<port>/#t=<token>. The page moves the
 *   token into memory and strips it from the URL before Meteor is called.
 * - Each `sign()` queues a request; the page long-polls for it, shows the
 *   exact message, and calls Meteor's `signMessage` only on the user's click.
 * - The page posts back `{ accountId, publicKey, signature }`. The caller
 *   (`signNep413Checked` in @shelter/intents) verifies the signature over
 *   the exact payload before using it.
 *
 * Server hardening: binds 127.0.0.1 only; every request must carry the
 * expected Host (anti DNS-rebinding); API calls need the token in the
 * `X-Shelter-Token` header (a custom header forces a CORS preflight, which
 * is never answered, so other sites cannot call the API); POSTs must come
 * from the page's own Origin; bodies are capped at 16 KB; strict CSP,
 * no-store, no-referrer, frame-ancestors none. Nothing sensitive crosses
 * the bridge: the request is public data and the response is a public key
 * and a signature.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { IntentsError, type Nep413Payload, type Nep413Signature, type Nep413Signer } from "@shelter/intents";
import * as esbuild from "esbuild";

const PAGE_DIR = fileURLToPath(new URL("../../near-signer-page/", import.meta.url));
const MAX_BODY = 16 * 1024;
const POLL_HOLD_MS = 25_000;

export interface MeteorSignerOptions {
  /** The NEAR account expected to sign (for example viraz.near). */
  accountId: string;
  /** Per-signature timeout. Default 5 minutes. */
  timeoutMs?: number;
  /** Open the page automatically. Default true; the URL is always printed. */
  openBrowser?: boolean;
  log?: (line: string) => void;
}

export interface MeteorSigner extends Nep413Signer {
  /** Stops the local server; the page shows "finished". */
  close(): Promise<void>;
}

interface Pending {
  id: string;
  payload: Nep413Payload;
  purpose: string;
  summary: string[];
  resolve: (s: Nep413Signature) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

const PURPOSES: Record<string, { title: string; summary: string[] }> = {
  "sign-in": {
    title: "Sign in to 1Click (Confidential Intents)",
    summary: [
      "Proves you control this account so 1Click can show its confidential balance and quotes.",
      "The message contains no intents: it moves no funds and expires in 5 minutes.",
    ],
  },
  withdraw: {
    title: "Spend from your confidential balance",
    summary: ["This authorises the transfer shown in the message. Check the amount and token before signing."],
  },
};

let bundled: Promise<string> | undefined;
function bundle(): Promise<string> {
  bundled ??= esbuild
    .build({
      entryPoints: [`${PAGE_DIR}main.ts`],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      legalComments: "none",
      alias: { util: `${PAGE_DIR}util-shim.ts` },
      define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    })
    .then((r) => r.outputFiles[0]!.text);
  return bundled;
}

export async function createMeteorSigner(opts: MeteorSignerOptions): Promise<MeteorSigner> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const token = randomBytes(32).toString("base64url");
  const tokenBuf = Buffer.from(token);
  const [html, css, js] = [readFileSync(`${PAGE_DIR}index.html`, "utf8"), readFileSync(`${PAGE_DIR}app.css`, "utf8"), await bundle()];

  const queue: Pending[] = [];
  const waiters = new Set<{ after: string; res: ServerResponse; timer: NodeJS.Timeout }>();
  let closed = false;
  let opened = false;
  let seq = 0;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain", "error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const url = `${origin}/#t=${token}`;

  function send(res: ServerResponse, status: number, type: string, body: string) {
    res.writeHead(status, {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "unsafe-none",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https:; img-src 'self' data:; frame-src https://wallet.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(body);
  }

  const authed = (req: IncomingMessage) => {
    const t = req.headers["x-shelter-token"];
    if (typeof t !== "string") return false;
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const requestJson = (p: Pending) =>
    JSON.stringify({
      id: p.id,
      accountId: opts.accountId,
      purpose: p.purpose,
      summary: p.summary,
      message: p.payload.message,
      recipient: p.payload.recipient,
      nonce: Buffer.from(p.payload.nonce).toString("base64"),
    });

  function flush() {
    for (const w of waiters) {
      const next = queue.find((p) => p.id !== w.after) ?? (closed ? null : undefined);
      if (next === undefined) continue;
      clearTimeout(w.timer);
      waiters.delete(w);
      if (next === null) send(w.res, 410, "text/plain", "closed");
      else send(w.res, 200, "application/json", requestJson(next));
    }
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== host) return send(res, 421, "text/plain", "wrong host");
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/") return send(res, 200, "text/html", html);
    if (req.method === "GET" && path === "/app.css") return send(res, 200, "text/css", css);
    if (req.method === "GET" && path === "/app.js") return send(res, 200, "text/javascript", js);
    if (!path?.startsWith("/api/")) return send(res, 404, "text/plain", "not found");
    if (!authed(req)) return send(res, 403, "text/plain", "forbidden");

    if (req.method === "GET" && path === "/api/next") {
      opened = true;
      const after = new URL(req.url ?? "/", origin).searchParams.get("after") ?? "";
      const w = { after, res, timer: setTimeout(() => (waiters.delete(w), send(res, 204, "text/plain", "")), POLL_HOLD_MS) };
      waiters.add(w);
      req.on("close", () => (clearTimeout(w.timer), waiters.delete(w)));
      return flush();
    }

    if (req.method === "POST" && path === "/api/result") {
      if (req.headers.origin !== origin) return send(res, 403, "text/plain", "wrong origin");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "text/plain", "json only");
      let body: { id?: unknown; ok?: unknown; accountId?: unknown; publicKey?: unknown; signature?: unknown; error?: unknown };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, "text/plain", "bad body");
      }
      const i = queue.findIndex((p) => p.id === body.id);
      if (i < 0) return send(res, 409, "text/plain", "no such request");
      const [p] = queue.splice(i, 1);
      clearTimeout(p!.timer);
      if (body.ok === true && typeof body.accountId === "string" && typeof body.publicKey === "string" && typeof body.signature === "string") {
        p!.resolve({ accountId: body.accountId, publicKey: body.publicKey, signature: body.signature });
      } else {
        const why = typeof body.error === "string" ? body.error.slice(0, 300) : "no signature returned";
        p!.reject(new IntentsError("signer_rejected", `Meteor did not sign: ${why}`));
      }
      send(res, 204, "text/plain", "");
      return flush();
    }
    return send(res, 405, "text/plain", "method not allowed");
  }

  function openPage() {
    log(`Open this page to sign with Meteor (it only works on this computer):\n  ${url}`);
    if (opts.openBrowser === false || opened) return;
    const [cmd, args] =
      process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    try {
      spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
    } catch {
      /* the printed URL is enough */
    }
  }

  return {
    accountId: opts.accountId,
    sign(payload, o = {}) {
      if (closed) return Promise.reject(new IntentsError("signer_rejected", "the Meteor signer is closed"));
      const meta = PURPOSES[o.purpose ?? ""] ?? { title: o.purpose ?? "Sign a message", summary: [] };
      return new Promise<Nep413Signature>((resolve, reject) => {
        const id = `${++seq}-${randomBytes(6).toString("hex")}`;
        const fail = (e: unknown) => {
          const k = queue.findIndex((q) => q.id === id);
          if (k >= 0) clearTimeout(queue.splice(k, 1)[0]!.timer);
          reject(e);
          flush();
        };
        const timer = setTimeout(() => fail(new IntentsError("signer_rejected", "timed out waiting for Meteor")), timeoutMs);
        o.signal?.addEventListener("abort", () => fail(new IntentsError("aborted", "signing cancelled")), { once: true });
        queue.push({ id, payload, purpose: meta.title, summary: meta.summary, resolve, reject, timer });
        log(`Waiting for Meteor: ${meta.title} as ${opts.accountId}`);
        if (!opened) openPage();
        flush();
      });
    },
    async close() {
      closed = true;
      for (const p of queue.splice(0)) {
        clearTimeout(p.timer);
        p.reject(new IntentsError("signer_rejected", "the Meteor signer was closed"));
      }
      flush();
      await new Promise<void>((r) => setTimeout(r, 200));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
