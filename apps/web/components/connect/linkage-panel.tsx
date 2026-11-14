"use client";

/**
 * "Try the linkage check": runs the real Shelter linkage check from
 * @shelter/connect in the browser. Paste the addresses you want kept apart
 * ("my wallets") and a dapp request as JSON; see blocked or allowed with the
 * reason. No funds, no keys, no network.
 */

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { CircleDot, ShieldCheck, ShieldX, AlertTriangle } from "lucide-react";
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
import { Btn } from "./primitives";
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

const fieldClass = cn(
  "mt-2 w-full rounded-lg border border-input bg-background/60 px-3 py-2 font-mono text-xs text-foreground",
  "placeholder:text-faint/70",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      <form
        className="panel space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <label className="block">
          <span className="text-sm font-medium">My wallets</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            One per line: EVM addresses (0x…) and NEAR account ids. These are the
            identities Shelter keeps unlinkable.
          </span>
          <textarea
            id="linkage-wallets"
            value={wallets}
            onChange={(e) => setWallets(e.target.value)}
            rows={3}
            placeholder={"0x1234...cdef\nmy-account.near"}
            className={cn(fieldClass, "resize-y")}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Dapp request (JSON)</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            <span className="font-mono">{`{"method": "eth_sendTransaction", "params": [...]}`}</span>, the
            EIP-1193 request a dapp would send.
          </span>
          <textarea
            id="linkage-request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={6}
            placeholder='{"method":"eth_sendTransaction","params":\n[{"from":"0x...","to":"0x...","data":"0x...","value":"0x0"}]}'
            className={cn(fieldClass, "resize-y")}
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Dapp origin</span>
          <input
            id="linkage-origin"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            className={cn(fieldClass, "h-9")}
            spellCheck={false}
          />
        </label>
        <div className="flex flex-wrap gap-2 pt-1">
          <Btn type="submit" variant="primary">
            Run the check
          </Btn>
          <Btn type="button" onClick={() => loadExample("blocked")}>
            Example: blocked Send
          </Btn>
          <Btn type="button" onClick={() => loadExample("allowed")}>
            Example: unlimited approval
          </Btn>
        </div>
        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        ) : null}
      </form>

      <div className="panel relative grid min-h-[320px] place-items-center overflow-hidden p-6">
        {!result ? (
          <div className="max-w-xs text-center">
            <span className="mx-auto grid size-10 place-items-center rounded-xl border border-dashed text-faint">
              <CircleDot className="size-4" aria-hidden />
            </span>
            <p className="mt-3 text-sm text-muted-foreground">
              Paste your wallets and a request, or load an example, to see the
              check run live in your browser.
            </p>
          </div>
        ) : (
          <ResultView result={result} origin={origin} fieldCount={fieldCount} />
        )}
      </div>
    </div>
  );
}

function ResultView({
  result,
  origin,
  fieldCount,
}: {
  result: RunResult;
  origin: string;
  fieldCount: number;
}) {
  const reduce = useReducedMotion();
  const hasWarn = result.findings.some((f) => f.level === "warn");
  const tone = result.verdict === "blocked" ? "danger" : hasWarn ? "warn" : "ok";
  const s = {
    danger: { I: ShieldX, c: "text-destructive border-destructive/40 bg-destructive/12", g: "glow-danger", title: "Blocked by Shelter" },
    warn: { I: AlertTriangle, c: "text-warn border-warn/40 bg-warn/12", g: "", title: "Warning" },
    ok: { I: ShieldCheck, c: "text-shelter border-shelter/40 bg-shelter/12", g: "glow-shelter", title: "Allowed" },
  }[tone];
  const code = result.findings[0]?.code ?? "no_link_found";
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="w-full"
    >
      <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-48", s.g)} />
      <div className="relative flex flex-col items-center text-center">
        <span className={cn("relative grid size-12 place-items-center rounded-2xl border", s.c)}>
          <s.I className="size-6" aria-hidden />
        </span>
        <p className={cn("relative mt-4 text-lg font-semibold", s.c.split(" ")[0])}>{s.title}</p>
        <span className={cn("relative mt-2 inline-block rounded-md border px-2 py-0.5 font-mono text-xs", s.c)}>{code}</span>
        <p className="relative mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">{result.headline}</p>
        <p className="relative mt-1 text-xs text-faint">
          checked as dapp address {shortAddress(result.self)} from {origin}
        </p>
      </div>

      {result.findings.length ? (
        <ul className="relative mx-auto mt-4 max-w-md space-y-2 text-left text-sm">
          {result.findings.map((f, i) => (
            <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-xs">
              <span
                className={cn(
                  "mt-0.5 inline-block size-3.5 shrink-0 rounded-full text-center leading-3.5",
                  f.level === "block"
                    ? "bg-destructive/25 text-destructive"
                    : "bg-warn/20 text-warn",
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
        <p className="relative mx-auto mt-4 max-w-md text-xs text-muted-foreground">
          No findings: the request names nothing on your list.
        </p>
      )}

      {result.decoded && fieldCount ? (
        <dl className="relative mx-auto mt-4 grid max-w-md grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 border-t border-border/60 pt-3 text-left text-xs">
          {result.decoded.fields.slice(0, 8).map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-faint">{f.label}</dt>
              <dd className={cn("min-w-0 break-words text-foreground", f.mono && "font-mono")}>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className="relative mx-auto mt-4 max-w-md text-center text-[11px] leading-relaxed text-faint">
        This runs the same inspect() the wallet runs before asking you to
        approve. Timing, amounts and off-chain fingerprints can still link
        activity; see the threat model.
      </p>
    </motion.div>
  );
}
