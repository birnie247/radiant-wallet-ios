import { defineConfig } from "vite";
import base from "./vite.config";

/**
 * Config for the runtime check in scripts/browser-path-check.ts.
 *
 * It inherits every alias/define from vite.config.ts (crypto, assert, ws shims
 * and `process.browser`) but forces the Radiant packages to be BUNDLED rather
 * than externalized, so the shims are genuinely exercised.
 */
export default defineConfig({
  ...base,
  ssr: {
    noExternal: true,
    target: "node",
  },
  build: {
    ssr: "scripts/browser-path-check.ts",
    outDir: "dist-test",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
  },
});
