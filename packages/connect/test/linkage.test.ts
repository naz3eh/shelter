import { describe, expect, it } from "vitest";
import { encodeFunctionData, encodePacked, erc20Abi, maxUint256, stringToHex, toHex } from "viem";
import { isConnectError, toRpcError } from "../src/errors.js";
import { blocks, buildIdentity, inspect, type Finding } from "../src/linkage.js";
import { describeRequest, messageText, parseRequest } from "../src/requests.js";

const SELF = "0x5555555555555555555555555555555555555555";
const MAIN = "0xabCDeF0123456789AbcdEf0123456789aBCDEF01";
const OTHER_DAPP = "0x7777777777777777777777777777777777777777";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

const identity = buildIdentity({
  evm: [
    [MAIN, "your main wallet"],
    [OTHER_DAPP, "your Shelter connect address #3"],
    [SELF, "this address (ignored)"],
  ],
  near: ["Carol.near"],
});
const ctx = { self: SELF as `0x${string}`, identity, origin: "https://app.example.org" };
const check = (method: string, params: unknown): Finding[] => inspect(parseRequest(method, params), ctx);
const codes = (f: Finding[]) => f.map((x) => `${x.level}:${x.code}`);

const tx = (o: Record<string, unknown>) => [{ from: SELF, ...o }];

describe("parseRequest", () => {
  it("refuses methods that sign something the user cannot read or that Connect does not send", () => {
    for (const m of ["eth_sign", "eth_signTransaction", "eth_signTypedData", "eth_signTypedData_v3", "wallet_addEthereumChain", "eth_foo"]) {
      try {
        parseRequest(m, []);
        expect.unreachable();
      } catch (e) {
        expect(isConnectError(e, "unsupported")).toBe(true);
        expect(toRpcError(e).code).toBe(4200);
      }
    }
  });

  it("parses transactions with hex or decimal quantities and the input alias", () => {
    const r = parseRequest("eth_sendTransaction", [{ from: SELF.toLowerCase(), to: ROUTER.toLowerCase(), input: "0x1234", value: "0x10", gas: 21000, chainId: "0x2105" }]);
    expect(r).toEqual({
      method: "eth_sendTransaction",
      tx: { from: SELF, to: ROUTER, data: "0x1234", value: 16n, gas: 21000n, chainId: 8453 },
    });
  });

  it("rejects malformed transactions", () => {
    for (const p of [[], [{ to: "nope" }], [{ to: ROUTER, data: "0x123" }], [{ to: ROUTER, value: "-1" }], [{ to: ROUTER, data: "zz" }]]) {
      expect(() => parseRequest("eth_sendTransaction", p)).toThrow();
    }
  });

  it("accepts personal_sign params in either order", () => {
    const msg = stringToHex("hello");
    expect(parseRequest("personal_sign", [msg, SELF])).toMatchObject({ address: SELF, message: msg });
    expect(parseRequest("personal_sign", [SELF, msg])).toMatchObject({ address: SELF, message: msg });
  });

  it("parses typed data given as a JSON string", () => {
    const td = { types: { EIP712Domain: [] }, primaryType: "X", domain: {}, message: {} };
    expect(parseRequest("eth_signTypedData_v4", [SELF, JSON.stringify(td)])).toMatchObject({ typedData: td });
    expect(() => parseRequest("eth_signTypedData_v4", [SELF, "{not json"])).toThrow();
    expect(() => parseRequest("eth_signTypedData_v4", [SELF, { message: {} }])).toThrow();
  });
});

