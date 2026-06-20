import { preferencesStore } from './platform/capacitor/preferencesStore';
import { createCapacitorNotifier, ensureNotificationSetup } from './platform/capacitor/capacitorNotifier';
import { fetchAllFeeds } from './platform/capacitor/marketData';
import { loadSettings, saveSettings } from './core/settingsRepo';
import { runEvaluation, type EvaluationRun } from './core/orchestrator';
import { EMA_PERIOD } from './core/coins';
import type { Settings } from './core/settings';
import type { CoinFeed } from './core/types';
import { renderSettings } from './ui/settingsScreen';
import { renderChart, type ChartDot } from './ui/chart';
import { startScheduler } from './scheduler/evaluator';

let settings: Settings;
let feeds: CoinFeed[] = [];
let lastRun: EvaluationRun | null = null;
let selectedCoin = 'BTC';

async function bootstrap(): Promise<void> {
  await ensureNotificationSetup();
  settings = await loadSettings(preferencesStore);
  const notifier = createCapacitorNotifier(() => settings);

  const runOnce = async (mode: 'close' | 'intraday'): Promise<void> => {
    feeds = await fetchAllFeeds();
    lastRun = await runEvaluation({ mode, feeds, settings, store: preferencesStore, notifier });
    paint();
  };

  // Settings screen.
  const settingsRoot = document.getElementById('settings');
  if (settingsRoot) {
    renderSettings(settingsRoot, settings, {
      notifier,
      onChange: async (next) => {
        settings = next;
        await saveSettings(preferencesStore, settings);
      }
    });
  }

  startScheduler(runOnce);
}

function paint(): void {
  if (!lastRun) return;

  // Regime banner.
  const banner = document.getElementById('regime');
  if (banner) {
    banner.textContent = `Regime: ${lastRun.regime}`;
    banner.className = `regime ${lastRun.regime.toLowerCase()}`;
  }

  // Chart for the selected coin.
  const canvas = document.getElementById('chart') as HTMLCanvasElement | null;
  const feed = feeds.find((f) => f.symbol === selectedCoin);
  const view = lastRun.views.find((v) => v.symbol === selectedCoin);
  if (canvas && feed && feed.candles.length) {
    const dots: ChartDot[] = [];
    const lastIdx = feed.candles.length - 1;
    if (view?.confirmedSide) {
      dots.push({ index: lastIdx, kind: view.confirmedSide === 'above' ? 'confirmed-buy' : 'confirmed-sell' });
    }
    if (view?.pendingFlip) {
      dots.push({ index: lastIdx, kind: 'pending' }); // hollow dot
    }
    renderChart(canvas, feed.candles, EMA_PERIOD, dots);
  }
}

document.addEventListener('DOMContentLoaded', () => void bootstrap());
