import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app.tsx";
import "./styles/globals.css";

// Buffer polyfill, published to the global object before React mounts.
//
// Two layers cooperate to make `@solana/web3.js@1.x` work in the
// browser:
//
//   1. `vite.config.ts` aliases the bare `buffer` specifier to the
//      npm `buffer` package (a real browser polyfill), so any
//      `import { Buffer } from "buffer"` inside the Solana dep
//      chain resolves to a working module instead of Vite's
//      externalized stub.
//
//   2. A few code paths in the Solana stack reach for the global
//      `Buffer` directly (e.g. `globalThis.Buffer.from(...)`).
//      The assignment below publishes the polyfill onto the global
//      object so those paths resolve to the same instance.
//
// ESM imports above are hoisted and evaluated before any top-level
// code, but `@solana/web3.js`'s module-init access is satisfied by
// the alias in step 1, NOT by this assignment — module init runs
// during the import-resolution phase, before this line executes.
// This assignment only needs to happen before any React component
// touches Buffer at *render* time, which `createRoot(...)` below
// guarantees by its sync-then-async-render boundary.
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
