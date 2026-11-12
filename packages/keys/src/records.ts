/** Strict parser for stored and backed-up address records. */

import { getAddress, isAddress } from "viem";
import { MAX_INDEX } from "./derivation.js";
import { KeysError } from "./errors.js";
import type { AddressRecord } from "./store.js";

export function parseRecord(r: unknown): AddressRecord {
  const bad = (why: string) => new KeysError("unsupported_format", `address record: ${why}`);
  if (typeof r !== "object" || r === null) throw bad("not an object");
  const o = r as Record<string, unknown>;
  const allowed = ["index", "address", "chain", "purpose", "status", "label", "createdAt", "retiredAt"];
  if (Object.keys(o).some((k) => !allowed.includes(k))) throw bad("unknown field");
  if (!Number.isSafeInteger(o.index) || (o.index as number) < 0 || (o.index as number) > MAX_INDEX) throw bad("index");
  if (typeof o.address !== "string" || !isAddress(o.address, { strict: false })) throw bad("address");
  if (typeof o.chain !== "string" || !o.chain) throw bad("chain");
  if (typeof o.purpose !== "string" || !o.purpose) throw bad("purpose");
  if (o.status !== "active" && o.status !== "retired") throw bad("status");
  if (typeof o.createdAt !== "string") throw bad("createdAt");
  if (o.label !== undefined && typeof o.label !== "string") throw bad("label");
  if (o.retiredAt !== undefined && typeof o.retiredAt !== "string") throw bad("retiredAt");
  const rec: AddressRecord = {
    index: o.index as number,
    address: getAddress(o.address),
    chain: o.chain,
    purpose: o.purpose,
    status: o.status,
    createdAt: o.createdAt,
  };
  if (o.label !== undefined) rec.label = o.label as string;
  if (o.retiredAt !== undefined) rec.retiredAt = o.retiredAt as string;
  return rec;
}
