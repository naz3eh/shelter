import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The browser entry points must not reach Node built-ins (node:sqlite, node:fs, ...).
const src = new URL("../src/", import.meta.url);
const importsOf = (file: string) =>
  [...readFileSync(new URL(file, src), "utf8").matchAll(/^(?:import|export)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!);

function graph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of importsOf(entry)) if (spec.startsWith("./")) graph(spec.slice(2).replace(/\.js$/, ".ts"), seen);
  return seen;
}

describe("browser safety", () => {
  for (const entry of ["index.ts", "idb.ts"]) {
    it(`${entry} imports no Node built-ins, directly or transitively`, () => {
      const files = [...graph(entry)];
      expect(files).not.toContain("sqlite.ts");
      const external = files.flatMap(importsOf).filter((s) => !s.startsWith("./"));
      expect(external.filter((s) => s.startsWith("node:") || ["fs", "path", "os", "crypto", "child_process"].includes(s))).toEqual([]);
    });
  }
});
