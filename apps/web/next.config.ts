import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages export TypeScript source with `.js` extensions on
  // intra-package imports (NodeNext ESM style). Next needs both:
  //  - `transpilePackages` so it actually transpiles their sources
  //  - `extensionAlias` so webpack resolves `./foo.js` → `./foo.ts`
  // Add new @ga/* packages to the transpile list as they come online.
  transpilePackages: [
    "@ga/accounts",
    "@ga/aircraft",
    "@ga/db",
    "@ga/regime",
    "@ga/storage",
  ],
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
