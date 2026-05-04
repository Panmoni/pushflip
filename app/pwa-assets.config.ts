import {
  defineConfig,
  minimal2023Preset as preset,
} from "@vite-pwa/assets-generator/config";

// PWA icon set generated from `public/favicon.svg`.
//
// `minimal-2023` preset produces the canonical set required for both
// browser PWA install + the Solana Seeker / dApp Store TWA path:
//   - public/pwa-64x64.png        (legacy/maskable fallback)
//   - public/pwa-192x192.png      (manifest standard)
//   - public/pwa-512x512.png      (manifest standard + Bubblewrap source)
//   - public/maskable-icon-512x512.png  (Android adaptive)
//   - public/apple-touch-icon-180x180.png  (iOS home-screen)
//   - public/favicon.ico           (legacy)
//
// The 1024×1024 source asset that the Solana dApp Store listing
// expects (per docs/GO_TO_SEEKER.md Phase 4) gets generated separately
// in `transparent.sizes` below.
//
// Run with: `pnpm --filter @pushflip/app run pwa-assets`
export default defineConfig({
  preset: {
    ...preset,
    transparent: {
      ...preset.transparent,
      // Add the dApp Store source asset alongside the standard set.
      sizes: [...preset.transparent.sizes, 1024],
    },
  },
  images: ["public/favicon.svg"],
});
