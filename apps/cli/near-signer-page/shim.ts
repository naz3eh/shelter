// Node globals the Meteor SDK and near-api-js expect in the browser.
// Imported first so they exist before those modules evaluate.
import { Buffer } from "buffer";

const g = globalThis as { Buffer?: typeof Buffer; process?: unknown };
g.Buffer ??= Buffer;
g.process ??= {
  env: { NODE_ENV: "production" },
  browser: true,
  version: "",
  versions: {},
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
};
