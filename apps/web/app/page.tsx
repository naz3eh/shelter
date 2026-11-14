import { ConnectDemo } from "@/components/connect/connect-demo";
import { TryItButton } from "@/components/connect/try-it-button";

const STEPS = [
  {
    title: "Pair a dapp",
    body: "The dapp gets its own Base address, derived from your local seed. It is used by that dapp only.",
  },
  {
    title: "Spend privately",
    body: "The address is funded from your NEAR Intents confidential balance through 1Click. Your other wallets stay out of it.",
  },
  {
    title: "Checked, then swept back",
    body: "Every request passes the linkage check before you approve. Closing the session returns what is left to the confidential balance.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-5 py-14 sm:px-8">
      <section className="flex flex-col items-start gap-6 pt-6">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          Shelter Connect
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-foreground sm:text-5xl">
          near.com keeps your money private while it sits in the confidential
          balance; Shelter keeps it private when you use it in a dapp.
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Connect gives every dapp its own address, funded from the confidential
          balance through 1Click. Requests that would tie that address back to
          your other wallets are blocked, and closing sweeps the funds home.
          No sign-in, no funds, no keys needed to try it.
        </p>
        <TryItButton />
        <ol className="mt-4 grid w-full gap-3 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="rounded-2xl border border-border bg-card/60 p-4"
            >
              <div className="text-xs font-semibold text-muted-foreground">
                Step {i + 1}
              </div>
              <div className="mt-1 text-sm font-semibold text-foreground">{s.title}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <ConnectDemo />
    </main>
  );
}
