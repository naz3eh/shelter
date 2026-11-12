import { describe, expect, it } from "vitest";
import { assertPositiveBaseUnits, formatBaseUnits, parseBaseUnits, toBaseUnits } from "../src/amount.js";
import { isIntentsError } from "../src/errors.js";

describe("base-unit amounts", () => {
  it("parses canonical integers, including values beyond 2^53", () => {
    expect(parseBaseUnits("0")).toBe(0n);
    expect(parseBaseUnits("100000000000000000000000")).toBe(10n ** 23n);
  });

  it.each(["", "-1", "1.5", "01", "1e6", " 1", "0x10", "+1"])("rejects %j", (v) => {
    expect(() => parseBaseUnits(v)).toThrowError(/base-unit integer/);
  });

  it("rejects non-strings and uint256 overflow", () => {
    expect(() => parseBaseUnits(1000 as unknown as string)).toThrow();
    expect(() => parseBaseUnits((1n << 256n).toString())).toThrowError(/uint256/);
  });

  it("rejects zero where a positive amount is required", () => {
    try {
      assertPositiveBaseUnits("0");
      expect.unreachable();
    } catch (e) {
      expect(isIntentsError(e, "validation")).toBe(true);
    }
    expect(assertPositiveBaseUnits("150000")).toBe("150000");
  });

  it("converts decimals exactly, without floating point", () => {
    expect(toBaseUnits("0.15", 6)).toBe("150000");
    expect(toBaseUnits("1", 18)).toBe("1000000000000000000");
    expect(toBaseUnits("0.0001", 18)).toBe("100000000000000");
    // 0.1 + 0.2 style traps do not apply.
    expect(toBaseUnits("0.3", 18)).toBe("300000000000000000");
  });

  it("refuses to round away precision", () => {
    expect(() => toBaseUnits("0.1234567", 6)).toThrowError(/fractional digits/);
    expect(() => toBaseUnits("1,5", 6)).toThrow();
    expect(() => toBaseUnits("1", -1)).toThrowError(/decimals/);
  });

  it("formats for display", () => {
    expect(formatBaseUnits("150000", 6)).toBe("0.15");
    expect(formatBaseUnits("1000000", 6)).toBe("1");
    expect(formatBaseUnits("560000000000", 18)).toBe("0.00000056");
  });
});
