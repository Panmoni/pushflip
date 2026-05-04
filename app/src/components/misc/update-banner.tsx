/**
 * UpdateBanner — surfaces "new version available" when the service
 * worker registered by `vite-plugin-pwa` detects a deploy newer than
 * the one currently running in this tab.
 *
 * **Why this exists**: with `registerType: "prompt"` (see
 * `vite.config.ts`), Workbox installs the new SW in the background but
 * waits for an explicit `skipWaiting()` before activating. That keeps
 * users from getting a surprise reload mid-game when tucker pushes a
 * new build, but it ALSO means the user is silently running stale code
 * until they manually reload. This banner closes the loop: the user
 * sees "Update available" and can opt-in with one click.
 *
 * Pairs with the existing dismissible-banner pattern
 * (<DemoStageBanner>, <ClusterHint>). Distinct emerald palette so the
 * three banners are visually distinguishable when stacked:
 *   - slate (info, deploy stage),
 *   - amber (warning, cluster mismatch),
 *   - emerald (action available, fresh build).
 *
 * The banner only renders when an update is actually pending — there
 * is no dismissed-flag persistence. Closing the X dismisses for THIS
 * pending update only; if a newer build arrives later, the banner
 * reappears. (Persisting dismissal would mean a user who clicks X
 * never updates, which is the wrong default for a crypto app where
 * stale code can mean wrong tx semantics.)
 */

import { useRegisterSW } from "virtual:pwa-register/react";
import { RotateCwIcon, XIcon } from "lucide-react";
import { useCallback } from "react";

import { cn } from "@/lib/utils";

export interface UpdateBannerProps {
  className?: string;
}

export function UpdateBanner({ className }: UpdateBannerProps) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // SW registration failures are non-fatal — the app still works,
      // just without offline support or update detection. Log so we
      // can spot it in dev tools without leaking to user-facing UI.
      console.warn("[pwa] service worker registration failed", error);
    },
  });

  const handleUpdate = useCallback(() => {
    // `true` triggers the SW's `skipWaiting()` + `clients.claim()` and
    // reloads the page once the new SW is active. The reload is
    // unavoidable here — we need a fresh module graph since the bundle
    // hash has changed. Workbox's promise resolves AFTER navigation,
    // so awaiting it inside an event handler just defers a tear-down
    // we can't observe; fire-and-forget is the documented pattern.
    updateServiceWorker(true).catch((error: unknown) => {
      console.warn("[pwa] update failed", error);
    });
  }, [updateServiceWorker]);

  const handleDismiss = useCallback(() => {
    setNeedRefresh(false);
  }, [setNeedRefresh]);

  if (!needRefresh) {
    return null;
  }

  return (
    <div
      aria-label="Update available"
      className={cn(
        "border-emerald-400/60 border-b bg-emerald-100/70 px-4 py-2 text-emerald-950 text-sm dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-100",
        className
      )}
      role="status"
    >
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <RotateCwIcon
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300"
          size={16}
        />
        <p className="min-w-0 flex-1 leading-relaxed">
          <span className="font-semibold">Update available.</span> A new version
          of pushflip is ready.{" "}
          <button
            className="font-medium underline underline-offset-2 hover:text-emerald-700 dark:hover:text-emerald-50"
            onClick={handleUpdate}
            type="button"
          >
            Reload now
          </button>
        </p>
        <button
          aria-label="Dismiss update notice"
          className="shrink-0 rounded p-1 text-emerald-700 hover:bg-emerald-200/50 dark:text-emerald-200 dark:hover:bg-emerald-400/10"
          onClick={handleDismiss}
          type="button"
        >
          <XIcon aria-hidden="true" size={14} />
        </button>
      </div>
    </div>
  );
}
