// ============================================================
// Runtime skin: the admin's accent colour and interface font.
//
// admin.css is compiled ahead of time, so neither can be baked into it.
// They don't have to be: every Tailwind v4 colour utility resolves a
// `var(--color-*)` token, and admin.css routes its whole accent through the
// `indigo-*` / `brand-*` scales. Redefining those tokens in one <style> the
// layout emits after the stylesheet therefore reskins every button, link,
// ring and focus state — no rebuild, no per-tenant CSS file.
//
// The scale is derived from the single saved colour with color-mix() rather
// than precomputed here, so the same declarations work whatever the admin
// picks, and the dark/light blends stay next to the canvas they blend into.
// ============================================================

import { appFontStack, DEFAULT_PRIMARY_COLOR, normalizeHexColor } from '../db/settings';

/** Canvas colours the faint accent tints blend into (see assets-source/admin.css).
 *  White doubles as the lightening end of the ramp for the `400` step. */
const DARK_CANVAS = '#0b0f17';
const LIGHT_CANVAS = '#ffffff';

/** Ink for text sitting *on* the accent (primary buttons, the avatar chip). */
const DARK_INK = '#0a0e17';
const LIGHT_INK = '#ffffff';

/**
 * WCAG relative luminance. admin.css hard-codes dark ink on the lime accent;
 * a saved colour can be anything, so the ink has to follow the colour.
 */
function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Black-ish or white ink, whichever reads better on `hex`. */
export function accentInk(hex: string): string {
  return relativeLuminance(hex) > 0.45 ? DARK_INK : LIGHT_INK;
}

/** The accent ramp for one canvas, expressed as blends of the saved colour. */
function accentScale(canvas: string, tint: { faint: number; soft: number; light: number }): string {
  const mix = (percent: number, towards: string) =>
    `color-mix(in oklab, var(--cms-primary) ${percent}%, ${towards})`;
  const ramp = [
    ['50', mix(tint.faint, canvas)],
    ['100', mix(tint.soft, canvas)],
    ['400', mix(tint.light, LIGHT_CANVAS)],
    ['500', 'var(--cms-primary)'],
    ['600', 'var(--cms-primary)'],
    ['700', mix(84, '#000000')],
    ['800', mix(70, '#000000')],
  ];
  return ramp
    .flatMap(([step, value]) => [
      `  --color-indigo-${step}: ${value};`,
      `  --color-brand-${step}: ${value};`,
    ])
    .join('\n');
}

/**
 * The stylesheet for one saved appearance. Emitted inline after
 * /assets/admin.css so these declarations win on source order at equal
 * specificity — which is why the light-theme block repeats
 * `html[data-theme="light"]` instead of relying on `:root`.
 */
export function appearanceStyleSheet(primaryColor: unknown, appFont: unknown): string {
  const primary = normalizeHexColor(primaryColor) ?? DEFAULT_PRIMARY_COLOR;
  const ink = accentInk(primary);
  const stack = appFontStack(appFont);
  return `:root {
  --cms-primary: ${primary};
  --cms-primary-ink: ${ink};
  --font-sans: ${stack};
  accent-color: var(--cms-primary);
${accentScale(DARK_CANVAS, { faint: 14, soft: 22, light: 78 })}
}
html[data-theme="light"] {
  accent-color: var(--cms-primary);
${accentScale(LIGHT_CANVAS, { faint: 10, soft: 18, light: 62 })}
}
::selection {
  background: color-mix(in srgb, var(--cms-primary) 28%, transparent);
}
.bg-indigo-600.text-white,
.bg-indigo-500,
.hover\\:bg-indigo-700:hover,
html[data-theme="light"] .bg-indigo-600.text-white,
html[data-theme="light"] .bg-indigo-500,
html[data-theme="light"] .hover\\:bg-indigo-700:hover {
  color: var(--cms-primary-ink);
}`;
}
