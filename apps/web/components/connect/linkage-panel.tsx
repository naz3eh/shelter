"use client";

/**
 * "Try the linkage check": runs the real Shelter linkage check from
 * @shelter/connect in the browser. Paste the addresses you want kept apart
 * ("my wallets") and a dapp request as JSON; see blocked or allowed with the
 * reason. No funds, no keys, no network.
 */

import { useMemo, useState } from "react";
import { encodeFunctionData, erc20Abi, isAddress, type Hex } from "viem";
import {
  blocks,
  buildIdentity,
  describeRequest,
  inspect,
  parseRequest,
  type DappRequest,
  type Finding,
} from "@shelter/connect";
import { decodeDappRequest } from "@/lib/request-decode";
import { shortenAddresses, shortAddress } from "@/lib/connect-format";
import fixtureJson from "@/lib/fixtures/connect-recording.json";
import { cn } from "@/lib/utils";

const fixture = fixtureJson as {
  connect?: { account: { address: { address: string } }; linked: { id: string; label: string }[] }[];
};
const DEMO_DAPP = fixture.connect?.[0]?.account.address.address as Hex;
const DEMO_LINKED = fixture.connect?.[0]?.linked[0]?.id as Hex | undefined;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

interface ParsedWallets {
  evm: [string, string][];
  near: string[];
  errors: string[];
}

function parseWallets(text: string): ParsedWallets {
  const evm: [string, string][] = [];
  const near: string[] = [];
  const errors: string[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.toLowerCase().startsWith("0x")) {
      if (isAddress(line, { strict: false })) evm.push([line, `wallet ${evm.length + 1}`]);
      else errors.push(`line ${n}: not an EVM address: ${line.slice(0, 20)}…`);
    } else if (/^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/i.test(line) && line.length <= 64) {
      near.push(line.toLowerCase());
    } else {
      errors.push(`line ${n}: not an EVM address or NEAR account id: ${line.slice(0, 30)}`);
    }
  });
  return { evm, near, errors };
}

function selfOf(req: DappRequest): Hex {
  if (req.method === "eth_sendTransaction") return (req.tx.from ?? DEMO_DAPP) as Hex;
  if (req.method === "personal_sign" || req.method === "eth_signTypedData_v4") return req.address;
  return DEMO_DAPP;
}

interface RunResult {
  verdict: "blocked" | "allowed";
  headline: string;
  findings: Finding[];
  self: string;
  decoded: ReturnType<typeof decodeDappRequest> | null;
}

function runCheck(walletsText: string, requestText: string, origin: string): RunResult {
  const wallets = parseWallets(walletsText);
  if (wallets.errors.length) throw new Error(wallets.errors.join("; "));
  if (!wallets.evm.length && !wallets.near.length) {
    throw new Error("Add at least one wallet or NEAR account id under “my wallets”.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestText);
  } catch {
    throw new Error("The request is not valid JSON. Paste an object like {\"method\": \"eth_sendTransaction\", \"params\": […]}.");
  }
  const obj = parsed as { method?: unknown; params?: unknown };
  if (typeof obj?.method !== "string" || obj.params === undefined) {
    throw new Error("The request needs \"method\" and \"params\", e.g. {\"method\":\"eth_sendTransaction\",\"params\":[{…}]}.");
  }
  const req = parseRequest(obj.method, obj.params);
  const identity = buildIdentity({ evm: wallets.evm, near: wallets.near });
  const self = selfOf(req);
  const findings = inspect(req, { self, identity, origin });
  const verdict = blocks(findings).length ? "blocked" : "allowed";
  let decoded: RunResult["decoded"] = null;
  try {
    decoded = decodeDappRequest(req);
  } catch {
    decoded = null;
  }
  return {
    verdict,
    headline: decoded?.listLabel ?? describeRequest(req),
    findings,
    self,
    decoded,
  };
}

function exampleBlocked(): { wallets: string; request: string } {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [DEMO_LINKED as Hex, 100_000n],
  });
  return {
    wallets: `${DEMO_LINKED}\n`,
    request: JSON.stringify(
      {
        method: "eth_sendTransaction",
        params: [{ from: DEMO_DAPP, to: USDC, data, value: "0x0" }],
      },
      null,
      2,
    ),
  };
}

