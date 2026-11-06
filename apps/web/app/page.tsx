import type { ExposureReport } from "@shelter/core";
import { VerifiedPanel } from "@/components/verified-panel";

const placeholder: Pick<ExposureReport, "score"> = { score: 0 };

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight">Shelter</h1>
      <p className="text-neutral-400">
        Scan your public wallets, see your exposure score, and move privately into NEAR Confidential Intents.
      </p>
      <div className="rounded-xl border border-neutral-800 p-6">
        <div className="text-sm text-neutral-500">Exposure score</div>
        <div className="text-5xl font-bold">{placeholder.score}</div>
      </div>
      <VerifiedPanel />
    </main>
  );
}
