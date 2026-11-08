import type {
  ApprovalRecord,
  ChainId,
  TokenTransferRecord,
  TxRecord,
} from "./types";

/** Minimal Blockscout REST API v2 client (https://eth.blockscout.com/api/v2). */

interface BsAddress {
  hash?: string;
}

interface BsTx {
  hash?: string;
  from?: BsAddress | string;
  to?: BsAddress | string | null;
  value?: string;
  timestamp?: string;
  method?: string;
  decoded_input?: {
    method_call?: string;
    parameters?: { name?: string; type?: string; value?: string }[];
  } | null;
}

interface BsTokenTransfer {
  transaction_hash?: string;
  from?: BsAddress | string;
  to?: BsAddress | string | null;
  token?: { address_hash?: string; symbol?: string };
  total?: { value?: string };
  timestamp?: string;
}

interface BsPage<T> {
  items?: T[];
  next_page_params?: Record<string, unknown> | null;
}

const addrOf = (v: BsAddress | string | null | undefined): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.hash ?? null;
};

export class BlockscoutClient {
  constructor(
    private readonly chain: ChainId,
    private readonly baseUrl: string,
    private readonly maxPages = 5,
  ) {}

  private async getPage<T>(path: string, params?: Record<string, unknown>) {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`blockscout ${this.chain} ${res.status} for ${path}`);
    }
    return (await res.json()) as BsPage<T>;
  }

  private async getAll<T>(path: string, firstParams?: Record<string, unknown>) {
    const out: T[] = [];
    let params = firstParams;
    for (let i = 0; i < this.maxPages; i++) {
      const page = await this.getPage<T>(path, params);
      out.push(...(page.items ?? []));
      if (!page.next_page_params) break;
      params = page.next_page_params;
    }
    return out;
  }

  async getTransactions(address: string): Promise<TxRecord[]> {
    const items = await this.getAll<BsTx>(`/addresses/${address}/transactions`);
    return items.map((t) => ({
      hash: t.hash ?? "",
      chain: this.chain,
      from: (addrOf(t.from) ?? "").toLowerCase(),
      to: addrOf(t.to)?.toLowerCase() ?? null,
      valueWei: t.value ?? "0",
      timestamp: t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1000) : 0,
      ...(t.method || t.decoded_input?.method_call
        ? { method: (t.decoded_input?.method_call ?? t.method ?? "").split("(")[0] }
        : {}),
    }));
  }

  async getTokenTransfers(address: string): Promise<TokenTransferRecord[]> {
    const items = await this.getAll<BsTokenTransfer>(
      `/addresses/${address}/token-transfers`,
      { type: "ERC-20" },
    );
    return items.map((t) => ({
      hash: t.transaction_hash ?? "",
      chain: this.chain,
      token: (t.token?.address_hash ?? "").toLowerCase(),
      ...(t.token?.symbol ? { symbol: t.token.symbol } : {}),
      from: (addrOf(t.from) ?? "").toLowerCase(),
      to: addrOf(t.to)?.toLowerCase() ?? null,
      value: t.total?.value ?? "0",
      timestamp: t.timestamp ? Math.floor(Date.parse(t.timestamp) / 1000) : 0,
    }));
  }

  /**
   * Approvals are not a first-class endpoint; they are recovered from the
   * address's outgoing approve()/increaseAllowance() transactions' decoded
   * calldata.
   */
  async getApprovals(address: string): Promise<ApprovalRecord[]> {
    const items = await this.getAll<BsTx>(
      `/addresses/${address}/transactions`,
      { filter: "from" },
    );
    const out: ApprovalRecord[] = [];
    for (const t of items) {
      const method = t.decoded_input?.method_call ?? t.method ?? "";
      if (!/^(approve|increaseAllowance)\b/.test(method)) continue;
      const spender = t.decoded_input?.parameters?.find(
        (p) => p.name === "spender" || p.name === "_spender",
      )?.value;
      const token = addrOf(t.to);
      if (!spender || !token) continue;
      out.push({
        txHash: t.hash ?? "",
        chain: this.chain,
        token: token.toLowerCase(),
        owner: address.toLowerCase(),
        spender: spender.toLowerCase(),
      });
    }
    return out;
  }
}
