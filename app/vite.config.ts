import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `prompt` strategy: the SW activates only when the user
      // confirms via <UpdateBanner>. Avoids surprise reloads mid-game
      // and matches the existing dismissible-banner pattern
      // (<DemoStageBanner> / <ClusterHint>).
      registerType: "prompt",
      // Disable the dev-mode SW: caching during HMR turns into
      // confusing stale-asset bugs that don't reproduce in prod, and
      // we don't need offline-first behavior in dev.
      devOptions: { enabled: false },
      // Auto-injected on top of `index.html` head; vite-plugin-pwa
      // handles the <link rel="manifest"> + <link rel="apple-touch-icon">
      // wiring. We keep the existing <link rel="icon" href="/favicon.svg">
      // there because it serves the in-tab favicon ahead of SW boot.
      includeAssets: [
        "favicon.svg",
        "favicon.ico",
        "apple-touch-icon-180x180.png",
      ],
      manifest: {
        name: "PushFlip",
        short_name: "PushFlip",
        description:
          "A crypto-native push-your-luck card game on Solana. Stake, burn for power, play vs. an AI House — all with provably fair shuffling via ZK proofs.",
        // Match the dark brand spine — already set as
        // <meta name="theme-color"> in index.html so first-paint and
        // installed-shell agree.
        theme_color: "#0a0a0f",
        background_color: "#0a0a0f",
        // `standalone` removes the browser chrome on installed PWAs +
        // is what Bubblewrap reads when scaffolding the Seeker AAB.
        display: "standalone",
        // Game board is portrait-first per the Pre-Mainnet 5.0.x
        // responsive sweep (375px viewport tuned).
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        // Solana dApp Store reads its own metadata, but Bubblewrap +
        // browser PWA install both surface this category.
        categories: ["games"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-1024x1024.png",
            sizes: "1024x1024",
            type: "image/png",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Default Workbox precache covers the Vite-emitted bundle.
        // Skip the Solana RPC + dealer/faucet API surface — those
        // are stateful, and a stale cache hit would mask a 5xx or
        // serve a stale chain read. Network-only is correct here.
        navigateFallbackDenylist: [/^\/api\//],
        // Increase the precache size limit; the bundled @solana/kit
        // + wallet-adapter chunk is large enough that the default
        // 2 MB threshold drops chunks silently.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
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
