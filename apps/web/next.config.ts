import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@shelter/core", "@shelter/attest"],
  // @phala/dcap-qvl is isomorphic; its node-only requires need browser stubs.
  turbopack: {
    resolveAlias: {
      crypto: { browser: "./lib/shims/empty.ts" },
      "node-fetch": { browser: "./lib/shims/node-fetch.ts" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        "node-fetch": false,
      };
    }
    return config;
  },
};

export default nextConfig;
