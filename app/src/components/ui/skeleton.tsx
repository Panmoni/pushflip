/**
 * Skeleton — animated placeholder block for loading states.
 *
 * Mirrors shadcn's `Skeleton` primitive: a div with a muted
 * background and a subtle pulse animation. Theme-aware out of
 * the box because it uses the `bg-muted` token from the design
 * system rather than a hardcoded gray.
 *
 * Use this everywhere you want to indicate "data is loading"
 * without rendering the prose-text "Loading…" string. Skeletons
 * are better UX because:
 *   - They preserve layout (no jank when the real content lands).
 *   - They convey shape and density at a glance.
 *   - They feel faster than a spinner because the user's eye
 *     latches onto the geometry while waiting.
 *
 * Sizing: pass `className` with explicit width/height utilities
 * (`h-4 w-32`, etc.) — there is no default size.
 */

import { cn } from "@/lib/utils";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
