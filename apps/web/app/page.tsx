"use client";

import { motion, useReducedMotion } from "motion/react";
import { Play, ShieldCheck } from "lucide-react";
import { ConnectDemo } from "@/components/connect/connect-demo";
import { Reveal } from "@/components/connect/primitives";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    n: "Step 1",
    title: "Pair a dapp",
    body: "The dapp gets its own Base address, derived from your local seed. It is used by that dapp only.",
  },
  {
    n: "Step 2",
    title: "Spend privately",
    body: "The address is funded from your NEAR Intents confidential balance through 1Click. Your other wallets stay out of it.",
  },
  {
    n: "Step 3",
    title: "Checked, then swept back",
    body: "Every request passes the linkage check before you approve. Closing the session returns what is left to the confidential balance.",
  },
];

function Hero() {
  const reduce = useReducedMotion();
  const f = (d: number) => ({
    initial: reduce ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.6, delay: d, ease: [0.22, 1, 0.36, 1] as const },
  });
  return (
    <header className="relative isolate">
      <div aria-hidden className="bg-grid absolute inset-0 -z-10" />
      <div aria-hidden className="glow-shelter absolute inset-0 -z-10" />
      <div className="mx-auto max-w-5xl px-5 pb-16 pt-20 sm:px-8 sm:pt-28">
        <motion.p
          {...f(0)}
          className="inline-flex items-center gap-2 font-mono text-xs tracking-[0.2em] text-shelter"
        >
          <span className="size-1.5 rounded-full bg-shelter shadow-[0_0_12px_var(--shelter)]" />
          SHELTER CONNECT
        </motion.p>
        <motion.h1
          {...f(0.05)}
          className="mt-5 max-w-3xl text-balance text-3xl font-semibold leading-[1.1] tracking-[-0.03em] sm:text-5xl"
        >
          near.com keeps your money private while it sits in the confidential
          balance; Shelter keeps it private when you use it in a dapp.
        </motion.h1>
        <motion.p
          {...f(0.12)}
          className="mt-6 max-w-2xl text-pretty leading-relaxed text-muted-foreground sm:text-lg"
        >
          Connect gives every dapp its own address, funded from the confidential
          balance through 1Click. Requests that would tie that address back to
          your other wallets are blocked, and closing sweeps the funds home. No
          sign-in, no funds, no keys needed to try it.
        </motion.p>
        <motion.div {...f(0.18)} className="mt-8 flex flex-wrap gap-3">
          <TryIt />
          <TryAllowed />
        </motion.div>
      </div>
    </header>
  );
}

function TryIt() {
  return (
    <button
      type="button"
      onClick={() => {
        document.getElementById("connect-demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
        window.dispatchEvent(new CustomEvent("shelter:try-it"));
      }}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-colors",
        "bg-primary text-primary-foreground hover:bg-primary/90",
        "shadow-[0_0_0_1px_oklch(1_0_0/10%),0_8px_24px_-8px_oklch(1_0_0/25%)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Play className="size-3.5 fill-current" aria-hidden />
      Try it
    </button>
  );
}

function TryAllowed() {
  return (
    <button
      type="button"
      onClick={() => {
        document.getElementById("connect-demo")?.scrollIntoView({ behavior: "smooth", block: "start" });
        window.dispatchEvent(new CustomEvent("shelter:try-allowed"));
      }}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-lg border bg-surface-2 px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <ShieldCheck className="size-3.5" aria-hidden />
      Try an allowed request
    </button>
  );
}

function Steps() {
  return (
    <section className="grid gap-3 sm:grid-cols-3">
      {STEPS.map((s, i) => (
        <Reveal key={s.n} delay={i * 0.06} className="panel p-5">
          <p className="font-mono text-[11px] uppercase tracking-wider text-faint">{s.n}</p>
          <h3 className="mt-2 font-medium">{s.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
        </Reveal>
      ))}
    </section>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <Hero />
      <main className="mx-auto max-w-5xl space-y-24 px-5 pb-32 sm:px-8">
        <Steps />
        <ConnectDemo />
      </main>
    </div>
  );
}
