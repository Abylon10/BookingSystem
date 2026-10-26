/**
 * app/src/theme.ts
 *
 * Design tokens for the Expo app: the "Travel Agency" palette plus spacing and
 * corner radii. Screens import from here instead of hard-coding values, so the
 * look can be changed in one place. See DESIGN.md §10 for usage rules.
 */

// Colours. Note: white text on `accent` is hard to read; use `ink` on it.
export const colors = {
  ink: '#12212E',       // text, dark backgrounds
  primary: '#307082',   // header, tabs, selected chips, primary buttons (white text)
  secondary: '#6CA3A2', // unselected chips, icons, badges
  sand: '#ECE7DC',      // screen background
  accent: '#EA9940',    // prices, highlights
  card: '#FFFFFF',      // card surfaces
  muted: '#5B6B75',     // secondary text
  danger: '#B4432F',    // errors, offline island
  ok: '#2F7D5B',        // success, checked in
};

// Corner radii: small controls, cards, header bottom, fully round pills.
export const radius = { sm: 10, md: 14, lg: 24, pill: 999 };

// Spacing scale used for padding, margins and gaps.
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

// Formats a number as Philippine pesos, e.g. 2800 -> "₱2,800".
export const peso = (n: number) => `₱${n.toLocaleString('en-PH')}`;
