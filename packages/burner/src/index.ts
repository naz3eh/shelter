/** One-time burner address lifecycle: create, fund, use once, retire. */

export type BurnerState = "created" | "funded" | "used" | "retired";

export interface Burner {
  id: string;
  chain: string;
  address: string;
  state: BurnerState;
  createdAt: string;
}

export function createBurner(_chain: string): Promise<Burner> {
  throw new Error("not implemented");
}

export function markUsed(_burner: Burner): Burner {
  throw new Error("not implemented");
}

export function retireBurner(_burner: Burner): Promise<Burner> {
  throw new Error("not implemented");
}
