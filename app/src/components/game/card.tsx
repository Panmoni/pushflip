/**
 * GameCard — pure presentational component for a single playing card.
 *
 * Renders one of three card-type variants from the on-chain Card data
 * model (alpha / protocol / multiplier) with a face-down state and an
 * optional animation flag for the parent to drive (currently CSS-only,
 * Framer Motion lands in Task 3.7.2).
 *
 * No hooks, no on-chain integration. The component is intentionally
 * dumb so it can be storybook'd, snapshot-tested, and rendered against
 * arbitrary fixture data without spinning up a wallet or RPC.
 *
 * Card data semantics (mirrors program/src/state/card.rs +
 * program/src/utils/deck.rs — kept in sync via @pushflip/client):
 *
 *   alpha (52 cards):     value 1-13 (rank), suit 0-3 (♠♥♦♣)
 *   protocol (30 cards):  value 0=RugPull / 1=Airdrop / 2=VampireAttack
 *   multiplier (12 cards): value 2 / 3 / 5 (the multiplier amount)
 *
 * Spec: docs/EXECUTION_PLAN.md Task 3.3.1.
 */

import { type Card, CardType } from "@pushflip/client";

import { cn } from "@/lib/utils";

// --- Visual constants ----------------------------------------------------

const SUIT_GLYPHS = ["♠", "♥", "♦", "♣"] as const;

const ALPHA_RANKS = [
  // index 0 unused — alpha values are 1-13
  "",
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
] as const;

const PROTOCOL_NAMES = ["Rug Pull", "Airdrop", "Vampire"] as const;
const PROTOCOL_ICONS = ["💀", "🪂", "🦇"] as const;

// --- Helpers -------------------------------------------------------------

/** Display string for the rank/value glyph in the corner of the card. */
function cornerGlyph(card: Card): string {
  switch (card.cardType) {
    case CardType.Alpha:
      return ALPHA_RANKS[card.value] ?? "?";
    case CardType.Protocol:
      return PROTOCOL_ICONS[card.value] ?? "?";
    case CardType.Multiplier:
      return `×${card.value}`;
    default:
      return "?";
  }
}

/** Display string for the center of the card. */
function centerGlyph(card: Card): string {
  switch (card.cardType) {
    case CardType.Alpha:
      return SUIT_GLYPHS[card.suit] ?? "?";
    case CardType.Protocol:
      return PROTOCOL_ICONS[card.value] ?? "?";
    case CardType.Multiplier:
      return `×${card.value}`;
    default:
      return "?";
  }
}

/** Accessible label for screen readers + the title attribute. */
function accessibleLabel(card: Card, faceDown: boolean): string {
  if (faceDown) {
    return "Face-down card";
  }
  switch (card.cardType) {
    case CardType.Alpha: {
      const rank = ALPHA_RANKS[card.value] ?? `?(${card.value})`;
      const suit = ["Spades", "Hearts", "Diamonds", "Clubs"][card.suit] ?? "?";
      return `${rank} of ${suit}`;
    }
    case CardType.Protocol:
      return `Protocol card: ${PROTOCOL_NAMES[card.value] ?? "Unknown"}`;
    case CardType.Multiplier:
      return `Multiplier card: ×${card.value}`;
    default:
      return "Unknown card";
  }
}

// --- Style variants ------------------------------------------------------

/**
 * Style maps for each card type. Inlined here (not as `cva` variants)
 * because each variant needs three coordinated colors (border, gradient,
 * accent) and a paragraph of Tailwind for each — `cva` would be heavier
 * than necessary for three exhaustive cases.
 */
const TYPE_STYLES: Record<
  CardType,
  { border: string; bg: string; accent: string }
