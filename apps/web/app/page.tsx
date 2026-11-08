"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/motion/card";
import { StatefulButton } from "@/components/motion/button/stateful";
import { SAMPLE_PROFILES } from "@/lib/flow/profiles";
import { useFlow } from "@/lib/flow/store";
import type { SampleId } from "@/lib/flow/types";
import { isNearAccountId, isValidEvmAddress } from "@/lib/flow/money";
import { cn } from "@/lib/utils";

const STEPS = [
  "Set up — pick a fictional sample (no wallet, keys or funds needed)",
  "Scan — the real exposure engine scores the recorded history on this device",
  "Plan — preview a private move into NEAR Confidential Intents",
  "Move — watch a simulated deposit → confidential balance → fresh destinations",
  "Burner — simulate a one-time USDC action from a throwaway address",
  "Re-scan — compare before/after on a separate fictional dataset",
];

export default function SetupPage() {
  const router = useRouter();
  const { state, startSampleScan, selectProfile } = useFlow();
  const [selected, setSelected] = useState<SampleId>("exposed");

  // Address-entry UI state — present but execution-disabled this milestone.
  const [chain, setChain] = useState<"ethereum" | "base" | "near">("ethereum");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  const start = () => {
    startSampleScan(selected);
    router.push("/scan");
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Shelter
        </h1>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          Shelter scans the public history of your wallets, scores what an
          observer could learn, and plans a private move into NEAR Confidential
          Intents — then runs each later public action from a one-time burner.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This milestone is a <strong className="text-foreground">sample-data
          demo</strong>: everything runs on fictional recorded histories inside
          this browser. No wallet connection, seed phrase, signature or real
          funds are involved — the move and burner steps are simulations.
        </p>
      </section>

      <section aria-labelledby="flow-steps">
        <h2 id="flow-steps" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          The six-step flow
        </h2>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className="flex items-start gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 text-sm"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground">
                {i + 1}
              </span>
              <span className="text-foreground/90">{s}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">
          Mainnet execution (real deposits, withdrawals and burner funding) is
          not part of this build — the simulated steps show the shape of the
          flow only.
        </p>
      </section>

      <section aria-labelledby="samples">
        <h2 id="samples" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Choose a fictional sample
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          All three are recorded fictional histories — deterministic fixture
          data, not real addresses with real history.
        </p>
        <div
          role="radiogroup"
          aria-label="Sample profile"
          className="mt-4 grid gap-3 sm:grid-cols-3"
        >
          {(Object.keys(SAMPLE_PROFILES) as SampleId[]).map((id) => {
            const sample = SAMPLE_PROFILES[id];
            const active = selected === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setSelected(id);
                  selectProfile(id);
                }}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  active
                    ? "border-primary/60 bg-muted/60"
                    : "border-border bg-card/50 hover:border-border-strong",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{sample.title}</span>
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full border",
                      active ? "border-primary bg-primary" : "border-border",
                    )}
                    aria-hidden
                  />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {sample.blurb}
                </p>
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  {sample.profile.wallets.length} wallet
                  {sample.profile.wallets.length === 1 ? "" : "s"} ·{" "}
                  {sample.profile.wallets.map((w) => w.chain).join(", ")}
                </p>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <StatefulButton onClick={start}>
            Scan {SAMPLE_PROFILES[selected].title.toLowerCase()} sample
          </StatefulButton>
          <span className="text-xs text-muted-foreground">
            Computes the report in this browser — one clear action, no popups.
          </span>
        </div>
        {state.scan.status === "loading" ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            Scanning {SAMPLE_PROFILES[selected].title.toLowerCase()}…
          </p>
        ) : null}
      </section>

      <section aria-labelledby="address-entry">
        <Card size="compact" className="max-w-2xl">
          <CardHeader>
            <CardTitle as="h2" id="address-entry">
              Scan your own addresses — coming with live integration
            </CardTitle>
            <CardDescription>
              The address-entry UI is ready; live scanning against real chain
              history arrives with the backend integration and is disabled for
              now so nothing pretends to work.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Chain
                <select
                  value={chain}
                  onChange={(e) => {
                    setChain(e.target.value as typeof chain);
                    setAddressError(null);
                  }}
                  className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground"
                >
                  <option value="ethereum">Ethereum</option>
                  <option value="base">Base</option>
                  <option value="near">NEAR (.near)</option>
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                Address
                <input
                  value={address}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAddress(v);
                    const t = v.trim();
                    if (!t) {
                      setAddressError(null);
                    } else {
                      const ok =
                        chain === "near"
                          ? isNearAccountId(t)
                          : isValidEvmAddress(t);
                      setAddressError(
                        ok ? null : "Invalid address format for the selected chain.",
                      );
                    }
                  }}
                  placeholder={
                    chain === "near" ? "name.near" : "0x…"
                  }
                  className="h-10 rounded-lg border border-border bg-card px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground/60"
                  aria-invalid={addressError ? true : undefined}
                  aria-describedby={addressError ? "address-error" : undefined}
                />
              </label>
              <StatefulButton
                variant="outline"
                disabled
                title="Live address scanning is not part of this milestone"
              >
                Scan address
              </StatefulButton>
            </div>
            {addressError ? (
              <p id="address-error" className="text-xs text-red-400" role="alert">
                {addressError}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Validation still runs: {chain === "near" ? "NEAR account ids" : "0x EVM addresses"}{" "}
              are checked for format and duplicates are rejected — but a custom
              address cannot be scanned yet because there is no recorded
              history for it. Built-in profiles above work end-to-end.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