describe("linkage check: transactions", () => {
  it("passes an ordinary swap that pays this address", () => {
    const data = `0x12345678${"0".repeat(24)}${SELF.slice(2)}` as const;
    expect(check("eth_sendTransaction", tx({ to: ROUTER, data }))).toEqual([]);
  });

  it("blocks sending ETH to the user's main wallet, in any letter case", () => {
    expect(codes(check("eth_sendTransaction", tx({ to: MAIN.toLowerCase(), value: "0x1" })))).toEqual(["block:recipient_linked"]);
  });

  it("blocks a token transfer to the main wallet (aligned ABI word)", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [MAIN, 1n] });
    const f = check("eth_sendTransaction", tx({ to: TOKEN, data }));
    expect(codes(f)).toEqual(["block:calldata_linked"]);
    expect(f[0]!.message).toContain("your main wallet");
  });

  it("blocks another Shelter address anywhere in a packed encoding (swap path recipient)", () => {
    const packed = encodePacked(["address", "uint24", "address", "address"], [TOKEN, 500, ROUTER, OTHER_DAPP]);
    const f = check("eth_sendTransaction", tx({ to: ROUTER, data: `0xdeadbeef${packed.slice(2)}` }));
    expect(codes(f)).toEqual(["block:calldata_linked"]);
    expect(f[0]!.message).toContain("connect address #3");
  });

  it("blocks a NEAR account id carried as a memo in calldata", () => {
    const data = `0xabcdef01${toHex("bridge to carol.near").slice(2)}` as const;
    expect(codes(check("eth_sendTransaction", tx({ to: ROUTER, data })))).toEqual(["block:calldata_linked"]);
  });

  it("blocks a NEAR account id as UTF-16 (either byte order) or written as hex text in calldata", () => {
    const utf16le = Buffer.from("memo carol.near", "utf16le").toString("hex");
    const utf16be = Buffer.from(Buffer.from("carol.near", "utf16le").swap16()).toString("hex");
    const hexText = toHex(`memo:${toHex("carol.near").slice(2)}`).slice(2);
    const hexTextUpper = toHex(`memo:${toHex("carol.near").slice(2).toUpperCase()}`).slice(2);
    for (const body of [utf16le, utf16be, hexText, hexTextUpper]) {
      expect(codes(check("eth_sendTransaction", tx({ to: ROUTER, data: `0xabcdef01${body}` }))), body).toEqual(["block:calldata_linked"]);
    }
  });

  it("blocks a linked address written as a string inside calldata", () => {
    const data = `0xabcdef01${toHex(`refund to ${MAIN}`).slice(2)}` as const;
    const f = check("eth_sendTransaction", tx({ to: ROUTER, data }));
    expect(codes(f)).toEqual(["block:calldata_linked"]);
    expect(f[0]!.message).toContain("your main wallet");
  });

  it("does not see an address split into pieces at separate places (documented limit)", () => {
    const h = MAIN.slice(2).toLowerCase();
    const data = `0xabcdef01${h.slice(0, 20)}${"00".repeat(32)}${h.slice(20)}` as const;
    expect(check("eth_sendTransaction", tx({ to: ROUTER, data }))).toEqual([]);
  });

  it("does not block on its own address", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SELF, 5n] });
    expect(check("eth_sendTransaction", tx({ to: TOKEN, data }))).toEqual([]);
  });

  it("blocks a request from another account, another chain, or a contract creation", () => {
    expect(codes(check("eth_sendTransaction", [{ from: MAIN, to: ROUTER }]))).toContain("block:wrong_account");
    expect(codes(check("eth_sendTransaction", tx({ to: ROUTER, chainId: 1 })))).toEqual(["block:wrong_chain"]);
    expect(codes(check("eth_sendTransaction", tx({ data: "0x6000" })))).toEqual(["block:contract_creation"]);
  });

  it("warns on an unlimited approval and describes it", () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, maxUint256] });
    expect(codes(check("eth_sendTransaction", tx({ to: TOKEN, data })))).toEqual(["warn:unlimited_approval"]);
    expect(describeRequest(parseRequest("eth_sendTransaction", tx({ to: TOKEN, data })))).toContain("UNLIMITED");
  });
});

