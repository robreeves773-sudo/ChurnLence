// Foreground orchestration hook: runs evaluate() on mount and every 60s,
// exposes live state to the UI, and persists settings. Caches daily candles in
// memory (refetched once per UTC day so the daily-close confirmation picks up
// the new completed candle); refreshes the live price each tick.

import { useCallback, useEffect, useRef, useState } from 'react';
import { evaluate } from '../core/orchestrator';
import { loadSettings, saveSettings } from '../core/settings';
import type { AlertEvent, Candle, CoinState, RegimeState, Settings } from '../core/types';
import { COINS, COIN_IDS } from '../data/coins';
import { fetchDailyCloses, fetchLivePrice } from '../data/coingecko';
import { appDeliver } from '../delivery';
import { ensureNotificationPermission } from '../delivery/localNotif';
import { publishToNtfy } from '../delivery/ntfy';
import { showLocalNotification } from '../delivery/localNotif';
import { getRandomBytes, preferencesKv } from '../platform/preferencesKv';

const TICK_MS = 60_000;

export interface OverkillApi {
  ready: boolean;
  states: CoinState[];
  regime: RegimeState;
  settings: Settings | null;
  lastFired: AlertEvent[];
  updateSettings: (next: Settings) => Promise<void>;
  sendTestAlert: () => Promise<void>;
}

export function useOverkill(): OverkillApi {
  const [ready, setReady] = useState(false);
  const [states, setStates] = useState<CoinState[]>([]);
  const [regime, setRegime] = useState<RegimeState>('Mixed');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lastFired, setLastFired] = useState<AlertEvent[]>([]);

  const candleCache = useRef<Map<string, { date: string; candles: Candle[] }>>(new Map());
  const settingsRef = useRef<Settings | null>(null);

  const fetchCandlesCached = useCallback(async (coingeckoId: string): Promise<Candle[]> => {
    const today = new Date().toISOString().slice(0, 10);
    const cached = candleCache.current.get(coingeckoId);
    if (cached && cached.date === today) return cached.candles;
    const candles = await fetchDailyCloses(coingeckoId);
    candleCache.current.set(coingeckoId, { date: today, candles });
    return candles;
  }, []);

  const runTick = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    try {
      const result = await evaluate(
        {
          fetchCandles: (coin) => fetchCandlesCached(coin.coingeckoId),
          fetchLivePrice: (coin) => fetchLivePrice(coin.coingeckoId).catch(() => null),
          kv: preferencesKv,
          deliver: appDeliver,
          now: () => Date.now(),
        },
        COINS,
        s,
        'foreground',
      );
      setStates(result.states);
      setRegime(result.regime);
      if (result.fired.length) setLastFired(result.fired);
    } catch (e) {
      console.error('evaluate failed', e);
    }
  }, [fetchCandlesCached]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const loaded = await loadSettings(preferencesKv, COIN_IDS, getRandomBytes);
      settingsRef.current = loaded;
      setSettings(loaded);
      await ensureNotificationPermission().catch(() => false);
      await runTick();
      setReady(true);
      interval = setInterval(runTick, TICK_MS);
    })();
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [runTick]);

  const updateSettings = useCallback(async (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
    await saveSettings(preferencesKv, next);
  }, []);

  const sendTestAlert = useCallback(async () => {
    const s = settingsRef.current;
    if (!s) return;
    const alert: AlertEvent = {
      type: 'FLIP',
      dedupeKey: `test:${Date.now()}`,
      title: 'BUY SIGNAL: TEST',
      body: 'This is a test alert from Overkill. ntfy + local notification both fired.',
      priority: 'high',
      overridesQuietHours: true,
    };
    // Bypass dedupe/quiet-hours: deliver directly via both paths.
    await Promise.allSettled([
      publishToNtfy(s.ntfyTopic, alert),
      showLocalNotification(alert),
    ]);
    setLastFired([alert]);
  }, []);

  return { ready, states, regime, settings, lastFired, updateSettings, sendTestAlert };
}
