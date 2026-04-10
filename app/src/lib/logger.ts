/**
 * Tiny dev-only logger.
 *
 * Centralizes the single Biome `noConsole` exception we need so that hooks
 * with WebSocket subscription failures (or other dev-only debug breadcrumbs)
 * have a place to write to the console without sprinkling biome-ignore
 * directives across the codebase.
 *
 * Production builds collapse these to no-ops via the `import.meta.env.DEV`
 * guard, which Vite tree-shakes statically.
 */

export function logError(scope: string, error: unknown): void {
  if (import.meta.env.DEV) {
    console.error(`[${scope}]`, error);
  }
}
