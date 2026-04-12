import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // `@solana/web3.js@1.x`'s browser ESM bundle does
      // `import { Buffer } from "buffer"` at module top level. Vite
      // externalizes the bare `buffer` specifier (and `node:buffer`)
      // for browser builds because it's a Node core module — at
      // runtime that resolves to a stub object that throws on any
      // property access. The npm `buffer` package is a real
      // browser-compatible polyfill of Node's Buffer; aliasing
      // `buffer` to it eliminates the externalization warning AND
      // means downstream code that calls `Buffer.from(...)` /
      // `Buffer.alloc(...)` actually works.
      //
      // Cheaper than `vite-plugin-node-polyfills` (which would
      // polyfill the entire Node stdlib) — Solana's chain on the
      // browser side only needs `buffer`, and a couple call sites
      // touch `process.env` which Vite already shims via
      // `import.meta.env`.
      buffer: "buffer",
    },
  },
  optimizeDeps: {
    // Pre-bundle the buffer polyfill so it ends up in the same
    // optimization graph as the wallet adapter / web3.js modules
    // that depend on it.
    include: ["buffer"],
  },
});
