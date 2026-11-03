/** Seed vault and hardened key derivation. Secrets never leave the device. */

export interface SeedVault {
  isUnlocked(): boolean;
  unlock(passphrase: string): Promise<void>;
  lock(): void;
}

export interface DerivedKey {
  /** Hardened derivation path, e.g. m/44'/60'/0'/0'/n' */
  path: string;
  address: string;
}

export function createSeedVault(): SeedVault {
  throw new Error("not implemented");
}

export function deriveHardened(_vault: SeedVault, _index: number): Promise<DerivedKey> {
  throw new Error("not implemented");
}
