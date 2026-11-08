import { describe, expect, it } from "vitest";
import {
  baseToDecimalString,
  decimalToBase,
  ETH_DECIMALS,
  formatUnits,
  isNearAccountId,
  isValidEvmAddress,
  shortenAddress,
  USDC_DECIMALS,
} from "@/lib/flow/money";

describe("decimal/base-unit conversion", () => {
  it("parses decimal strings to integer base units", () => {
    expect(decimalToBase("25", USDC_DECIMALS)).toBe(25_000_000n);
    expect(decimalToBase("0.01", ETH_DECIMALS)).toBe(10_000_000_000_000_000n);
    expect(decimalToBase("1.5", USDC_DECIMALS)).toBe(1_500_000n);
  });

  it("rejects invalid, negative and over-precise input", () => {
    expect(decimalToBase("", USDC_DECIMALS)).toBeNull();
    expect(decimalToBase("abc", USDC_DECIMALS)).toBeNull();
    expect(decimalToBase("-1", USDC_DECIMALS)).toBeNull();
    expect(decimalToBase("1.0000001", USDC_DECIMALS)).toBeNull(); // 7dp > 6dp
    expect(decimalToBase("0.0000000000000000001", ETH_DECIMALS)).toBeNull(); // 19dp > 18dp
  });

  it("round-trips through baseToDecimalString", () => {
    expect(baseToDecimalString("25000000", USDC_DECIMALS)).toBe("25");
    expect(baseToDecimalString("10000000000000000", ETH_DECIMALS)).toBe("0.01");
  });

  it("formatUnits renders readable amounts", () => {
    expect(formatUnits("25000000", USDC_DECIMALS)).toBe("25");
    expect(formatUnits("0", USDC_DECIMALS)).toBe("0");
  });
});

describe("address validation", () => {
  it("accepts 0x EVM addresses only", () => {
    expect(isValidEvmAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isValidEvmAddress("0x123")).toBe(false);
    expect(isValidEvmAddress("not-an-address")).toBe(false);
    expect(isValidEvmAddress("0x" + "g".repeat(40))).toBe(false);
  });

  it("accepts .near implicit and named accounts", () => {
    expect(isNearAccountId("alice.near")).toBe(true);
    expect(isNearAccountId("bob")).toBe(true); // implicit 64-hex? no — short names ok per regex
    expect(isNearAccountId("a".repeat(64))).toBe(true);
    expect(isNearAccountId("bad name.near")).toBe(false);
    expect(isNearAccountId("")).toBe(false);
  });
});

describe("shortenAddress", () => {
  it("keeps head and tail", () => {
    const a = "0x" + "1234567890abcdef".repeat(2) + "1234";
    const s = shortenAddress(a, 4);
    expect(s.startsWith("0x1234")).toBe(true);
    expect(s.endsWith("1234")).toBe(true);
    expect(s).toContain("…");
  });
});
