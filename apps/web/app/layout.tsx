import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { FlowProvider } from "@/lib/flow/store";
import { FlowHeader } from "@/components/flow-header";

export const metadata: Metadata = {
  title: "Shelter",
  description:
    "Privacy remediation demo: scan fictional wallets, preview a plan, and watch a simulated private move — sample data only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <FlowProvider>
          <FlowHeader />
          <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
            {children}
          </main>
        </FlowProvider>
      </body>
    </html>
  );
}
