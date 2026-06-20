/** The 10 coins Overkill tracks. */
export interface CoinDef {
  symbol: string;
  name: string;
}

export const COINS: CoinDef[] = [
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'ETH', name: 'Ethereum' },
  { symbol: 'XRP', name: 'XRP' },
  { symbol: 'SOL', name: 'Solana' },
  { symbol: 'DOGE', name: 'Dogecoin' },
  { symbol: 'PEPE', name: 'Pepe' },
  { symbol: 'ADA', name: 'Cardano' },
  { symbol: 'LINK', name: 'Chainlink' },
  { symbol: 'AVAX', name: 'Avalanche' },
  { symbol: 'SUI', name: 'Sui' }
];

export const COIN_SYMBOLS = COINS.map((c) => c.symbol);

/** Signal/engine constants per the Overkill spec. */
export const EMA_PERIOD = 200;
/** ±2% band around the EMA used for YELLOW early-warning entries. */
export const YELLOW_BAND_PCT = 0.02;
/** Feed considered stale after this many ms without an update. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours
