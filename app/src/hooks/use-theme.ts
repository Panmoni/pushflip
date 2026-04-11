/**
 * `useTheme` — light/dark theme switcher with localStorage persistence
 * and a `system` fallback that follows the OS preference.
 *
 * Three states:
 *   - "light"  — force light theme
 *   - "dark"   — force dark theme
 *   - "system" — follow `prefers-color-scheme`
 *
 * The hook applies the resolved theme to `document.documentElement`
 * by toggling the `dark` class. This integrates with Tailwind v4's
 * `@custom-variant dark (&:is(.dark *))` setup in globals.css and
 * with shadcn's `:root` / `.dark` token blocks.
 *
 * The default theme is `system`. The user's choice persists in
 * `localStorage` under the `pushflip:theme` key. SSR-safe.
 *
 * **Architecture: useSyncExternalStore**
 *
 * The theme lives in a module-scoped store — not React state — so that
 * `<App>` and `<ThemeToggle>` (and any other future caller) all read the
 * same value and re-render in lockstep. An earlier version of this hook
 * used `useState` initialized from localStorage, which worked when the
 * hook was mounted in exactly one place but desynced when `<App>` called
 * it for side-effects AND `<ThemeToggle>` called it for the current value:
 * two independent `useState` instances, one localStorage source, no
 * shared signal → clicking the toggle moved the DOM class but not the
 * icon. `useSyncExternalStore` fixes this by letting React subscribe to
 * the one imperative store, guaranteeing concurrent-mode tearing safety.
 *
 * Storage-key + string values must stay in sync with the FOUC-prevention
 * IIFE in `app/index.html`.
 */

import { useCallback, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * localStorage key for the persisted theme preference.
 *
 * **Cross-reference**: the FOUC-prevention IIFE in `app/index.html`
 * hardcodes this same key so the DOM is correct on the first paint
 * before React mounts. If you change it here, change it there too.
 */
const STORAGE_KEY = "pushflip:theme";

/** Read the saved preference from localStorage, defaulting to "system". */
function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") {
      return raw;
    }
  } catch {
    // localStorage may be disabled (private browsing); fall through.
  }
  return "system";
}

/** Resolve a preference to the actual light/dark value to apply right now. */
function resolvePreference(pref: ThemePreference): ResolvedTheme {
  if (pref === "light" || pref === "dark") {
    return pref;
  }
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply the resolved theme to `document.documentElement` by toggling `.dark`. */
function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const html = document.documentElement;
  if (resolved === "dark") {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

// --- Module-scoped store -------------------------------------------------
//
// Single source of truth. All callers of `useTheme()` subscribe to these
// variables via `useSyncExternalStore`, so updates from any one call site
// propagate to every mounted `<ThemeToggle>` / `<App>` / etc. in one pass.

let currentPreference: ThemePreference = readStoredPreference();
let currentResolved: ResolvedTheme = resolvePreference(currentPreference);

// Apply the resolved theme to the DOM immediately at module load so the
// initial DOM state matches what subscribers will read. The FOUC-prevention
// IIFE in `index.html` already did this before React booted — this call is
// the post-hydration reconciliation.
applyTheme(currentResolved);

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    l();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// When the preference is `system`, we also need to react to OS-level
// preference changes. The listener lives at module scope so exactly ONE
// MediaQueryList subscription exists for the whole app (not one per
// component that calls `useTheme`), and it reads the latest preference
// each time it fires rather than closing over a stale snapshot.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", (e) => {
    if (currentPreference !== "system") {
      return;
    }
    const next: ResolvedTheme = e.matches ? "dark" : "light";
    if (next !== currentResolved) {
      currentResolved = next;
      applyTheme(next);
      emit();
    }
  });
}

function getPreference(): ThemePreference {
  return currentPreference;
}

function getResolved(): ResolvedTheme {
  return currentResolved;
}

/** Server snapshot for SSR — never called in CSR but required by the API. */
function getServerSnapshot(): ThemePreference {
  return "system";
}

function setStoredPreference(next: ThemePreference): void {
  if (next === currentPreference) {
    // Even a no-op click should NOT emit — avoids wasteful re-renders.
    return;
  }
  currentPreference = next;
  currentResolved = resolvePreference(next);
  applyTheme(currentResolved);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be disabled; preference stays in-memory only.
    }
  }
  emit();
}

interface UseThemeResult {
  /** Convenience: cycle light → dark → system → light. */
  cyclePreference: () => void;
  /** The user's stored preference (`light` / `dark` / `system`). */
  preference: ThemePreference;
  /** The actually-applied theme (`light` / `dark`), after resolving `system`. */
  resolved: ResolvedTheme;
  /** Set the preference. Persists to localStorage and updates the DOM. */
  setPreference: (next: ThemePreference) => void;
}

/**
 * The single theme-management hook for the app. Can be called from ANY
 * component — all subscribers share the same module-scoped store via
 * `useSyncExternalStore`, so `<App>` and `<ThemeToggle>` stay in sync
 * automatically. No React context needed.
 */
export function useTheme(): UseThemeResult {
  const preference = useSyncExternalStore(
    subscribe,
    getPreference,
    getServerSnapshot
  );
  const resolved = useSyncExternalStore(
    subscribe,
    getResolved,
    // On the server, fall back to "dark" (brand-aligned default).
    () => "dark" as const
  );

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
  }, []);

  const cyclePreference = useCallback(() => {
    let next: ThemePreference;
    if (currentPreference === "light") {
      next = "dark";
    } else if (currentPreference === "dark") {
      next = "system";
    } else {
      next = "light";
    }
    setStoredPreference(next);
  }, []);

  return { preference, resolved, setPreference, cyclePreference };
}
