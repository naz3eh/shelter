/**
 * Data layer for the Shelter Connect screens.
 *
 * `ConnectSource` is the typed seam every screen reads through: list dapp
 * accounts, get one with its requests and funding events, subscribe to new
 * requests, approve or reject a request, close an account. Two sources:
 *
 * - `ReplaySource` reads a `shelter-demo-recording` v1 (the format
 *   `demo record --connect` writes, see apps/cli/src/demo/recording.ts) and
 *   replays it with no network, keys or funds. The shipped fixture was built
 *   from the public facts in docs/backend/CONNECT.md; see
 *   scripts/build-connect-fixture.ts.
 * - `BrowserSource` is a typed stub for the live wallet. It stays hidden
 *   behind NEXT_PUBLIC_SHELTER_LIVE=1 until packages/connect ships a browser
 *   entry (IndexedDB store + WalletConnect transport that runs in the page).
 *
 * Type-only imports keep this module free of the packages' Node-side code;
 * the recording validators are structural and run where the data is trusted.
 */

import type { BurnerJob } from "@shelter/burner";
import type { ConnectAccount } from "@shelter/connect";
import fixtureJson from "./fixtures/connect-recording.json";

export type SourceMode = "replay" | "live";

/** The recording envelope `demo record --connect` produces (format v1). */
export interface ConnectRecordingFile {
  format: string;
  v: number;
  recordedAt: string;
  network: string;
  owner: string;
  deposits: unknown[];
  burners: BurnerJob[];
  connect?: { account: ConnectAccount; linked: { id: string; label: string }[] }[];
}

/** One account plus the recording context the screens need. */
export interface ConnectAccountView {
  account: ConnectAccount;
  /** Burner jobs referenced by `account.fundings`, resolved when the source has them. */
  fundingJobs: BurnerJob[];
  /** Linked identities the blocked requests named (replay recordings only). */
  linked: { id: string; label: string }[];
}

export interface ConnectSource {
  readonly mode: SourceMode;
  /** All dapp accounts, oldest first. */
  listAccounts(): Promise<ConnectAccount[]>;
  /** One account with requests, funding events and recording context. */
  getAccount(id: string): Promise<ConnectAccountView | null>;
  /** Called with an account id when a new dapp request arrives. Returns unsubscribe. */
  subscribe(listener: (accountId: string) => void): () => void;
  /** Approve or reject a pending request. */
  decide(accountId: string, seq: number, approve: boolean): Promise<void>;
  /** Close the account and sweep funds back to the confidential balance. */
  closeAccount(accountId: string): Promise<void>;
}

function asRecording(raw: unknown): ConnectRecordingFile {
  const r = raw as Partial<ConnectRecordingFile> | null;
  if (!r || r.format !== "shelter-demo-recording" || r.v !== 1 || !Array.isArray(r.burners)) {
    throw new Error("not a shelter demo recording (format v1)");
  }
  return r as ConnectRecordingFile;
}

/** Replays a recorded Connect session. Read-only: every request already has its recorded decision. */
export class ReplaySource implements ConnectSource {
  readonly mode = "replay" as const;

  constructor(private readonly recording: ConnectRecordingFile) {}

  static fromJson(raw: unknown): ReplaySource {
    return new ReplaySource(asRecording(raw));
  }

  listAccounts(): Promise<ConnectAccount[]> {
    return Promise.resolve((this.recording.connect ?? []).map((c) => c.account));
  }

  getAccount(id: string): Promise<ConnectAccountView | null> {
    const c = (this.recording.connect ?? []).find((x) => x.account.id === id);
    if (!c) return Promise.resolve(null);
    const fundingJobs = this.recording.burners.filter((j) =>
      c.account.fundings.some((f) => f.jobId === j.id),
    );
    return Promise.resolve({ account: c.account, fundingJobs, linked: c.linked });
  }

  subscribe(): () => void {
    return () => {};
  }

  decide(_accountId: string, _seq: number, _approve: boolean): Promise<void> {
    return Promise.reject(
      new Error("Recorded session is read-only: each request already carries its recorded decision."),
    );
  }

  closeAccount(_accountId: string): Promise<void> {
    return Promise.reject(new Error("Recorded session is read-only."));
  }
}

/**
 * Live wallet source. Stub until packages/connect exposes a browser entry
 * (IndexedDB account store and WalletConnect transport that run in the page).
 * Selected only when NEXT_PUBLIC_SHELTER_LIVE=1.
 */
export class BrowserSource implements ConnectSource {
  readonly mode = "live" as const;

  private unavailable(): Promise<never> {
    return Promise.reject(
      new Error(
        "Live Connect is not in this build: packages/connect needs a browser entry (IndexedDB store, WalletConnect transport) first.",
      ),
    );
  }

  listAccounts(): Promise<ConnectAccount[]> {
    return this.unavailable();
  }
  getAccount(): Promise<ConnectAccountView | null> {
    return this.unavailable();
  }
  subscribe(): () => void {
    return () => {};
  }
  decide(): Promise<void> {
    return this.unavailable();
  }
  closeAccount(): Promise<void> {
    return this.unavailable();
  }
}

let shared: ConnectSource | undefined;

/** The source the UI reads: replay by default, the live stub behind NEXT_PUBLIC_SHELTER_LIVE=1. */
export function connectSource(): ConnectSource {
  if (!shared) {
    shared =
      process.env.NEXT_PUBLIC_SHELTER_LIVE === "1"
        ? new BrowserSource()
        : ReplaySource.fromJson(fixtureJson);
  }
  return shared;
}
