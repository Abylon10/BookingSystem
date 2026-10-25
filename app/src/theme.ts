// "Travel Agency" palette. See DESIGN.md §10 for where each colour goes.
export const colors = {
  ink: '#12212E',       // text, dark backgrounds
  primary: '#307082',   // header, tabs, selected chips, primary buttons (white text)
  secondary: '#6CA3A2', // unselected chips, icons, badges
  sand: '#ECE7DC',      // screen background
  accent: '#EA9940',    // prices, highlights — put ink text on it, not white
  card: '#FFFFFF',
  muted: '#5B6B75',
  danger: '#B4432F',
  ok: '#2F7D5B',
};

export const radius = { sm: 10, md: 14, lg: 24, pill: 999 };
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };

export const peso = (n: number) => `₱${n.toLocaleString('en-PH')}`;
