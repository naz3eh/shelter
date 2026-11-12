/**
 * Shelter NEP-413 signing page, served by the CLI on 127.0.0.1 only.
 *
 * It shows the exact request the CLI wants signed and asks Meteor to sign
 * it only when the user clicks "Sign with Meteor". It never signs in to
 * Meteor (that would add an access key to the account), never sends a
 * transaction, and never sees a private key: Meteor returns a public key
 * and a signature, which the CLI verifies before using.
 *
 * The one-time session token arrives in the URL fragment, is moved into
 * memory and removed from the address bar before Meteor is ever called
 * (the Meteor SDK passes the page URL to its popup).
 */

import "./shim.js";
import { MeteorWallet } from "@meteorwallet/sdk";
import { Buffer } from "buffer";

interface SignRequest {
  id: string;
  accountId: string;
  purpose: string;
  summary: string[];
  message: string;
  recipient: string;
  nonce: string; // base64, 32 bytes
}

const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
history.replaceState(null, "", "/");

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const card = $("request");
const signBtn = $<HTMLButtonElement>("sign");
const rejectBtn = $<HTMLButtonElement>("reject");

let current: SignRequest | null = null;
let lastId = "";
let busy = false;

const wallet = new MeteorWallet({ networkId: "mainnet", keyStore: undefined as never, appKeyPrefix: "shelter" });

function setStatus(text: string, tone: "info" | "ok" | "error" = "info") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    cache: "no-store",
    headers: { "X-Shelter-Token": token, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
}

function prettyMessage(msg: string): string {
  try {
    return JSON.stringify(JSON.parse(msg), null, 2);
  } catch {
    return msg;
  }
}

function show(req: SignRequest | null) {
  current = req;
  card.hidden = !req;
  signBtn.disabled = rejectBtn.disabled = !req;
  if (!req) return;
  $("purpose").textContent = req.purpose;
  $("account").textContent = req.accountId;
  $("recipient").textContent = req.recipient;
  $("nonce").textContent = req.nonce;
  $("message").textContent = prettyMessage(req.message);
  const list = $("summary");
  list.replaceChildren(...req.summary.map((s) => Object.assign(document.createElement("li"), { textContent: s })));
  setStatus("Check the request, then sign it with Meteor. Meteor shows it again before you approve.");
}

async function send(body: Record<string, unknown>) {
  const res = await api("/api/result", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`the CLI refused the result (${res.status})`);
}

signBtn.addEventListener("click", async () => {
  if (!current || busy) return;
  busy = true;
  signBtn.disabled = rejectBtn.disabled = true;
  const req = current;
  setStatus("Waiting for Meteor…");
  try {
    const nonce = Buffer.from(req.nonce, "base64");
    const res = await wallet.signMessage({ message: req.message, nonce, recipient: req.recipient, accountId: req.accountId });
    const p = res.payload as { accountId: string; publicKey: string; signature: string };
    await send({ id: req.id, ok: true, accountId: p.accountId, publicKey: p.publicKey, signature: p.signature });
    setStatus("Signed. The CLI is checking the signature. You can keep this tab open for the next request.", "ok");
    show(null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus(`Meteor did not sign: ${message}`, "error");
    try {
      await send({ id: req.id, ok: false, error: message.slice(0, 300) });
    } catch {
      /* the CLI may have timed out already */
    }
    show(null);
  } finally {
    busy = false;
  }
});

rejectBtn.addEventListener("click", async () => {
  if (!current || busy) return;
  const req = current;
  show(null);
  setStatus("Rejected. Nothing was signed.", "error");
  await send({ id: req.id, ok: false, error: "rejected on the signing page" }).catch(() => undefined);
});

async function poll() {
  for (;;) {
    try {
      const res = await api(`/api/next?after=${encodeURIComponent(lastId)}`);
      if (res.status === 200) {
        const req = (await res.json()) as SignRequest;
        lastId = req.id;
        show(req);
      } else if (res.status === 410) {
        setStatus("The CLI has finished. You can close this tab.", "ok");
        show(null);
        return;
      } else if (res.status !== 204) {
        setStatus(`The CLI answered ${res.status}. Restart the command to get a new link.`, "error");
        return;
      }
    } catch {
      setStatus("Lost the connection to the CLI. You can close this tab.", "error");
      return;
    }
  }
}

if (!token) setStatus("This link is missing its session token. Use the link the CLI printed.", "error");
else {
  setStatus("Waiting for a request from the CLI…");
  void poll();
}