> = {
  [CardType.Alpha]: {
    border: "border-blue-400/60",
    bg: "bg-gradient-to-br from-blue-950/90 via-slate-900 to-blue-950/80",
    accent: "text-blue-200",
  },
  [CardType.Protocol]: {
    border: "border-red-400/70",
    bg: "bg-gradient-to-br from-red-950/90 via-slate-900 to-red-950/80",
    accent: "text-red-200",
  },
  [CardType.Multiplier]: {
    border: "border-amber-400/70",
    bg: "bg-gradient-to-br from-amber-950/90 via-slate-900 to-amber-950/80",
    accent: "text-amber-200",
  },
};

const ALPHA_RED_SUIT = (suit: number) => suit === 1 || suit === 2;

// --- Component -----------------------------------------------------------

export interface GameCardProps {
  /**
   * If true, apply a brief draw-in animation when the card mounts.
   * Currently a simple Tailwind transition; Framer Motion integration
   * lands in Task 3.7.2 — consumers can pass this flag eagerly.
   */
  animate?: boolean;
  /** The card data (typically from PlayerState.hand). */
  card: Card;
  /** Extra classes for the wrapper. Use sparingly. */
  className?: string;
  /**
   * If true, render the card back instead of the face. Used for
   * opponents' hidden cards or cards in the deck before reveal.
   */
  faceDown?: boolean;
}

/**
 * A single playing card. Three visual variants (alpha/protocol/multiplier)
 * plus a face-down state. Pure presentational — no hooks, no on-chain
 * integration, safe to render with any fixture data.
 */
export function GameCard({
  card,
  faceDown = false,
  animate = false,
  className,
}: GameCardProps) {
  const label = accessibleLabel(card, faceDown);

  if (faceDown) {
    return (
      <div
        aria-label={label}
        className={cn(
          // Layout: same dimensions as a face-up card
          "relative flex h-32 w-24 select-none items-center justify-center",
          "rounded-lg border-2 border-purple-500/50",
          // Card-back gradient: purple/indigo crosshatch
          "bg-gradient-to-br from-purple-950 via-indigo-950 to-purple-950",
          "shadow-md shadow-purple-950/50",
          // Subtle inner pattern using a repeating linear gradient overlay
          "bg-[image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(168,85,247,0.1)_4px,rgba(168,85,247,0.1)_8px)] bg-[length:8px_8px]",
          animate && "fade-in zoom-in animate-in duration-300",
          className
        )}
        role="img"
        title={label}
      >
        <span
          aria-hidden="true"
          className="font-bold text-3xl text-purple-300/80"
        >
          ?
        </span>
      </div>
    );
  }

  const styles = TYPE_STYLES[card.cardType];
  const corner = cornerGlyph(card);
  const center = centerGlyph(card);

  // For alpha cards: hearts (suit 1) and diamonds (suit 2) render red,
  // spades (0) and clubs (3) render in the type accent color (blue here).
  const isAlphaRed =
    card.cardType === CardType.Alpha && ALPHA_RED_SUIT(card.suit);
  const centerColor = isAlphaRed ? "text-red-400" : styles.accent;
  const cornerColor = isAlphaRed ? "text-red-300" : styles.accent;

  return (
    <div
      aria-label={label}
      className={cn(
        "relative flex h-32 w-24 select-none flex-col rounded-lg border-2 p-2 shadow-md",
        styles.border,
        styles.bg,
        animate && "fade-in zoom-in animate-in duration-300",
        className
      )}
      role="img"
      title={label}
    >
      {/* Top-left corner: rank/value glyph */}
      <div
        className={cn(
          "self-start font-bold text-sm tabular-nums leading-none",
          cornerColor
        )}
      >
        {corner}
      </div>

      {/* Center: large suit/icon glyph */}
      <div
        aria-hidden="true"
        className={cn(
          "flex flex-1 items-center justify-center font-bold text-4xl leading-none",
          centerColor
        )}
      >
        {center}
      </div>

      {/* Bottom-right corner: rank/value glyph rotated 180° (mirrors a real card) */}
      <div
        className={cn(
          "rotate-180 self-end font-bold text-sm tabular-nums leading-none",
          cornerColor
        )}
      >
        {corner}
      </div>
    </div>
  );
}
