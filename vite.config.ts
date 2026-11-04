import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  define: {
    // radiantjs/lib/crypto/random.js branches on `process.browser` to choose
    // Web Crypto (getRandomValues) over Node's crypto.randomBytes. Without this
    // the browser build would take the Node path and fail. Replacing the
    // expression textually also avoids a "process is not defined" ReferenceError.
    "process.browser": "true",
  },
  resolve: {
    alias: {
      // @radiant-core/sdk lazily imports `ws` ONLY as a Node fallback, after it
      // has already checked for a global WebSocket. Inside the Android WebView
      // the global always exists, so `ws` must never be pulled into the bundle
      // (it requires node:net/node:tls and would break the browser build).
      ws: fileURLToPath(new URL("./src/shims/ws.ts", import.meta.url)),
      // Node's hashing/RNG module is not available in a WebView; radiantjs
      // feature-detects it and needs a stub that makes the detection fail
      // cleanly so its pure-JS + Web Crypto paths are used instead.
      crypto: fileURLToPath(new URL("./src/shims/crypto.ts", import.meta.url)),
      // Node's `assert` is called on the transaction-serialisation path
      // (bufferwriter.js) and the HD-key path. An empty externalized module
      // would throw exactly while signing, so it needs a real callable
      // implementation — hence a .cjs shim (module.exports = fn).
      assert: fileURLToPath(new URL("./src/shims/assert.cjs", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
});
