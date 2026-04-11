/**
 * ThemeToggle — light / dark / system theme switcher.
 *
 * Single button that cycles light → dark → system → light. The
 * current state is shown by an icon (sun / moon / monitor) and the
 * full preference name lives in the `title` and `aria-label`.
 *
 * Uses the `useTheme` hook from @/hooks/use-theme — see that file
 * for the persistence + system-preference resolution logic.
 *
 * Lives under `wallet/` because it sits next to `<WalletButton>` and
 * `<ConnectionStatus>` in the header. Not actually wallet-specific.
 */

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const PREFERENCE_LABEL = {
  light: "Light theme",
  dark: "Dark theme",
  system: "System theme",
} as const;

const PREFERENCE_NEXT = {
  light: "Switch to dark theme",
  dark: "Switch to system theme",
  system: "Switch to light theme",
} as const;

export interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { preference, cyclePreference } = useTheme();

  return (
    <Button
      aria-label={PREFERENCE_NEXT[preference]}
      className={cn(className)}
      onClick={cyclePreference}
      size="sm"
      title={`${PREFERENCE_LABEL[preference]} (click to cycle)`}
      variant="ghost"
    >
      {preference === "light" && <SunIcon aria-hidden="true" size={16} />}
      {preference === "dark" && <MoonIcon aria-hidden="true" size={16} />}
      {preference === "system" && <MonitorIcon aria-hidden="true" size={16} />}
    </Button>
  );
}