function exampleAllowed(): { wallets: string; request: string } {
  return {
    wallets: `${DEMO_LINKED}\n`,
    request: JSON.stringify(
      {
        method: "eth_sendTransaction",
        params: [
          {
            from: DEMO_DAPP,
            to: USDC,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: ["0x000000000022D473030F116dDEE9F6B43aC78BA3", 2n ** 256n - 1n],
            }),
            value: "0x0",
          },
        ],
      },
      null,
      2,
    ),
  };
}

const textareaClass = cn(
  "w-full rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground",
  "placeholder:text-muted-foreground/50",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
);

export function LinkagePanel() {
  const [wallets, setWallets] = useState("");
  const [request, setRequest] = useState("");
  const [origin, setOrigin] = useState("https://app.uniswap.org");
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    try {
      setResult(runCheck(wallets, request, origin));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadExample = (which: "blocked" | "allowed") => {
    const ex = which === "blocked" ? exampleBlocked() : exampleAllowed();
    setWallets(ex.wallets);
    setRequest(ex.request);
    setResult(null);
    setError(null);
  };

  const fieldCount = useMemo(() => result?.decoded?.fields.length ?? 0, [result]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/70 p-4">
        <div>
          <label htmlFor="linkage-wallets" className="text-sm font-medium text-foreground">
            My wallets
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One per line: EVM addresses (0x…) and NEAR account ids. These are the
            identities Shelter keeps unlinkable.
          </p>
          <textarea
            id="linkage-wallets"
            value={wallets}
            onChange={(e) => setWallets(e.target.value)}
            rows={4}
            placeholder={"0x1234…cdef\nmy-account.near"}
            className={cn(textareaClass, "mt-2")}
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="linkage-request" className="text-sm font-medium text-foreground">
            Dapp request (JSON)
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {`{"method": "eth_sendTransaction", "params": […]}`} — the
            EIP-1193 request a dapp would send.
          </p>
          <textarea
            id="linkage-request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={7}
            placeholder='{"method":"eth_sendTransaction","params":[{"from":"0x…","to":"0x…","data":"0x…","value":"0x0"}]}'
            className={cn(textareaClass, "mt-2")}
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="linkage-origin" className="text-sm font-medium text-foreground">
            Dapp origin
          </label>
          <input
            id="linkage-origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            className={cn(textareaClass, "mt-2")}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={run}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Run the check
          </button>
          <button
            type="button"
            onClick={() => loadExample("blocked")}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Example: blocked Send
          </button>
          <button
            type="button"
            onClick={() => loadExample("allowed")}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Example: unlimited approval
          </button>
        </div>
        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        {result ? (
          <div
            className={cn(
              "rounded-2xl border p-4",
              result.verdict === "blocked"
                ? "border-destructive/50 bg-destructive/10"
                : "border-emerald-500/40 bg-emerald-500/10",
            )}
          >
            <div
              className={cn(
                "text-base font-semibold",
                result.verdict === "blocked" ? "text-red-300" : "text-emerald-300",
              )}
            >
              {result.verdict === "blocked" ? "Blocked by Shelter" : "Allowed"}
            </div>
            <p className="mt-1 text-sm text-foreground">{result.headline}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              checked as dapp address {shortAddress(result.self)} from {origin}
            </p>
            {result.findings.length ? (
              <ul className="mt-3 flex flex-col gap-1.5">
                {result.findings.map((f, i) => (
                  <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-xs">
                    <span
                      className={cn(
                        "mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full text-center leading-3.5",
                        f.level === "block"
                          ? "bg-destructive/25 text-red-300"
                          : "bg-amber-500/20 text-amber-300",
                      )}
                      aria-hidden
                    >
                      {f.level === "block" ? "✕" : "!"}
                    </span>
                    <span className="min-w-0">
                      <code className="font-mono text-foreground">{f.code}</code>{" "}
                      <span className="text-muted-foreground">{shortenAddresses(f.message)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                No findings: the request names nothing on your list.
              </p>
            )}
            {result.decoded && fieldCount ? (
              <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 border-t border-border/60 pt-3 text-xs">
                {result.decoded.fields.slice(0, 8).map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className={cn("min-w-0 break-words text-foreground", f.mono && "font-mono")}>{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="mt-3 text-[11px] text-muted-foreground">
              This runs the same inspect() the wallet runs before asking you to
              approve. Timing, amounts and off-chain fingerprints can still link
              activity; see the threat model.
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Paste your wallets and a request, or load an example, to see the
              check run live in your browser.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
