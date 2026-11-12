/**
 * app/src/theme.ts
 *
 * Design tokens for the guest app: the ocean + sun palette (twine.net
 * #A8E8F9 #00537A #013C58 #F5A201 #FFBA42 #FFD35B) plus spacing and corner
 * radii. Screens import from here instead of hard-coding values.
 *
 * Contrast rules: white text on `primary`/`ink`; `ink` text on the yellows
 * and on `sky`. Never white text on `accent`, `sun` or `sky`.
 */

// Colours.
export const colors = {
  ink: '#013C58',       // headings, dark surfaces, tab bar icons
  primary: '#00537A',   // buttons, selected chips, links (white text)
  sky: '#A8E8F9',       // light highlights, selected calendar range
  skySoft: '#E3F6FC',   // chip backgrounds, input fills
  bg: '#F3FAFD',        // screen background
  accent: '#F5A201',    // prices, "Book now" (ink text)
  accent2: '#FFBA42',   // badges, stars
  sun: '#FFD35B',       // sun, soft highlights
  card: '#FFFFFF',      // card surfaces
  line: '#DCEBF1',      // borders, dividers
  muted: '#5E7887',     // secondary text
  danger: '#C8553D',    // errors, offline island, cancel
  ok: '#1E8A6E',        // success, online island, checked in

  // Older names still used by a few components.
  secondary: '#A8E8F9',
  sand: '#F3FAFD',
};

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
