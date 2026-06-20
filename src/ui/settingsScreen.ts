import type { Settings, CoinAlertMode } from '../core/settings';
import { COINS } from '../core/coins';
import type { Notifier } from '../core/ports';

export interface SettingsScreenHandlers {
  onChange: (next: Settings) => void | Promise<void>;
  notifier: Notifier;
}

/** Build the settings screen DOM into `root`. */
export function renderSettings(root: HTMLElement, settings: Settings, h: SettingsScreenHandlers): void {
  root.innerHTML = '';
  const s: Settings = structuredClone(settings);

  const section = (title: string): HTMLElement => {
    const el = document.createElement('section');
    const head = document.createElement('h2');
    head.textContent = title;
    el.appendChild(head);
    root.appendChild(el);
    return el;
  };

  // --- ntfy topic + test alert -------------------------------------------
  const ntfy = section('Notifications (ntfy.sh)');
  const topic = document.createElement('p');
  topic.className = 'topic';
  topic.innerHTML = `Subscribe in the ntfy app to:<br><code>${s.ntfyTopic}</code>`;
  ntfy.appendChild(topic);

  const testBtn = document.createElement('button');
  testBtn.textContent = 'Send test alert';
  testBtn.onclick = () =>
    h.notifier.notify({
      type: 'flip',
      coin: 'TEST',
      direction: 'buy',
      date: new Date().toISOString().slice(0, 10),
      title: 'TEST ALERT: Overkill',
      body: 'If you can see this, ntfy + local notifications are working.',
      priority: 'high',
      dedupeKey: `test:${Date.now()}`
    });
  ntfy.appendChild(testBtn);

  // --- per-coin alert toggles --------------------------------------------
  const coinsSec = section('Per-coin alerts');
  for (const coin of COINS) {
    const row = document.createElement('div');
    row.className = 'coin-row';
    const label = document.createElement('span');
    label.textContent = `${coin.symbol}`;
    row.appendChild(label);

    const select = document.createElement('select');
    (['yellow', 'flip', 'off'] as CoinAlertMode[]).forEach((mode) => {
      const opt = document.createElement('option');
      opt.value = mode;
      opt.textContent =
        mode === 'yellow' ? 'Flip + Yellow' : mode === 'flip' ? 'Flip only' : 'Off';
      if ((s.perCoin[coin.symbol] ?? 'yellow') === mode) opt.selected = true;
      select.appendChild(opt);
    });
    select.onchange = () => {
      s.perCoin[coin.symbol] = select.value as CoinAlertMode;
      h.onChange(structuredClone(s));
    };
    row.appendChild(select);
    coinsSec.appendChild(row);
  }

  // --- quiet hours --------------------------------------------------------
  const quiet = section('Quiet hours');
  const qNote = document.createElement('p');
  qNote.className = 'note';
  qNote.textContent = 'Suppresses alerts except signal flips, which always override.';
  quiet.appendChild(qNote);

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = s.quietHours.enabled;
  const enabledLabel = document.createElement('label');
  enabledLabel.append(enabled, document.createTextNode(' Enabled'));
  quiet.appendChild(enabledLabel);

  const start = document.createElement('input');
  start.type = 'time';
  start.value = s.quietHours.start;
  const end = document.createElement('input');
  end.type = 'time';
  end.value = s.quietHours.end;

  const applyQuiet = () => {
    s.quietHours = { enabled: enabled.checked, start: start.value, end: end.value };
    h.onChange(structuredClone(s));
  };
  enabled.onchange = start.onchange = end.onchange = applyQuiet;

  const range = document.createElement('div');
  range.className = 'quiet-range';
  range.append(document.createTextNode('From '), start, document.createTextNode(' to '), end);
  quiet.appendChild(range);
}
