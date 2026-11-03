/** Exposure engine, planner, and address book. */

export type ChainId = "base" | "ethereum" | (string & {});

export interface WalletRef {
  chain: ChainId;
  address: string;
  label?: string;
}

export interface ExposureFinding {
  kind: "cex-link" | "ens" | "reused-address" | "large-balance" | "public-counterparty" | (string & {});
  weight: number;
  detail: string;
}

export interface ExposureReport {
  wallet: WalletRef;
  /** 0 (private) to 100 (fully exposed). */
  score: number;
  findings: ExposureFinding[];
}

export interface PlanStep {
  action: "fund-burner" | "deposit" | "withdraw" | "wait";
  description: string;
}

export interface RemediationPlan {
  wallet: WalletRef;
  steps: PlanStep[];
}

export function scoreExposure(_wallet: WalletRef): Promise<ExposureReport> {
  throw new Error("not implemented");
}

export function planRemediation(_report: ExposureReport): RemediationPlan {
  throw new Error("not implemented");
}

export interface AddressBook {
  list(): WalletRef[];
  add(wallet: WalletRef): void;
  remove(address: string): void;
}

export function createAddressBook(): AddressBook {
  const entries = new Map<string, WalletRef>();
  return {
    list: () => [...entries.values()],
    add: (w) => void entries.set(w.address.toLowerCase(), w),
    remove: (a) => void entries.delete(a.toLowerCase()),
  };
}