describe("linkage check: messages and typed data", () => {
  it("blocks a message naming the main wallet without 0x or in upper case", () => {
    expect(codes(check("personal_sign", [stringToHex(`link ${MAIN.slice(2).toUpperCase()}`), SELF]))).toEqual(["block:message_linked"]);
  });

  it("blocks a message naming the NEAR account, but not a longer account that contains it", () => {
    expect(codes(check("personal_sign", [stringToHex("I am carol.near."), SELF]))).toEqual(["block:message_linked"]);
    expect(check("personal_sign", [stringToHex("hello alice-carol.near"), SELF])).toEqual([]);
    expect(check("personal_sign", [stringToHex("hello carol.nearby"), SELF])).toEqual([]);
    // A sub-account names its parent.
    expect(codes(check("personal_sign", [stringToHex("pay alice.carol.near"), SELF]))).toEqual(["block:message_linked"]);
  });

  it("checks binary messages as hex", () => {
    const raw = `0xff00${MAIN.slice(2)}` as const;
    expect(messageText(raw)).toBe(raw);
    expect(codes(check("personal_sign", [raw, SELF]))).toEqual(["block:message_linked"]);
  });

  it("blocks a message with the NEAR account as hex text or UTF-16", () => {
    expect(codes(check("personal_sign", [stringToHex(`id ${toHex("carol.near").slice(2)}`), SELF]))).toEqual(["block:message_linked"]);
    expect(codes(check("personal_sign", [`0x${Buffer.from("carol.near", "utf16le").toString("hex")}`, SELF]))).toEqual(["block:message_linked"]);
  });

  it("blocks typed data whose bytes value encodes the NEAR account or a linked address", () => {
    const td = (memo: string) => ({ types: {}, primaryType: "Order", domain: { name: "X", chainId: 8453 }, message: { maker: SELF, memo } });
    expect(codes(check("eth_signTypedData_v4", [SELF, td(toHex("to carol.near"))]))).toEqual(["block:typed_data_linked"]);
    expect(codes(check("eth_signTypedData_v4", [SELF, td(toHex(`to ${MAIN}`))]))).toEqual(["block:typed_data_linked"]);
    expect(check("eth_signTypedData_v4", [SELF, td(toHex("to dave.near"))])).toEqual([]);
  });

  it("blocks a sign-in for another domain and warns on another chain", () => {
    const siwe = (domain: string, chain = 8453) =>
      stringToHex(`${domain} wants you to sign in with your Ethereum account:\n${SELF}\n\nSign in\n\nURI: https://${domain}\nVersion: 1\nChain ID: ${chain}\nNonce: abc`);
    expect(check("personal_sign", [siwe("app.example.org"), SELF])).toEqual([]);
    expect(codes(check("personal_sign", [siwe("evil.example"), SELF]))).toEqual(["block:siwe_domain"]);
    expect(codes(check("personal_sign", [siwe("app.example.org", 1), SELF]))).toEqual(["warn:siwe_chain"]);
  });

  it("blocks typed data that names a linked address at any depth", () => {
    const td = {
      types: {},
      primaryType: "Order",
      domain: { name: "X", chainId: 8453 },
      message: { maker: SELF, legs: [{ deep: { receiver: MAIN.toLowerCase() } }] },
    };
    const f = check("eth_signTypedData_v4", [SELF, td]);
    expect(codes(f)).toEqual(["block:typed_data_linked"]);
  });

  it("warns on an unlimited permit and a foreign chain, blocks a foreign signer", () => {
    const permit = {
      types: {},
      primaryType: "Permit",
      domain: { name: "USD Coin", chainId: 1, verifyingContract: TOKEN },
      message: { owner: SELF, spender: ROUTER, value: maxUint256.toString(), nonce: "0", deadline: "1" },
    };
    expect(codes(check("eth_signTypedData_v4", [SELF, permit])).sort()).toEqual(["warn:typed_data_chain", "warn:unlimited_approval"]);
    expect(codes(check("eth_signTypedData_v4", [MAIN, permit]))).toContain("block:wrong_account");
  });

  it("blocks() keeps only blocking findings", () => {
    expect(blocks([{ level: "warn", code: "unlimited_approval", message: "" }])).toEqual([]);
  });
});
