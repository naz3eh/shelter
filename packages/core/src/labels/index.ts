import exchangeLabelsJson from "../../data/exchange-labels.json";
import ofacJson from "../../data/ofac-sanctioned.json";
import type { AddressBook, ChainId } from "../index";

/**
 * Static label sets bundled in data/. All lookups are local Set/Map reads —
 * the user's address set is never sent to a label API.
 */

export interface LabelStore {
  /** Exchange label (e.g. "coinbase") for the address on this chain, or null. */
  exchangeLabel(chain: ChainId, address: string): string | null;
  /** True if the address is on the OFAC ETH sanctions list. */
  isSanctioned(address: string): boolean;
  /** User tag lookup ("this is my Coinbase deposit"). */
  userLabel(address: string): string | null;
  /**
   * Tag an address locally. Mirrored into the address book as its `label`
   * field so it survives with the rest of the on-device state.
   */
  addUserLabel(address: string, label: string): void;
}

// The label JSON is large; cast to a narrow shape instead of letting the
// compiler infer a literal type for ~20k addresses.
const exchangeLabelsData = exchangeLabelsJson as {
  chains: Record<string, Record<string, string>>;
};
const ofacData = ofacJson as { addresses: string[] };

const exchangeByChain = new Map<string, Map<string, string>>(
  Object.entries(exchangeLabelsData.chains).map(([chain, entries]) => [
    chain,
    new Map(Object.entries(entries).map(([a, l]) => [a.toLowerCase(), l])),
  ]),
);

const sanctioned = new Set(ofacData.addresses.map((a) => a.toLowerCase()));

export function createLabelStore(addressBook?: AddressBook): LabelStore {
  const userLabels = new Map<string, string>();
  for (const w of addressBook?.list() ?? []) {
    if (w.label) userLabels.set(w.address.toLowerCase(), w.label);
  }
  return {
    exchangeLabel(chain, address) {
      return exchangeByChain.get(chain)?.get(address.toLowerCase()) ?? null;
    },
    isSanctioned(address) {
      return sanctioned.has(address.toLowerCase());
    },
    userLabel(address) {
      return userLabels.get(address.toLowerCase()) ?? null;
    },
    addUserLabel(address, label) {
      userLabels.set(address.toLowerCase(), label);
      addressBook?.add({ chain: "ethereum", address, label });
    },
  };
}
