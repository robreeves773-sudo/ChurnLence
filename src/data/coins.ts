// The 10 tracked coins. Edit this single list to change the watchlist.
// `coingeckoId` is the CoinGecko API id; `decimals` controls price display
// precision (PEPE needs many to avoid rounding to $0.00).

import type { Coin } from '../core/types';

export const COINS: Coin[] = [
  { id: 'btc', symbol: 'BTC', coingeckoId: 'bitcoin', displayName: 'Bitcoin', decimals: 0 },
  { id: 'eth', symbol: 'ETH', coingeckoId: 'ethereum', displayName: 'Ethereum', decimals: 2 },
  { id: 'sol', symbol: 'SOL', coingeckoId: 'solana', displayName: 'Solana', decimals: 2 },
  { id: 'xrp', symbol: 'XRP', coingeckoId: 'ripple', displayName: 'XRP', decimals: 4 },
  { id: 'bnb', symbol: 'BNB', coingeckoId: 'binancecoin', displayName: 'BNB', decimals: 2 },
  { id: 'doge', symbol: 'DOGE', coingeckoId: 'dogecoin', displayName: 'Dogecoin', decimals: 5 },
  { id: 'pepe', symbol: 'PEPE', coingeckoId: 'pepe', displayName: 'Pepe', decimals: 9 },
  { id: 'ada', symbol: 'ADA', coingeckoId: 'cardano', displayName: 'Cardano', decimals: 4 },
  { id: 'avax', symbol: 'AVAX', coingeckoId: 'avalanche-2', displayName: 'Avalanche', decimals: 2 },
  { id: 'link', symbol: 'LINK', coingeckoId: 'chainlink', displayName: 'Chainlink', decimals: 3 },
];

export const COIN_IDS = COINS.map((c) => c.id);
