import { describe, expect, it } from "vitest";
import { encodeEventTopics, erc20Abi, erc721Abi, getAddress, pad, type Hex } from "viem";
import { ERC20_TRANSFER_TOPIC, tokenTransfersOf } from "../src/chain.js";

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NFT = "0x1111111111111111111111111111111111111111";
const A = "0x2222222222222222222222222222222222222222";
const B = "0x3333333333333333333333333333333333333333";

describe("tokenTransfersOf", () => {
  it("reads ERC-20 Transfer logs and skips ERC-721 transfers and other events", () => {
    // All arguments are given, so every topic is a single value.
    const erc20 = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: A, to: B } }) as Hex[];
    const erc721 = encodeEventTopics({ abi: erc721Abi, eventName: "Transfer", args: { from: A, to: B, tokenId: 7n } }) as Hex[];
    const approval = encodeEventTopics({ abi: erc20Abi, eventName: "Approval", args: { owner: A, spender: B } }) as Hex[];
    expect(erc20[0]).toBe(ERC20_TRANSFER_TOPIC);
    expect(
      tokenTransfersOf([
        { address: TOKEN, topics: erc20 },
        { address: NFT, topics: erc721 },
        { address: TOKEN, topics: approval },
        { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, pad(A), null] },
      ]),
    ).toEqual([{ token: getAddress(TOKEN), from: getAddress(A), to: getAddress(B) }]);
  });
});
