import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_FORMAT_VERSION, createMemoryAccountStore, originOf, type AccountStore, type ConnectAccount } from "../src/account.js";
import { isConnectError } from "../src/errors.js";
import { createSqliteAccountStore } from "../src/sqlite.js";

const account = (id: string): ConnectAccount => ({
  v: ACCOUNT_FORMAT_VERSION,
  id,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  status: "open",
  owner: "owner.near",
  chain: "base",
  dapp: { origin: "https://app.example" },
  address: { index: 0, address: "0x5555555555555555555555555555555555555555" },
  budget: { asset: "usdc", amount: "1", payWith: "usdc" },
  fundings: [],
  requests: [],
  events: [],
});

for (const [name, make] of [
  ["memory", () => createMemoryAccountStore()],
  ["sqlite", () => createSqliteAccountStore(join(mkdtempSync(join(tmpdir(), "shelter-connect-")), "connect.db"))],
] as [string, () => AccountStore][]) {
  describe(`${name} account store`, () => {
    it("creates once and updates only from the revision it read", async () => {
      const s = make();
      const a = await s.create(account("ca_1"));
      await expect(s.create(account("ca_1"))).rejects.toSatisfy((e) => isConnectError(e, "busy"));
      const b = await s.update({ ...a.account, status: "closing" }, a.rev);
      expect(b.rev).toBe(2);
      await expect(s.update(a.account, a.rev)).rejects.toSatisfy((e) => isConnectError(e, "busy"));
      await expect(s.update(account("ca_x"), 1)).rejects.toSatisfy((e) => isConnectError(e, "not_found"));
      expect((await s.get("ca_1"))!.account.status).toBe("closing");
      expect((await s.list()).map((x) => x.account.id)).toEqual(["ca_1"]);
      s.close?.();
    });
  });
}

describe("sqlite account store file", () => {
  it("is private to the user", () => {
    const path = join(mkdtempSync(join(tmpdir(), "shelter-connect-")), "nested", "connect.db");
    createSqliteAccountStore(path).close?.();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("originOf", () => {
  it("keeps scheme and host only, lower-case, https or local http", () => {
    expect(originOf("https://App.Uniswap.org/swap?x=1")).toBe("https://app.uniswap.org");
    expect(originOf("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => originOf("http://example.com")).toThrow("not https");
    expect(() => originOf("uniswap")).toThrow("not a URL");
  });
});
