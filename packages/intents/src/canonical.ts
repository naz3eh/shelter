/**
 * Deterministic JSON with keys sorted at every level: the serialisation
 * 1Click signs quotes over.
 *
 * Matches json-stable-stringify 1.3.0 (the library the official SDK uses)
 * for JSON-shaped input: undefined, function and symbol members are omitted
 * from objects and become null in arrays, toJSON is honoured, keys sort by
 * UTF-16 code unit. A test checks equivalence against that library. It is
 * reimplemented because the library pulls call-bind/get-intrinsic polyfills
 * into browser bundles.
 */

export function canonicalJson(value: unknown): string | undefined {
  return encode(value, new Set());
}

function encode(input: unknown, stack: Set<object>): string | undefined {
  let v = input;
  if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
    v = (v as { toJSON: () => unknown }).toJSON();
  }
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v !== "object") return JSON.stringify(v);

  if (stack.has(v)) throw new TypeError("Converting circular structure to JSON");
  stack.add(v);
  try {
    if (Array.isArray(v)) {
      return `[${v.map((x) => encode(x, stack) ?? "null").join(",")}]`;
    }
    const obj = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const s = encode(obj[key], stack);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(v);
  }
}
