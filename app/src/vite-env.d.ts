/// <reference types="vite/client" />

/**
 * Augment Vite's `ImportMetaEnv` so that `VITE_*` env-var typos are caught at
 * compile time. Without this declaration, Vite's default ambient interface
 * extends `Record<string, any>` and any `import.meta.env.VITE_*` access type-
 * checks as `any`.
 *
 * Add new entries here when introducing new build-time env vars.
 */
interface ImportMetaEnv {
  /** Override RPC HTTP endpoint. Defaults to public devnet. */
  readonly VITE_RPC_ENDPOINT?: string;
  /** Override RPC WebSocket endpoint. Defaults to derived from VITE_RPC_ENDPOINT. */
  readonly VITE_RPC_WS_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
