import type { NextConfig } from "next";
import path from "node:path";

const shim = (name: string) => path.resolve(__dirname, "lib/shims", name);

const nextConfig: NextConfig = {
  transpilePackages: ["@shelter/core", "@shelter/attest", "@shelter/connect", "@shelter/intents", "@shelter/burner", "@shelter/keys"],
  turbopack: {
    resolveAlias: {
      crypto: { browser: "./lib/shims/empty.ts" },
      "node-fetch": { browser: "./lib/shims/node-fetch.ts" },
    },
  },
  webpack: (config, { isServer }) => {
    // Workspace packages use NodeNext ".js" specifiers that point at ".ts"
    // sources; Turbopack cannot remap them, so dev/build run on webpack.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        crypto: shim("empty.ts"),
        "node-fetch": shim("node-fetch.ts"),
      };
    }
    return config;
  },
};

export default nextConfig;
