// Centralized theme tokens — ZBCN/Zebec-inspired dark crypto palette.
// Re-skin the whole app by editing these (mirrored in variables.css).

export const COLORS = {
  bg: '#0A0B0D',
  surface: '#15181E',
  border: '#222733',
  primary: '#C6F432', // neon lime-green (ZBCN signature)
  secondary: '#22D3EE', // cyan
  bullish: '#16C784', // GREEN
  bearish: '#EA3943', // RED
  yellow: '#F5A623', // YELLOW zone / amber
  text: '#E6E9EF',
  muted: '#8A93A3',
} as const;

export const ZONE_COLOR = {
  GREEN: COLORS.bullish,
  YELLOW: COLORS.yellow,
  RED: COLORS.bearish,
} as const;

export const REGIME_COLOR = {
  Defensive: COLORS.bearish,
  Mixed: COLORS.yellow,
  Constructive: COLORS.primary,
} as const;
