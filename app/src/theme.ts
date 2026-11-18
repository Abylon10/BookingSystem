/**
 * app/src/theme.ts
 *
 * Design tokens for the guest app: the ocean + sun palette (twine.net
 * #A8E8F9 #00537A #013C58 #F5A201 #FFBA42 #FFD35B) plus spacing and corner
 * radii. Screens import from here instead of hard-coding values.
 *
 * Contrast rules: white text on `primary`; `onLight` text on the yellows,
 * on `sky`, and on the white badges over photos. Never white text on
 * `accent`, `sun` or `sky`.
 *
 * Day / night: `colors` holds the current palette. applyTheme() swaps it and
 * rebuilds every style sheet made with themed(), then the app re-renders
 * (App.tsx keeps the theme in state and saves the choice on the phone).
 */
export type ThemeMode = 'light' | 'dark';

// Day palette.
const light = {
  ink: '#013C58',       // headings and body text
  onLight: '#013C58',   // text on light surfaces that stay light (yellow buttons, white badges)
  primary: '#00537A',   // buttons, selected chips, links (white text)
  sky: '#A8E8F9',       // light highlights, selected calendar range
  skySoft: '#E3F6FC',   // chip backgrounds, input fills
  bg: '#F3FAFD',        // screen background
  accent: '#F5A201',    // prices, "Book now" (onLight text)
  accent2: '#FFBA42',   // badges, stars
  sun: '#FFD35B',       // sun, soft highlights
  card: '#FFFFFF',      // card surfaces
  line: '#DCEBF1',      // borders, dividers
  muted: '#5E7887',     // secondary text
  danger: '#C8553D',    // errors, offline island, cancel
  ok: '#1E8A6E',        // success, online island, checked in
  offBg: '#F2F2F2',     // shaded (unavailable) rows

  // Older names still used by a few components.
  secondary: '#A8E8F9',
  sand: '#F3FAFD',
};

// Night palette: deep ocean surfaces, the same sun and sky accents.
const dark: typeof light = {
  ink: '#E3F1F6',
  onLight: '#013C58',
  primary: '#2E8DB5',
  sky: '#A8E8F9',
  skySoft: '#15394A',
  bg: '#08161E',
  accent: '#F5A201',
  accent2: '#FFBA42',
  sun: '#FFD35B',
  card: '#112532',
  line: '#21394A',
  muted: '#93A8B3',
  danger: '#E2735A',
  ok: '#3FBF94',
  offBg: '#1A2A35',
  secondary: '#A8E8F9',
  sand: '#08161E',
};

// The current palette (starts in day mode).
export const colors = { ...light };
export let themeMode: ThemeMode = 'light';

// Style sheets that follow the theme: built now, rebuilt on every switch.
const rebuilds: (() => void)[] = [];
// Usage: const st = themed(() => StyleSheet.create({ ... colors.card ... }));
export function themed<T extends object>(make: () => T): T {
  const out = {} as T;
  const build = () => Object.assign(out, make());
  build();
  rebuilds.push(build);
  return out;
}

// Switches day / night: new palette, then every themed style sheet.
export function applyTheme(mode: ThemeMode) {
  themeMode = mode;
  Object.assign(colors, mode === 'dark' ? dark : light);
  for (const build of rebuilds) build();
}

// Corner radii: small controls, cards, big sheets, fully round pills.
export const radius = { sm: 12, md: 18, lg: 28, pill: 999 };

// Spacing scale used for padding, margins and gaps.
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

// Soft drop shadow for floating cards (iOS shadow + Android elevation).
export const shadow = {
  shadowColor: '#013C58',
  shadowOpacity: 0.12,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 6 },
  elevation: 5,
};

// Formats a number as Philippine pesos, e.g. 2800 -> "₱2,800".
export const peso = (n: number) => `₱${n.toLocaleString('en-PH')}`;
