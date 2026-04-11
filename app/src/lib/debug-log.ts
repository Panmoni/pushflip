/**
 * Dev-mode verbose logging for the transaction pipeline.
 *
 * The wallet bridge and `runAction` both go through multiple
 * stages (compile → pre-simulate → wallet-sign → tamper-check →
 * reconstruct → assert → send → confirm), and when any one stage
 * fails the user sees a single toast with one line of error
 * context. That's good for UX and terrible for debugging. This
 * module exposes `debugBridge(label, data)` which uses
 * `console.debug` under a `[wallet-bridge]` prefix — it's gated
 * by `import.meta.env.DEV` so production builds don't ship any
 * verbose logging, AND by a window-scoped runtime toggle so a
 * developer can disable it without rebuilding.
 *
 * Enable in DevTools:
 *   window.__PUSHFLIP_DEBUG__ = true   // default in dev
 *   window.__PUSHFLIP_DEBUG__ = false  // mute (still dev-only)
 *
 * Use sparingly outside the bridge — chatty logs in hot render
 * paths are worse than silence.
 */

// Define the toggle on `window` so DevTools users can see + flip it.
declare global {
  interface Window {
    __PUSHFLIP_DEBUG__?: boolean;
  }
}

/** True if verbose debug logging should be emitted. */
function isDebugEnabled(): boolean {
  // Vite replaces this at build time; prod bundles have `DEV: false`.
  if (!import.meta.env.DEV) {
    return false;
  }
  if (typeof window === "undefined") {
    return true;
  }
  // Default to enabled in dev; developer can turn off via console.
  return window.__PUSHFLIP_DEBUG__ !== false;
}

/**
 * Log a labeled step from the wallet-bridge / action pipeline.
 *
 * `data` is optional — for simple "step reached" markers, omit it.
 * For payloads, pass an object: we log it with `console.debug` so
 * DevTools can expand and inspect the full structure.
 */
export function debugBridge(label: string, data?: unknown): void {
  if (!isDebugEnabled()) {
    return;
  }
  if (data === undefined) {
    console.debug(`[wallet-bridge] ${label}`);
  } else {
    console.debug(`[wallet-bridge] ${label}`, data);
  }
}

/** Pipeline-wide logger for action hooks (runAction, simulate, etc.). */
export function debugAction(label: string, data?: unknown): void {
  if (!isDebugEnabled()) {
    return;
  }
  if (data === undefined) {
    console.debug(`[action] ${label}`);
  } else {
    console.debug(`[action] ${label}`, data);
  }
}

/**
 * Group-start helper — wrap multi-step pipelines in a collapsed
 * DevTools group so the noise is easy to scan. Returns a `close`
 * function the caller should invoke in a `finally`.
 *
 * Usage:
 *   const end = debugGroupStart("joinRound");
 *   try { ... } finally { end(); }
 */
export function debugGroupStart(label: string): () => void {
  if (!isDebugEnabled()) {
    return () => {
      /* noop */
    };
  }
  console.groupCollapsed(`[pushflip] ${label}`);
  return () => {
    console.groupEnd();
  };
}
