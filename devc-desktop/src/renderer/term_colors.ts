// A host terminal's colors, as the app sends them (`host-term:color`, `host-term:info`'s `color`):
// xterm.js's `theme` and `minimumContrastRatio` for View → Host Terminal Color's theme in the
// current mode (`hostTerminalOptions` in `main/policy.ts`). Replaced outright on each change, so
// no light color survives a switch to dark. See `.plans/archived/host-terminal-themes.md`.

export interface TermColors {
  theme: Record<string, string>;
  minimumContrastRatio: number;
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa`: what `terminalTheme` produces. */
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The colors in `v`, or null for anything else. */
export function termColors(v: unknown): TermColors | null {
  const o = v as { theme?: unknown; minimumContrastRatio?: unknown } | null;
  if (typeof o !== 'object' || o === null) return null;
  const ratio = o.minimumContrastRatio;
  if (typeof ratio !== 'number' || !(ratio >= 1 && ratio <= 21)) return null;
  if (typeof o.theme !== 'object' || o.theme === null) return null;
  const theme: Record<string, string> = {};
  for (const [k, c] of Object.entries(o.theme)) {
    if (typeof c !== 'string' || !COLOR.test(c)) return null;
    theme[k] = c;
  }
  return { theme, minimumContrastRatio: ratio };
}
