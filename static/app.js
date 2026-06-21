/* ChurnLence frontend — tabs, live SSE, Overkill signals, sounds, charts. */
(() => {
  'use strict';

  // ---------- state ----------------------------------------------------------
  const state = {
    portfolios: [],
    currentPortfolioId: null,
    snapshot: null,
    prevPrices: {},         // symbol -> last seen price (flash logic)
    prevSignals: {},        // symbol -> last signal (for signal feed)
    signalFeed: [],         // [{ts, symbol, from, to, reason, price}]
    watchlist: loadJSON('churnlence.watchlist', []),
    watchData: {},          // symbol -> quote
    soundOn: loadJSON('churnlence.sound', true),
    notifyOn: loadJSON('churnlence.notify', false),
    plannerDefaults: loadJSON('churnlence.planner', { account: 10000, risk_pct: 1, stop_method: 'atr', atr_multiplier: 2 }),
    mode: loadJSON('churnlence.mode', 'swing'),  // 'swing' | 'day' — flips signal logic + chart timeframe
    sortKey: 'value',
    sortDir: -1,
    evtSource: null,
    reconnectDelay: 1000,
    chartSymbol: null,
    presets: [],
    suggestionCache: new Map(),
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function safeCall(label, fn) {
    try { fn(); }
    catch (err) { console.error(`[${label}]`, err); }
  }

  function loadJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  // ---------- sound engine (Web Audio, synthesized) --------------------------
  const Sound = (() => {
    let ctx = null;
    const ensure = () => {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch { return null; }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    };
    const blip = (freq, dur = 0.12, type = 'sine', gain = 0.08) => {
      if (!state.soundOn) return;
      const c = ensure(); if (!c) return;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type; osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(gain, c.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      osc.connect(g); g.connect(c.destination);
      osc.start(); osc.stop(c.currentTime + dur + 0.02);
    };
    const chord = (notes, dur = 0.18, type = 'sine', gain = 0.05) => {
      notes.forEach((n, i) => setTimeout(() => blip(n, dur, type, gain), i * 70));
    };
    return {
      ding:        () => chord([880, 1320], 0.14, 'sine', 0.07),
      alert:       () => chord([440, 330], 0.18, 'sawtooth', 0.05),
      click:       () => blip(1400, 0.04, 'triangle', 0.05),
      connected:   () => chord([660, 880], 0.12, 'sine', 0.05),
      disconnected:() => chord([440, 330], 0.14, 'sine', 0.05),
      heartbeat:   () => blip(2200, 0.02, 'triangle', 0.02),
      unlock() { ensure(); },
    };
  })();

  // ---------- desktop notifications -----------------------------------------
  const Notify = (() => {
    const supported = 'Notification' in window;
    let iconDataUrl = null;
    const buildIcon = () => {
      if (iconDataUrl) return iconDataUrl;
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const ctx = c.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 128, 128);
      grad.addColorStop(0, '#00e5ff'); grad.addColorStop(1, '#ff3d7f');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 80px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('₵', 64, 72);
      iconDataUrl = c.toDataURL();
      return iconDataUrl;
    };
    const status = () => supported ? Notification.permission : 'unsupported';
    const request = async () => {
      if (!supported) return 'unsupported';
      if (Notification.permission === 'granted') return 'granted';
      if (Notification.permission === 'denied') return 'denied';
      return Notification.requestPermission();
    };
    const fire = (title, body, tag) => {
      if (!state.notifyOn || !supported) return;
      if (Notification.permission !== 'granted') return;
      try {
        new Notification(title, { body, tag, icon: buildIcon(), silent: true });
      } catch { /* noop */ }
    };
    return { supported, status, request, fire };
  })();

  // ---------- toast ----------------------------------------------------------
  function toast(msg, kind = 'info', ms = 3200) {
    const host = $('#toast-host');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; }, ms - 300);
    setTimeout(() => el.remove(), ms);
  }

  // ---------- tabs -----------------------------------------------------------
  function setTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    moveTabUnderline();
    if (name === 'charts')  renderDetailChart();
    if (name === 'scanner') refreshScanner();   // auto-load on first visit
    if (name === 'planner') refreshKelly();     // auto-recompute on tab open
    if (name === 'signals') refreshThesesRules();
  }
  function moveTabUnderline() {
    const active = $('.tab.active');
    const underline = $('.tab-underline');
    if (!active || !underline) return;
    const parent = active.parentElement.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    underline.style.left = (rect.left - parent.left + 2) + 'px';
    underline.style.width = (rect.width - 4) + 'px';
  }

  // ---------- formatters -----------------------------------------------------
  const fmtMoney = v => (v == null || Number.isNaN(v)) ? '—' :
    v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const fmtMoneySm = v => (v == null || Number.isNaN(v)) ? '—' :
    (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
  const fmtPct = v => (v == null || Number.isNaN(v)) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const fmtNum = v => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });

  // number count-up animation
  function tweenNumber(el, to, formatter = fmtMoney, duration = 420) {
    const fromRaw = el.dataset.val ? parseFloat(el.dataset.val) : to;
    const from = Number.isFinite(fromRaw) ? fromRaw : to;
    el.dataset.val = String(to);
    if (!Number.isFinite(to)) { el.textContent = '—'; return; }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      el.textContent = formatter(val);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- API ------------------------------------------------------------
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  // Append ?mode=swing|day to a path, preserving any existing query string.
  function withMode(path) {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}mode=${encodeURIComponent(state.mode || 'swing')}`;
  }

  // ---------- portfolio picker ----------------------------------------------
  async function loadPortfolios() {
    state.portfolios = await api('/api/portfolios');
    const sel = $('#portfolio-select');
    sel.innerHTML = state.portfolios.map(p =>
      `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    if (!state.currentPortfolioId && state.portfolios.length) {
      state.currentPortfolioId = state.portfolios[0].id;
    }
    if (state.currentPortfolioId) sel.value = state.currentPortfolioId;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ---------- SSE stream -----------------------------------------------------
  function openStream() {
    if (state.evtSource) state.evtSource.close();
    if (!state.currentPortfolioId) return;
    const src = new EventSource(withMode(`/api/portfolios/${state.currentPortfolioId}/stream`));
    state.evtSource = src;

    src.addEventListener('open', () => {
      setLive(true);
      state.reconnectDelay = 1000;
      Sound.connected();
    });
    src.addEventListener('message', (ev) => {
      try {
        const snap = JSON.parse(ev.data);
        applySnapshot(snap);
      } catch (e) { console.error(e); }
    });
    src.addEventListener('error', () => {
      setLive(false);
      src.close();
      Sound.disconnected();
      toast(`Stream disconnected — retrying in ${state.reconnectDelay/1000}s`, 'error');
      setTimeout(openStream, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 10000);
    });
  }
  function setLive(on) {
    const pill = $('#live-pill');
    pill.dataset.state = on ? 'on' : 'off';
    pill.querySelector('.live-label').textContent = on ? 'LIVE' : 'OFFLINE';
  }

  // ---------- snapshot handling --------------------------------------------
  // Per-renderer fingerprints so we skip DOM work when the inputs haven't
  // actually changed.  Cheaper than diffing the whole DOM tree.
  const renderHashes = {};
  function shouldRender(key, hash) {
    if (renderHashes[key] === hash) return false;
    renderHashes[key] = hash;
    return true;
  }
  function fingerprintRows(rows) {
    // Symbol|price|signal|shares — anything that changes the visible row
    return (rows || []).map(r =>
      `${r.symbol}|${(r.price || 0).toFixed(6)}|${r.signal}|${r.shares}`).join('~');
  }

  function applySnapshot(snap) {
    if (snap.error) { toast(snap.error, 'error'); return; }
    const prevSnap = state.snapshot;
    state.snapshot = snap;
    // First snapshot in — kill skeleton loaders
    document.body.classList.add('is-loaded');
    detectSignalTransitions(snap.rows || []);
    // Server-canonical watchlist takes precedence — it's what the background
    // signal-watcher sees, so the UI must reflect it.  localStorage stays as
    // an offline fallback only.
    if (Array.isArray(snap.watchlist)) {
      const next = snap.watchlist.slice();
      const cur = state.watchlist || [];
      if (next.length !== cur.length || next.some((s, i) => s !== cur[i])) {
        state.watchlist = next;
        saveJSON('churnlence.watchlist', state.watchlist);
        safeCall('watchlist', () => refreshWatchlist());
      }
    }

    const rowsHash = fingerprintRows(snap.rows);
    const totalsHash = JSON.stringify(snap.totals || {});
    const concHash  = JSON.stringify(snap.concentration || {});

    if (shouldRender('overview', totalsHash + '|' + rowsHash))
      safeCall('overview', () => renderOverview(snap));
    if (shouldRender('actions', rowsHash))
      safeCall('actions', () => renderTodaysActions(snap));
    if (shouldRender('holdings', rowsHash))
      safeCall('holdings', () => renderHoldings(snap));
    if (shouldRender('signal-bars', rowsHash))
      safeCall('signals', () => renderSignalBars(snap));
    if (shouldRender('allocation', rowsHash))
      safeCall('allocation', () => renderAllocation(snap));
    if (shouldRender('heatmap', rowsHash))
      safeCall('heatmap', () => renderHeatmap(snap));
    if (shouldRender('concentration', concHash))
      safeCall('concentration', () => renderConcentration(snap));
    if (shouldRender('ticker', rowsHash))
      safeCall('ticker', () => renderTickerTape(snap));
    if (shouldRender('chart-selector', (snap.rows || []).map(r => r.symbol).join(',')))
      safeCall('chart-selector', () => updateChartSymbolSelector(snap));

    // Charts tab is only re-fetched when it's actually visible.
    if (state.chartSymbol && $('.panel.active')?.dataset.panel === 'charts') {
      // Throttle to avoid stomping the SSE-driven price flash; renderDetailChart
      // itself is fetch-async so it's fine to call frequently, but we cap to 2s.
      const now = Date.now();
      if (!state._lastChartRender || now - state._lastChartRender > 2000) {
        state._lastChartRender = now;
        renderDetailChart();
      }
    }
  }

  function detectSignalTransitions(rows) {
    for (const r of rows) {
      const prev = state.prevSignals[r.symbol];
      if (prev && prev !== r.signal) {
        const entry = {
          ts: new Date().toLocaleTimeString(),
          symbol: r.symbol, from: prev, to: r.signal,
          reason: r.signal_reason, price: r.price,
        };
        state.signalFeed.unshift(entry);
        if (state.signalFeed.length > 200) state.signalFeed.pop();
        if (r.signal === 'BUY') {
          Sound.ding();
          Notify.fire(`${r.symbol}  →  BUY`, `${r.signal_reason}\n${fmtMoneySm(r.price)}`, `sig-${r.symbol}`);
        } else if (r.signal === 'SELL') {
          Sound.alert();
          Notify.fire(`${r.symbol}  →  SELL`, `${r.signal_reason}\n${fmtMoneySm(r.price)}`, `sig-${r.symbol}`);
        }
        // Proactive Jarvis insight (throttled to 1/10min in the copilot)
        if (window.AICopilot && typeof window.AICopilot.pushProactive === 'function') {
          window.AICopilot.pushProactive(`${r.symbol} flipped ${prev} → ${r.signal}: ${r.signal_reason}`);
        }
      }
      state.prevSignals[r.symbol] = r.signal;
    }
    renderSignalFeed();
  }

  // ---------- renderers ------------------------------------------------------
  function renderOverview(snap) {
    const t = snap.totals || {};
    tweenNumber($('#hero-value'), t.value || 0);
    tweenNumber($('#hero-day'), t.day_pl || 0);
    tweenNumber($('#hero-total'), t.pl || 0);
    $('#hero-day-pct').textContent = fmtPct((t.day_pl / (t.value - t.day_pl)) * 100 || 0);
    $('#hero-total-pct').textContent = fmtPct(t.pl_pct || 0);

    const dayCard = $('#hero-day-card');
    const totalCard = $('#hero-total-card');
    dayCard.classList.toggle('up', (t.day_pl || 0) >= 0);
    dayCard.classList.toggle('down', (t.day_pl || 0) < 0);
    totalCard.classList.toggle('up', (t.pl || 0) >= 0);
    totalCard.classList.toggle('down', (t.pl || 0) < 0);
    $('#hero-day-pct').className = 'hero-sub ' + ((t.day_pl || 0) >= 0 ? 'up' : 'down');
    $('#hero-total-pct').className = 'hero-sub ' + ((t.pl || 0) >= 0 ? 'up' : 'down');

    const rows = [...(snap.rows || [])].filter(r => !r.error);
    if (rows.length) {
      const top = rows.reduce((a, b) => (a.change_pct > b.change_pct ? a : b));
      const bot = rows.reduce((a, b) => (a.change_pct < b.change_pct ? a : b));
      $('#hero-mover').textContent = `${top.symbol} ${fmtPct(top.change_pct)}`;
      $('#hero-laggard').textContent = `Worst: ${bot.symbol} ${fmtPct(bot.change_pct)}`;
    } else {
      $('#hero-mover').textContent = '—';
      $('#hero-laggard').textContent = '—';
    }

    const d = new Date(snap.updated_at || Date.now());
    $('#hero-updated').textContent = `Updated ${d.toLocaleTimeString()}`;
  }

  function _flashChangedPrices(rows, tbody) {
    for (const r of rows) {
      const prev = state.prevPrices[r.symbol];
      const tr = tbody.querySelector(`tr[data-sym="${r.symbol}"]`);
      if (tr && prev != null && r.price != null && Math.abs(r.price - prev) > 1e-9) {
        const cell = tr.children[3]; // price column
        if (cell) {
          cell.classList.remove('flash-up', 'flash-down');
          void cell.offsetWidth;
          cell.classList.add(r.price >= prev ? 'flash-up' : 'flash-down');
        }
      }
      state.prevPrices[r.symbol] = r.price;
    }
  }

  function renderHoldings(snap) {
    const tbody = $('#holdings-body');
    const rows = [...(snap.rows || [])];
    if (!rows.length) {
      tbody.innerHTML = `
        <tr class="empty-row"><td colspan="13">
          <div class="empty-quickstart">
            <h3>Nothing here yet</h3>
            <p>Pick a basket to get started — you can edit or remove them anytime.</p>
            <div class="preset-row" id="empty-preset-row"></div>
            <p style="margin-top:6px;">or <a href="#" id="empty-add-btn" style="color:var(--cyan);">add a single position</a></p>
          </div>
        </td></tr>`;
      renderPresets();
      const addLink = $('#empty-add-btn');
      if (addLink) addLink.addEventListener('click', (e) => { e.preventDefault(); openModal('add-holding-modal'); });
      return;
    }
    const dir = state.sortDir, key = state.sortKey;
    rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });

    // FAST PATH: when the row set (sym + id + sort order) hasn't changed,
    // update only the cells whose values changed.  Avoids tearing down +
    // rebinding all the click handlers + repainting the whole table on
    // every price tick.
    // Include thesis-active state so adding/removing a thesis triggers a
    // full rebuild (the "T" chip is rendered in the slow path only).
    const structureSig = rows.map(r => {
      const tFlag = (r.theses && r.theses.some(t => t.enabled)) ? 'T' : 'N';
      return `${r.id}:${r.symbol}:${tFlag}`;
    }).join('|');
    if (tbody._structureSig === structureSig && tbody.children.length === rows.length) {
      for (const r of rows) {
        const tr = tbody.querySelector(`tr[data-sym="${r.symbol}"][data-id="${r.id}"]`);
        if (!tr) continue;
        const cells = tr.children;
        // Index map matches the <td> order in the template below.
        // [0]=symbol [1]=shares [2]=cost [3]=price [4]=day% [5]=value
        // [6]=pl$ [7]=pl% [8]=signal [9]=stopMA [10]=stopATR [11]=atr% [12]=actions
        const up = (r.change_pct || 0) >= 0;
        const plUp = (r.pl || 0) >= 0;
        const set = (i, txt, cls) => {
          if (cells[i].textContent !== txt) cells[i].textContent = txt;
          if (cls != null) cells[i].className = cls;
        };
        set(1, fmtNum(r.shares),       'num editable');
        set(2, fmtMoneySm(r.cost_basis),'num editable');
        // price gets flash-on-change, handled below
        const priceCell = cells[3];
        const newPriceTxt = r.price != null ? fmtMoneySm(r.price) : '—';
        if (priceCell.textContent !== newPriceTxt) priceCell.textContent = newPriceTxt;
        set(4, fmtPct(r.change_pct), 'num ' + (up ? 'up' : 'down'));
        set(5, fmtMoney(r.value),    'num');
        set(6, fmtMoney(r.pl),       'num ' + (plUp ? 'up' : 'down'));
        set(7, fmtPct(r.pl_pct),     'num ' + (plUp ? 'up' : 'down'));
        const sigChip = cells[8].firstElementChild;
        if (sigChip) {
          const desired = `sig-chip ${(r.signal || 'hold').toLowerCase()}`;
          if (sigChip.className !== desired) sigChip.className = desired;
          if (sigChip.textContent !== (r.signal || 'HOLD')) sigChip.textContent = r.signal || 'HOLD';
          sigChip.title = r.signal_reason || '';
        }
        set(9,  r.stop_loss != null ? fmtMoneySm(r.stop_loss) : '—', 'num');
        set(10, r.stop_atr  != null ? fmtMoneySm(r.stop_atr)  : '—', 'num');
        set(11, r.atr_pct   != null ? fmtPct(r.atr_pct)       : '—', 'num');
      }
      // Price flash relies on prevPrices, computed below in the slow-path
      // block — replicate the minimum of it here so flashes still fire.
      _flashChangedPrices(rows, tbody);
      return;
    }
    tbody._structureSig = structureSig;

    tbody.innerHTML = rows.map(r => {
      const up = (r.change_pct || 0) >= 0;
      const plUp = (r.pl || 0) >= 0;
      return `
        <tr data-sym="${r.symbol}" data-id="${r.id}">
          <td><span class="sym">${r.symbol}</span><span class="sym-name">${escapeHtml(r.name || '')}</span></td>
          <td class="num editable" data-field="shares" title="Double-click to edit">${fmtNum(r.shares)}</td>
          <td class="num editable" data-field="cost_basis" title="Double-click to edit">${fmtMoneySm(r.cost_basis)}</td>
          <td class="num price-cell">${r.price != null ? fmtMoneySm(r.price) : '—'}</td>
          <td class="num ${up ? 'up' : 'down'}">${fmtPct(r.change_pct)}</td>
          <td class="num">${fmtMoney(r.value)}</td>
          <td class="num ${plUp ? 'up' : 'down'}">${fmtMoney(r.pl)}</td>
          <td class="num ${plUp ? 'up' : 'down'}">${fmtPct(r.pl_pct)}</td>
          <td>
            <span class="sig-chip ${(r.signal||'hold').toLowerCase()}" title="${escapeHtml(r.signal_reason||'')}">${r.signal || 'HOLD'}</span>
            ${(r.theses && r.theses.some(t => t.enabled))
              ? `<span class="thesis-chip" title="Custom thesis active: ${escapeHtml((r.theses.filter(t=>t.enabled).map(t=>t.name)).join(', '))}">T</span>`
              : ''}
          </td>
          <td class="num">${r.stop_loss != null ? fmtMoneySm(r.stop_loss) : '—'}</td>
          <td class="num">${r.stop_atr != null ? fmtMoneySm(r.stop_atr) : '—'}</td>
          <td class="num">${r.atr_pct != null ? fmtPct(r.atr_pct) : '—'}</td>
          <td class="num row-actions">
            <button class="row-act row-thesis" data-thesis="${r.symbol}" title="Custom thesis">📋</button>
            <button class="row-act row-sell" data-sell="${r.symbol}" title="Sell / close position">Sell</button>
            <button class="row-del" data-del="${r.id}" title="Remove (no tax record)">✕</button>
          </td>
        </tr>`;
    }).join('');

    // mobile card stack — rendered alongside, CSS controls visibility
    const cardHost = $('#holdings-cards');
    if (cardHost) {
      cardHost.innerHTML = rows.map(r => {
        const up = (r.change_pct || 0) >= 0;
        const plUp = (r.pl || 0) >= 0;
        return `
          <div class="hcard" data-sym="${r.symbol}" data-id="${r.id}">
            <div class="hcard-head">
              <div>
                <div class="hcard-sym">${r.symbol}</div>
                <div class="hcard-name">${escapeHtml(r.name || '')}</div>
              </div>
              <span class="sig-chip ${(r.signal||'hold').toLowerCase()}">${r.signal || 'HOLD'}</span>
            </div>
            <div class="hcard-grid">
              <div><span class="n-lbl">Last</span><span class="n-val">${fmtMoneySm(r.price)}</span></div>
              <div><span class="n-lbl">Day</span><span class="n-val ${up?'up':'down'}">${fmtPct(r.change_pct)}</span></div>
              <div><span class="n-lbl">Shares</span><span class="n-val">${fmtNum(r.shares)}</span></div>
              <div><span class="n-lbl">Avg cost</span><span class="n-val">${fmtMoneySm(r.cost_basis)}</span></div>
              <div><span class="n-lbl">Value</span><span class="n-val">${fmtMoney(r.value)}</span></div>
              <div><span class="n-lbl">P/L</span><span class="n-val ${plUp?'up':'down'}">${fmtMoney(r.pl)} · ${fmtPct(r.pl_pct)}</span></div>
            </div>
            <div class="hcard-actions">
              <button class="row-act row-sell" data-sell="${r.symbol}">Sell</button>
              <button class="ghost-btn" data-chart="${r.symbol}">Chart</button>
              <button class="row-del" data-del="${r.id}" title="Remove">✕</button>
            </div>
          </div>`;
      }).join('');
      $$('[data-chart]', cardHost).forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation();
        state.chartSymbol = b.dataset.chart;
        $('#chart-symbol-select').value = b.dataset.chart;
        setTab('charts');
      }));
      $$('[data-del]', cardHost).forEach(btn => btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this position without recording a sell? (No tax log will be written.)')) return;
        try { await api(`/api/holdings/${btn.dataset.del}`, { method: 'DELETE' }); toast('Removed', 'success'); await refreshOnce(); }
        catch (err) { toast(err.message, 'error'); }
      }));
      $$('[data-sell]', cardHost).forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation(); openSellModal(btn.dataset.sell);
      }));
    }

    // flash price on change
    _flashChangedPrices(rows, tbody);

    // delete handlers
    $$('.row-del', tbody).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this position without recording a sell? (No tax log will be written — use the Sell button for realized gains.)')) return;
        const id = btn.dataset.del;
        Sound.click();
        try {
          await api(`/api/holdings/${id}`, { method: 'DELETE' });
          toast('Position removed', 'success');
          await refreshOnce();
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    // sell handlers
    $$('.row-sell', tbody).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        Sound.click();
        openSellModal(btn.dataset.sell);
      });
    });

    // thesis handlers
    $$('.row-thesis', tbody).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openThesisModal(btn.dataset.thesis);
      });
    });

    // click row → charts tab (but skip when clicking an editable cell / button)
    $$('tr[data-sym]', tbody).forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.editable') || e.target.closest('button') || e.target.closest('input')) return;
        state.chartSymbol = tr.dataset.sym;
        $('#chart-symbol-select').value = tr.dataset.sym;
        setTab('charts');
      });
    });

    // inline edit: double-click editable cell → input
    $$('.editable', tbody).forEach(td => {
      td.addEventListener('dblclick', (e) => beginInlineEdit(td));
    });
  }

  async function beginInlineEdit(td) {
    if (td.querySelector('input')) return;
    const tr = td.closest('tr');
    const id = tr.dataset.id;
    const field = td.dataset.field;
    const original = td.textContent.trim().replace(/[$,]/g, '');
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.min = field === 'shares' ? '0.0000001' : '0';
    input.className = 'inline-edit';
    input.value = original;
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();
    const finish = async (commit) => {
      if (!td.contains(input)) return;
      const raw = parseFloat(input.value);
      if (!commit || !Number.isFinite(raw) || raw < 0) {
        td.textContent = field === 'shares' ? fmtNum(parseFloat(original)) : fmtMoneySm(parseFloat(original));
        return;
      }
      td.textContent = field === 'shares' ? fmtNum(raw) : fmtMoneySm(raw);
      try {
        await api(`/api/holdings/${id}`, { method: 'PATCH', body: JSON.stringify({ [field]: raw }) });
        Sound.click();
        await refreshOnce();
      } catch (err) { toast(err.message, 'error'); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function renderSignalBars(snap) {
    const rows = snap.rows || [];
    const counts = { BUY: 0, SELL: 0, HOLD: 0 };
    rows.forEach(r => counts[r.signal || 'HOLD']++);
    const total = Math.max(1, rows.length);
    $('#count-buy').textContent = counts.BUY;
    $('#count-hold').textContent = counts.HOLD;
    $('#count-sell').textContent = counts.SELL;
    $('#bar-buy').style.width = (counts.BUY / total * 100) + '%';
    $('#bar-hold').style.width = (counts.HOLD / total * 100) + '%';
    $('#bar-sell').style.width = (counts.SELL / total * 100) + '%';
  }

  // ---------- presets (quick-add baskets) ------------------------------------
  const PRESET_EMOJI = { mag7: '🧲', index: '📊', crypto: '₿', semis: '🧠' };
  async function loadPresets() {
    try {
      state.presets = await api('/api/presets');
    } catch { state.presets = []; }
    renderPresets();
  }
  function renderPresets() {
    const render = (host, compact = false) => {
      if (!host) return;
      host.innerHTML = state.presets.map(p => `
        <button type="button" class="preset-chip" data-preset="${p.id}" title="${escapeHtml(p.description)}">
          <span class="emoji">${PRESET_EMOJI[p.id] || '⚡'}</span>
          ${p.name}${compact ? '' : `  <small>${p.symbols.length} symbols</small>`}
        </button>`).join('');
      host.querySelectorAll('[data-preset]').forEach(btn => {
        btn.addEventListener('click', () => addPreset(btn.dataset.preset));
      });
    };
    render($('#preset-row'));
    render($('#preset-row-inline'), true);
    render($('#empty-preset-row'));
  }
  async function addPreset(id) {
    const preset = state.presets.find(p => p.id === id);
    if (!preset || !state.currentPortfolioId) return;
    Sound.click();
    try {
      const items = preset.symbols.map(s => ({ symbol: s, shares: 1, cost_basis: 0 }));
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/holdings/bulk`,
        { method: 'POST', body: JSON.stringify({ items }) });
      const ok = (r.added || []).length;
      const bad = (r.errors || []).length;
      if (ok) Sound.ding();
      closeModal('add-holding-modal');
      await refreshOnce();
      toast(`${preset.name}: added ${ok}${bad ? `, ${bad} failed` : ''}`,
            bad && !ok ? 'error' : 'success');
    } catch (ex) { toast(ex.message, 'error'); }
  }

  // ---------- autocomplete --------------------------------------------------
  let acActiveIdx = -1;
  let acDebounce = null;
  async function fetchSuggestions(q) {
    const key = q.toUpperCase();
    if (state.suggestionCache.has(key)) return state.suggestionCache.get(key);
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      state.suggestionCache.set(key, r);
      return r;
    } catch { return []; }
  }
  function renderSuggestions(list) {
    const ul = $('#symbol-suggestions');
    if (!list.length) { ul.hidden = true; ul.innerHTML = ''; return; }
    ul.hidden = false;
    ul.innerHTML = list.map((s, i) => `
      <li data-idx="${i}" data-symbol="${s.symbol}">
        <span class="ac-sym">${s.symbol}</span>
        <span class="ac-name">${escapeHtml(s.name || '')}</span>
        <span class="ac-kind ${s.kind || ''}">${(s.kind || '').toUpperCase()}</span>
      </li>`).join('');
    ul.querySelectorAll('li').forEach(li => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickSuggestion(li.dataset.symbol);
      });
    });
    acActiveIdx = -1;
  }
  function pickSuggestion(symbol) {
    const input = $('#symbol-input');
    input.value = symbol;
    $('#symbol-suggestions').hidden = true;
    $('#symbol-preview').textContent = '';
    autoFillCurrentPrice(symbol);
    // move focus to shares
    const form = $('#add-holding-form');
    form.elements.shares.focus();
  }
  async function autoFillCurrentPrice(symbol) {
    const costInput = $('#cost-basis-input');
    const preview = $('#symbol-preview');
    try {
      const q = await api(withMode(`/api/quote/${encodeURIComponent(symbol)}`));
      preview.textContent = `${fmtMoneySm(q.price)}`;
      if (!costInput.value || parseFloat(costInput.value) === 0) {
        costInput.value = q.price;
      }
      costInput.dataset.last = q.price;
    } catch {
      preview.textContent = 'not found';
    }
  }

  // ---------- concentration / HHI -------------------------------------------
  // ---------- perp funding rates (Overview) -------------------------------
  async function refreshFunding() {
    const card = $('#funding-card');
    if (!card) return;
    // Build symbol list from current portfolio + watchlist (top 6 dedup)
    const symbols = new Set();
    (state.snapshot?.rows || []).forEach(r => {
      const s = (r.symbol || '').replace(/-USD$/, '');
      if (s && /^[A-Z0-9]{2,8}$/.test(s)) symbols.add(s);
    });
    state.watchlist.forEach(s => {
      const bare = s.replace(/-USD$/, '');
      if (/^[A-Z0-9]{2,8}$/.test(bare)) symbols.add(bare);
    });
    if (!symbols.has('BTC')) symbols.add('BTC');
    if (!symbols.has('SOL')) symbols.add('SOL');
    const list = [...symbols].slice(0, 8).join(',');
    try {
      const data = await api(`/api/funding?symbol=${encodeURIComponent(list)}`);
      if (!data.rows || !data.rows.length) {
        card.hidden = true;
        return;
      }
      card.hidden = false;
      $('#funding-as-of').textContent = `Updated ${new Date(data.as_of).toLocaleTimeString()}`;
      const compactUsd = v => {
        const a = Math.abs(v); if (a >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
        if (a >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
        if (a >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
        return '$' + Math.round(v);
      };
      const grid = $('#funding-grid');
      grid.innerHTML = data.rows.map(r => {
        const venuePills = r.venues.map(v => {
          let cls = v.funding > 0 ? 'up' : v.funding < 0 ? 'down' : '';
          if (Math.abs(v.funding) >= 0.075) cls = 'hot';
          const sign = v.funding >= 0 ? '+' : '';
          return `<span class="funding-pill ${cls}" title="${v.venue}: ${v.funding.toFixed(4)}% per interval">${v.venue.charAt(0)}${v.venue === 'Hyperliquid' ? 'L' : ''} ${sign}${v.funding.toFixed(3)}%</span>`;
        }).join('');
        const spread = r.spread_bps != null
          ? `<span class="funding-pill" title="Cross-venue funding spread (max - min) — arb opportunity if &gt; 5 bps">Δ ${r.spread_bps.toFixed(1)} bps</span>`
          : '';
        return `<div class="funding-row">
          <span class="sym">${escapeHtml(r.symbol)}</span>
          <div class="venues">${venuePills} ${spread}</div>
          <span class="oi">OI ${compactUsd(r.total_oi_usd || 0)}</span>
          <span class="regime ${r.regime || 'neutral'}">${(r.regime || 'neutral').replace(/-/g, ' ')}</span>
        </div>`;
      }).join('') + '<div class="funding-warn">⚠ Funding > +0.075% per 8h has historically preceded BTC mean-reversion. Negative funding = shorts paying = squeeze setup.</div>';
    } catch (err) {
      card.hidden = true;
    }
  }

  // ---------- market regime (top of Overview) ------------------------------
  async function refreshMarket() {
    const card = $('#market-regime');
    if (!card) return;
    try {
      const m = await api('/api/market');
      // Hide the card entirely if both APIs failed (sandbox case)
      if (!m.fear_greed && !m.global) { card.hidden = true; return; }
      card.hidden = false;
      if (m.fear_greed) {
        const v = m.fear_greed.value;
        $('#mr-fg-num').textContent = v;
        const lbl = (m.fear_greed.label || 'Neutral');
        const tag = $('#mr-fg-label');
        tag.textContent = lbl.toUpperCase();
        const cls = lbl.toLowerCase().replace(/\s+/g, '-');
        tag.className = 'mr-fg-tag ' + cls;
        const d = m.fear_greed.delta;
        const dEl = $('#mr-fg-delta');
        dEl.textContent = d > 0 ? `↑ ${d} since yesterday` : d < 0 ? `↓ ${Math.abs(d)} since yesterday` : 'flat';
        dEl.className = 'mr-sub ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
      }
      if (m.global) {
        $('#mr-btc-dom').textContent = m.global.btc_dominance + '%';
        $('#mr-eth-dom').textContent = `ETH ${m.global.eth_dominance}%`;
        const mcap = m.global.total_mcap_usd || 0;
        $('#mr-mcap').textContent = '$' + (mcap / 1e12).toFixed(2) + 'T';
        const ch = m.global.mcap_change_24h_pct;
        const chEl = $('#mr-mcap-chg');
        if (ch != null) {
          chEl.textContent = (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch).toFixed(2) + '% 24h';
          chEl.className = 'mr-sub ' + (ch >= 0 ? 'up' : 'down');
        }
      }
      $('#mr-regime').textContent = m.regime || '—';
    } catch (err) {
      card.hidden = true;
    }
  }

  // ---------- News strip (Charts tab) --------------------------------------
  const _newsCache = {};   // symbol -> { ts, items }
  // Live order-book depth widget on the Chart tab.  Renders a two-column
  // horizontal-bar list (bids left/green, asks right/red) with size bars
  // sized to the deepest level in view.  Hides itself when the symbol has
  // no Crypto.com mapping (so stocks/ETFs don't show an empty card).
  async function refreshDepth(symbol) {
    if (!symbol) return;
    const card = $('#depth-card');
    const grid = $('#depth-grid');
    if (!card || !grid) return;
    try {
      const r = await api(`/api/orderbook/${encodeURIComponent(symbol)}?depth=15`);
      if (!r || !r.bids || !r.asks) { card.hidden = true; return; }
      card.hidden = false;
      $('#depth-sub').textContent =
        `Mid ${fmtMoneySm(r.mid)} · spread ${r.spread_pct}% · top 15 each side`;
      const allSizes = [...r.bids, ...r.asks].map(b => b[1]);
      const maxSize = Math.max(...allSizes, 0.0001);
      const row = (level, side) => {
        const [px, sz] = level;
        const pct = (sz / maxSize) * 100;
        return `
          <div class="dp-row ${side}">
            <span class="dp-fill" style="width:${pct.toFixed(1)}%"></span>
            <span class="dp-px">${fmtMoneySm(px)}</span>
            <span class="dp-sz">${sz.toLocaleString(undefined, {maximumFractionDigits: 4})}</span>
          </div>`;
      };
      grid.innerHTML = `
        <div class="dp-col dp-bids">
          <div class="dp-head"><span>Price</span><span>Size</span></div>
          ${r.bids.map(b => row(b, 'bid')).join('')}
        </div>
        <div class="dp-col dp-asks">
          <div class="dp-head"><span>Price</span><span>Size</span></div>
          ${r.asks.map(a => row(a, 'ask')).join('')}
        </div>`;
    } catch (err) {
      // 404 = no Crypto.com mapping for this symbol → hide silently
      card.hidden = true;
    }
  }

  async function refreshNews(symbol) {
    if (!symbol) return;
    const card = $('#news-card');
    const list = $('#news-list');
    const sub = $('#news-symbol');
    if (!card || !list) return;
    sub.textContent = symbol;
    card.hidden = false;
    list.innerHTML = '<li class="news-empty">Loading…</li>';
    const cached = _newsCache[symbol];
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      renderNews(cached.items);
      return;
    }
    try {
      const items = await api(`/api/news/${encodeURIComponent(symbol)}`);
      _newsCache[symbol] = { ts: Date.now(), items };
      renderNews(items);
    } catch (err) {
      list.innerHTML = `<li class="news-empty">Couldn't load news: ${escapeHtml(err.message)}</li>`;
    }
  }
  function renderNews(items) {
    const list = $('#news-list');
    if (!items || !items.length) {
      list.innerHTML = '<li class="news-empty">No recent headlines.</li>';
      return;
    }
    list.innerHTML = items.slice(0, 8).map(n => {
      const when = n.published ? new Date(n.published).toLocaleString() : '';
      const votes = (n.votes && (n.votes.positive || n.votes.negative))
        ? `<span class="up">▲ ${n.votes.positive||0}</span> · <span class="down">▼ ${n.votes.negative||0}</span>`
        : '';
      return `<li>
        <a href="${escapeHtml(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
        <div class="news-meta">
          <span>${escapeHtml(n.source || n.domain || '')}</span>
          <span>${escapeHtml(when)}</span>
          ${votes ? `<span>${votes}</span>` : ''}
        </div>
      </li>`;
    }).join('');
  }

  // ---------- Kelly criterion (Planner tab) --------------------------------
  async function refreshKelly() {
    const body = $('#kelly-body');
    if (!body || !state.currentPortfolioId) return;
    const pf = $('#planner-form');
    const account = pf ? parseFloat(pf.elements.account.value) || 10000 : 10000;
    body.innerHTML = '<p class="planner-note" style="color:var(--ink-mute)">Computing…</p>';
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/kelly?account=${account}&fraction=0.5`);
      if (r.error) {
        body.innerHTML = `<p class="planner-note" style="color:var(--ink-mute)">${escapeHtml(r.error)}</p>`;
        return;
      }
      const fullColor = r.kelly_full > 0 ? 'up' : 'down';
      body.innerHTML = `
        <div class="planner-numbers">
          <div><span class="n-lbl">Win rate</span><span class="n-val">${r.win_rate.toFixed(1)}%</span></div>
          <div><span class="n-lbl">Avg win</span><span class="n-val up">+${r.avg_win_pct.toFixed(2)}%</span></div>
          <div><span class="n-lbl">Avg loss</span><span class="n-val down">−${r.avg_loss_pct.toFixed(2)}%</span></div>
          <div><span class="n-lbl">Payoff R</span><span class="n-val">${r.payoff_ratio.toFixed(2)}</span></div>
          <div><span class="n-lbl">Full Kelly</span><span class="n-val ${fullColor}">${r.kelly_full.toFixed(2)}%</span></div>
          <div><span class="n-lbl">½-Kelly bet</span><span class="n-val">${r.kelly_used.toFixed(2)}% · ${fmtMoney(r.bet_dollars)}</span></div>
          <div><span class="n-lbl">Sample</span><span class="n-val">${r.sample.trades} trades (${r.sample.wins}W / ${r.sample.losses}L)</span></div>
        </div>
        ${r.warning ? `<p class="planner-note warn" style="color:var(--amber, #ffb84d); margin-top:10px;">⚠ ${escapeHtml(r.warning)}</p>` : ''}
      `;
    } catch (err) {
      body.innerHTML = `<p class="planner-note" style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
    }
  }

  // ---------- Correlation heatmap ------------------------------------------
  async function refreshCorrelation() {
    const card = $('#correlation-card');
    if (!card) return;
    if (!state.currentPortfolioId) { card.hidden = true; return; }
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/correlation`);
      const syms = r.symbols || [];
      if (syms.length < 2) { card.hidden = true; return; }
      card.hidden = false;
      const grid = $('#corr-grid');
      grid.style.gridTemplateColumns = `120px repeat(${syms.length}, 1fr)`;
      const cells = ['<div class="corr-cell corr-header"></div>'];
      for (const s of syms) cells.push(`<div class="corr-cell corr-header">${escapeHtml(s)}</div>`);
      for (let i = 0; i < syms.length; i++) {
        cells.push(`<div class="corr-cell corr-row-header">${escapeHtml(syms[i])}</div>`);
        for (let j = 0; j < syms.length; j++) {
          const v = r.matrix[i][j];
          let cls = 'corr-zero';
          if (i === j) cls = 'corr-self';
          else if (v >= 0.7) cls = 'corr-pos-3';
          else if (v >= 0.4) cls = 'corr-pos-2';
          else if (v >= 0.15) cls = 'corr-pos-1';
          else if (v <= -0.5) cls = 'corr-neg-3';
          else if (v <= -0.25) cls = 'corr-neg-2';
          else if (v <= -0.1) cls = 'corr-neg-1';
          cells.push(`<div class="corr-cell ${cls}" title="${syms[i]} vs ${syms[j]}: ${v.toFixed(3)}">${v.toFixed(2)}</div>`);
        }
      }
      grid.innerHTML = cells.join('');
      const warn = $('#corr-warn');
      if (r.highest_pair && r.highest_pair.corr > 0.85) {
        warn.hidden = false;
        warn.innerHTML = `⚠ <strong>${r.highest_pair.a}</strong> and <strong>${r.highest_pair.b}</strong> are ${(r.highest_pair.corr * 100).toFixed(0)}% correlated — they're basically the same trade. Consider trimming one.`;
      } else {
        warn.hidden = true;
      }
    } catch (err) {
      card.hidden = true;
    }
  }

  // ---------- Today's actions card -----------------------------------------
  function renderTodaysActions(snap) {
    const wrap = $('#actions-wrap');
    if (!wrap) return;
    const rows = (snap.rows || []).filter(r => !r.error);
    // Holdings + watchlist tickers in one feed, deduped, non-HOLD only
    const all = [...rows];
    for (const sym of state.watchlist) {
      const w = state.watchData[sym];
      if (w && !rows.some(r => r.symbol === sym)) {
        all.push({
          symbol: w.symbol, price: w.price, change_pct: w.change_pct,
          signal: w.signal, signal_reason: w.signal_reason,
          stop_atr: w.stop_atr, stop_loss: w.stop_loss, _watchlist: true,
        });
      }
    }
    const actionable = all.filter(r => r.signal && r.signal !== 'HOLD');
    if (!actionable.length) {
      wrap.innerHTML = '<div class="empty-row" style="padding:18px 8px;">All clear — every position is on HOLD right now.</div>';
      return;
    }
    actionable.sort((a, b) => (a.signal === 'SELL' ? -1 : 1) - (b.signal === 'SELL' ? -1 : 1));
    wrap.innerHTML = actionable.map(r => {
      const up = (r.change_pct || 0) >= 0;
      const stop = r.stop_atr ?? r.stop_loss;
      const tag = r._watchlist ? '<span class="ac-tag">watchlist</span>' : '';
      const rsi = r.rsi != null
        ? `<span class="rsi-chip ${r.rsi_label || 'neutral'}" title="14-period RSI — ${r.rsi_label}">RSI ${r.rsi.toFixed(0)}</span>`
        : '';
      const rvol = r.rvol != null
        ? `<span class="rvol-chip ${r.rvol_label || 'normal'}" title="Volume vs 20-bar avg — ${r.rvol_label}">VOL ${r.rvol.toFixed(1)}×</span>`
        : '';
      return `
        <div class="action-row" data-sym="${r.symbol}">
          <span class="sig-chip ${r.signal.toLowerCase()}">${r.signal}</span>
          <div class="action-main">
            <div class="action-sym">${r.symbol} ${tag} ${rsi} ${rvol}</div>
            <div class="action-reason">${escapeHtml(r.signal_reason || '')}</div>
          </div>
          <div class="action-px">
            <div class="${up ? 'up' : 'down'}">${fmtMoneySm(r.price)} · ${fmtPct(r.change_pct)}</div>
            ${stop ? `<div class="action-stop">stop ${fmtMoneySm(stop)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
    $$('.action-row[data-sym]', wrap).forEach(el => {
      el.addEventListener('click', () => {
        state.chartSymbol = el.dataset.sym;
        const sel = $('#chart-symbol-select');
        if (sel && [...sel.options].some(o => o.value === el.dataset.sym)) sel.value = el.dataset.sym;
        setTab('charts');
      });
    });
  }

  function renderConcentration(snap) {
    const c = snap.concentration || { hhi: 0, grade: '—', warnings: [], top_weight: 0 };
    const valEl = $('#hhi-value');
    tweenNumber(valEl, c.hhi || 0, v => Math.round(v).toLocaleString('en-US'), 500);
    const grade = $('#hhi-grade');
    grade.textContent = c.grade;
    grade.className = 'risk-grade ' +
      (c.hhi < 1500 ? 'diversified' : c.hhi < 2500 ? 'moderate' : 'concentrated');
    // meter fill: scale 0..10000 → 0..100% of meter, but clamp at 100
    const pct = Math.min(100, (c.hhi || 0) / 100);
    $('#hhi-fill').style.width = pct + '%';
    const ul = $('#hhi-warnings');
    if (!c.warnings || !c.warnings.length) {
      ul.innerHTML = '<li class="empty">No single-name risks detected.</li>';
    } else {
      ul.innerHTML = c.warnings.map(w =>
        `<li><strong>${w.symbol}</strong> — ${w.weight.toFixed(1)}% of portfolio</li>`
      ).join('');
    }
  }

  // ---------- allocation doughnut -------------------------------------------
  let allocChart = null;
  // Bleach palette: Ichigo orange + bankai cyan + Hollow red + Senbonzakura pink
  // + kido green + amber + violet + softer crimson — works in any order on the doughnut
  const PALETTE = ['#ff6a00', '#00d4ff', '#cc1f33', '#ff8aae', '#00ff9c', '#ffb84d', '#b388ff', '#ff7a99'];
  function renderAllocation(snap) {
    const rows = (snap.rows || []).filter(r => !r.error && (r.value || 0) > 0);
    const labels = rows.map(r => r.symbol);
    const data = rows.map(r => r.value);
    const colors = rows.map((_, i) => PALETTE[i % PALETTE.length]);
    const ctx = $('#alloc-chart');
    if (!ctx || typeof Chart === 'undefined') return;
    const cfg = {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        cutout: '72%',
        plugins: { legend: { display: false }, tooltip: { enabled: true } },
        animation: { duration: 400 },
      }
    };
    if (!allocChart) allocChart = new Chart(ctx, cfg);
    else { allocChart.data = cfg.data; allocChart.update('none'); }

    const total = data.reduce((a, b) => a + b, 0) || 1;
    $('#alloc-legend').innerHTML = labels.length
      ? labels.map((l, i) => `
        <li><span><i style="background:${colors[i]}"></i><span class="sym">${l}</span></span>
            <span class="pct">${(data[i] / total * 100).toFixed(1)}%</span></li>`).join('')
      : '<li><span class="sym" style="color:var(--ink-mute)">No positions</span></li>';
  }

  // ---------- heatmap -------------------------------------------------------
  // Bloomberg-style portfolio overview: tile size proportional to position
  // value, color shaded by 24h change.  CSS grid handles the layout; no
  // Chart.js dependency.
  function renderHeatmap(snap) {
    const host = $('#heatmap');
    if (!host) return;
    const rows = (snap.rows || []).filter(r => !r.error && (r.value || 0) > 0);
    if (!rows.length) {
      host.innerHTML = '<div class="empty-row" style="padding:18px 8px;">'
        + 'Heatmap will appear once you add some positions.</div>';
      return;
    }
    const total = rows.reduce((s, r) => s + (r.value || 0), 0) || 1;
    // Sort largest-first so the eye lands on biggest exposures
    const sorted = [...rows].sort((a, b) => (b.value || 0) - (a.value || 0));
    // Color: cyan-green for up, magenta-red for down; opacity scales with magnitude
    const tile = r => {
      const pct = r.change_pct || 0;
      const intensity = Math.min(1, Math.abs(pct) / 10);  // ±10% saturates
      const bg = pct >= 0
        ? `rgba(0, 255, 156, ${0.10 + intensity * 0.40})`
        : `rgba(255, 61, 127, ${0.10 + intensity * 0.40})`;
      const sigCls = (r.signal || 'hold').toLowerCase();
      const wPct = ((r.value || 0) / total) * 100;
      // flex-grow scales tile size to value share; min/max-width prevents
      // tiny holdings disappearing and huge ones eating the row.
      return `
        <div class="heatmap-tile" data-sym="${r.symbol}"
             style="flex-grow:${wPct.toFixed(2)}; background:${bg};"
             title="${r.symbol} · ${fmtMoney(r.value)} (${wPct.toFixed(1)}% of book) · ${fmtPct(r.change_pct)}">
          <div class="hm-sym">${r.symbol}</div>
          <div class="hm-px">${fmtMoneySm(r.price)}</div>
          <div class="hm-chg ${pct>=0?'up':'down'}">${pct>=0?'+':''}${pct.toFixed(2)}%</div>
          <span class="hm-sig sig-chip ${sigCls}">${r.signal || 'HOLD'}</span>
        </div>`;
    };
    host.innerHTML = sorted.map(tile).join('');
    $$('.heatmap-tile', host).forEach(t => {
      t.addEventListener('click', () => {
        state.chartSymbol = t.dataset.sym;
        const sel = $('#chart-symbol-select');
        if (sel) sel.value = t.dataset.sym;
        setTab('charts');
      });
    });
  }

  // ---------- ticker tape ----------------------------------------------------
  function renderTickerTape(snap) {
    const rows = (snap.rows || []).filter(r => !r.error);
    const watchRows = Object.values(state.watchData).filter(Boolean);
    const all = [...rows, ...watchRows];
    if (!all.length) { $('#ticker-track').innerHTML = '<span class="ticker-item">Add a holding to start the tape ⤳</span>'; return; }
    const pieces = all.map(r => {
      const chg = r.change_pct ?? 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const arrow = chg >= 0 ? '▲' : '▼';
      return `<span class="ticker-item"><strong>${r.symbol}</strong> ${fmtMoneySm(r.price)} <span class="${cls}">${arrow} ${fmtPct(chg)}</span></span>`;
    });
    // duplicate to make seamless
    $('#ticker-track').innerHTML = (pieces.join('') + pieces.join(''));
  }

  // ---------- signal feed ----------------------------------------------------
  function renderSignalFeed() {
    const ul = $('#signal-feed');
    $('#signal-feed-count').textContent = `${state.signalFeed.length} events`;
    if (!state.signalFeed.length) {
      ul.innerHTML = '<li class="empty">Waiting for signal transitions…</li>';
      return;
    }
    ul.innerHTML = state.signalFeed.map(e => `
      <li>
        <span class="time">${e.ts}</span>
        <span class="sym">${e.symbol}</span>
        <span><span class="sig-chip ${e.to.toLowerCase()}">${e.from} → ${e.to}</span></span>
        <span class="reason">${escapeHtml(e.reason || '')}</span>
        <span class="px">${fmtMoneySm(e.price)}</span>
      </li>`).join('');
  }

  // ---------- chart (detail) -------------------------------------------------
  let detailChart = null;
  function updateChartSymbolSelector(snap) {
    const sel = $('#chart-symbol-select');
    const options = [
      ...(snap.rows || []).map(r => r.symbol),
      ...state.watchlist,
    ];
    const uniq = [...new Set(options)];
    const cur = sel.value || state.chartSymbol;
    sel.innerHTML = uniq.map(s => `<option value="${s}">${s}</option>`).join('');
    if (uniq.length) {
      if (cur && uniq.includes(cur)) sel.value = cur;
      else sel.value = uniq[0];
      state.chartSymbol = sel.value;
    } else {
      state.chartSymbol = null;
    }
  }

  async function renderDetailChart() {
    if (!state.chartSymbol) return;
    const ctx = $('#detail-chart');
    if (typeof Chart === 'undefined') { toast('Chart library failed to load', 'error'); return; }
    try {
      const q = await api(withMode(`/api/quote/${encodeURIComponent(state.chartSymbol)}`));
      $('#chart-symbol-label').textContent = q.symbol + (q.name ? ` · ${q.name}` : '');
      $('#chart-price').textContent = fmtMoneySm(q.price);
      const chg = q.change_pct ?? 0;
      const rsiHtml = q.rsi != null
        ? `<span class="rsi-chip ${q.rsi_label || 'neutral'}">RSI ${q.rsi.toFixed(0)}</span>`
        : '';
      // MACD chip: green if hist > 0 (bullish momentum), red if < 0
      const macdHtml = q.macd_hist != null
        ? `<span class="rsi-chip ${q.macd_hist >= 0 ? 'oversold' : 'overbought'}" title="MACD ${q.macd?.toFixed(2)} / signal ${q.macd_signal?.toFixed(2)}">MACD ${q.macd_hist >= 0 ? '+' : ''}${q.macd_hist.toFixed(2)}</span>`
        : '';
      // %B chip: where price sits within Bollinger Bands (>0.95 = upper, <0.05 = lower)
      let bbLabel = 'neutral';
      if (q.bb_pct != null) {
        if (q.bb_pct >= 0.95) bbLabel = 'overbought';
        else if (q.bb_pct <= 0.05) bbLabel = 'oversold';
      }
      const bbHtml = q.bb_pct != null
        ? `<span class="rsi-chip ${bbLabel}" title="Bollinger %B (0=lower band, 1=upper). Width ${q.bb_width?.toFixed(3)} (${q.bb_width < 0.04 ? 'squeeze!' : 'normal'})">%B ${(q.bb_pct * 100).toFixed(0)}</span>`
        : '';
      // Live bid/ask spread chip — only present when Crypto.com served the
      // quote (yfinance + CoinGecko don't expose L1 book).
      let spreadHtml = '';
      if (q.bid != null && q.ask != null && q.ask > q.bid) {
        const spreadPct = ((q.ask - q.bid) / q.ask) * 100;
        const tight = spreadPct < 0.05;
        spreadHtml = `<span class="rsi-chip ${tight ? 'oversold' : 'neutral'}"
          title="Best bid ${fmtMoneySm(q.bid)} · Best ask ${fmtMoneySm(q.ask)} · spread ${spreadPct.toFixed(3)}%">
          BID ${fmtMoneySm(q.bid)} / ASK ${fmtMoneySm(q.ask)}
        </span>`;
      }
      const srcHtml = q.source && q.source !== 'demo'
        ? `<span class="rsi-chip neutral" title="Data source for this quote">${q.source}</span>`
        : '';
      const sentLabel = q.sentiment_pct == null ? 'neutral'
        : q.sentiment_pct >= 70 ? 'oversold'       // green = bullish crowd
        : q.sentiment_pct <= 35 ? 'overbought'     // red = bearish crowd
        : 'neutral';
      const sentHtml = q.sentiment_pct != null
        ? `<span class="rsi-chip ${sentLabel}" title="CoinGecko community sentiment (% voting bullish, 1h cache)">SENT ${q.sentiment_pct.toFixed(0)}%</span>`
        : '';
      $('#chart-sub').innerHTML =
        `<span class="${chg >= 0 ? 'up' : 'down'}" style="color:${chg>=0?'var(--success)':'var(--danger)'}">${chg>=0?'▲':'▼'} ${fmtPct(chg)}</span>
         &nbsp; EMA21 ${fmtMoneySm(q.ema21)} · Stop MA ${fmtMoneySm(q.stop_loss)} · Stop ATR ${fmtMoneySm(q.stop_atr)} · ATR% ${q.atr_pct != null ? fmtPct(q.atr_pct) : '—'} · ${rsiHtml} ${macdHtml} ${bbHtml} ${sentHtml} ${spreadHtml} ${srcHtml} · <span class="sig-chip ${(q.signal||'hold').toLowerCase()}">${q.signal}</span>`;
      // Fetch news for the symbol (non-blocking)
      refreshNews(state.chartSymbol);
      // Fetch order book depth (non-blocking, hides itself if unsupported)
      refreshDepth(state.chartSymbol);

      const hist = q.history || [];
      const labels = hist.map(h => h.date);
      const base = {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Close', data: hist.map(h => h.close), borderColor: '#e7ecf5', backgroundColor: 'rgba(231,236,245,0.06)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.12 },
            // EMA colors mapped to Bleach motifs:
            // EMA 9  = Ichigo orange (fast spiritual energy)
            // EMA 21 = white (Hollow / Tensa wrap)
            // EMA 50 = bankai cyan
            // EMA 200 = Senbonzakura pink (slow & elegant)
            { label: 'EMA 9',   data: hist.map(h => h.ema9),   borderColor: '#ff6a00', borderWidth: 1.5, pointRadius: 0, tension: 0.15 },
            { label: 'EMA 21',  data: hist.map(h => h.ema21),  borderColor: '#ffffff', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            { label: 'EMA 50',  data: hist.map(h => h.ema50),  borderColor: '#00d4ff', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            { label: 'EMA 200', data: hist.map(h => h.ema200), borderColor: '#ff8aae', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            // Bollinger Bands — upper/mid/lower as a thin envelope (Senbonzakura pink, low alpha)
            { label: 'BB upper', data: hist.map(h => h.bb_upper), borderColor: 'rgba(179,136,255,0.45)', borderWidth: 1, pointRadius: 0, borderDash: [3,3] },
            { label: 'BB mid',   data: hist.map(h => h.bb_mid),   borderColor: 'rgba(179,136,255,0.25)', borderWidth: 1, pointRadius: 0 },
            { label: 'BB lower', data: hist.map(h => h.bb_lower), borderColor: 'rgba(179,136,255,0.45)', borderWidth: 1, pointRadius: 0, borderDash: [3,3] },
            { label: 'Stop',    data: hist.map(() => q.stop_loss),
              borderColor: '#cc1f33', borderWidth: 1, pointRadius: 0, borderDash: [6,5] },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: 'rgba(10,14,22,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1 },
          },
          scales: {
            x: { ticks: { color: '#5a6378', maxTicksLimit: 8, font: { family: 'JetBrains Mono' } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#5a6378', font: { family: 'JetBrains Mono' } }, grid: { color: 'rgba(255,255,255,0.04)' } },
          }
        }
      };
      if (!detailChart) detailChart = new Chart(ctx, base);
      else { detailChart.data = base.data; detailChart.options = base.options; detailChart.update('none'); }
    } catch (err) {
      toast(`Chart: ${err.message}`, 'error');
    }
  }

  // ---------- planner result -------------------------------------------------
  function renderPlannerResult(r, payload) {
    const card = $('#planner-result');
    card.hidden = false;
    $('#planner-sym').textContent = r.symbol;
    const sigEl = $('#planner-signal');
    sigEl.textContent = r.signal || 'HOLD';
    sigEl.className = 'sig-chip ' + (r.signal || 'hold').toLowerCase();
    $('#pr-shares').textContent = r.shares.toLocaleString('en-US', { maximumFractionDigits: 4 });
    $('#pr-value').textContent = fmtMoney(r.position_value);
    $('#pr-pct').textContent = r.pct_of_account.toFixed(2) + '%';
    $('#pr-entry').textContent = fmtMoneySm(r.price);
    $('#pr-stop').textContent = fmtMoneySm(r.stop) + '  (' + r.stop_label + ')';
    $('#pr-dist').textContent = fmtMoneySm(r.stop_distance) + '  (' + r.stop_distance_pct.toFixed(2) + '%)';
    $('#pr-risk').textContent = fmtMoney(r.risk_dollars);
    $('#pr-atr').textContent = (r.atr != null ? fmtMoneySm(r.atr) : '—') +
      '  /  ' + (r.atr_pct != null ? r.atr_pct.toFixed(2) + '%' : '—');

    const note = $('#planner-note');
    const parts = [];
    if (r.exceeds_account) {
      parts.push('⚠️ Position value exceeds account — would require leverage.');
      note.classList.add('warn');
    } else {
      note.classList.remove('warn');
    }
    parts.push(`Risk: ${fmtMoney(r.risk_dollars)} (${payload.risk_pct}% of ${fmtMoney(payload.account)}) capped by the stop at ${fmtMoneySm(r.stop)}.`);
    if (r.signal === 'SELL') parts.push('Overkill signal is SELL — entering a long here is counter-trend.');
    note.innerHTML = parts.map(escapeHtml).join(' ');
  }

  // ---------- watchlist ------------------------------------------------------
  // Server-backed add/remove.  Writes through to /api/portfolios/:id/watchlist
  // so the background signal-watcher can see the symbol.  Falls back to local-
  // storage if the request fails (offline mode).
  async function addToWatchlist(sym) {
    sym = String(sym || '').trim().toUpperCase();
    if (!sym) return;
    if (state.watchlist.includes(sym)) {
      toast(`${sym} already on watchlist`, 'info');
      return;
    }
    if (!state.currentPortfolioId) {
      // No portfolio yet — local-only fallback
      state.watchlist.push(sym);
      saveJSON('churnlence.watchlist', state.watchlist);
      refreshWatchlist();
      return;
    }
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/watchlist`,
        { method: 'POST', body: JSON.stringify({ symbol: sym }) });
      state.watchlist = (r.watchlist || []).map(w => w.symbol);
      saveJSON('churnlence.watchlist', state.watchlist);
      refreshWatchlist();
      toast(`${sym} added to watchlist`, 'success');
      Sound.ding();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeFromWatchlist(sym) {
    sym = String(sym || '').trim().toUpperCase();
    if (!sym) return;
    if (state.currentPortfolioId) {
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/watchlist/${encodeURIComponent(sym)}`,
                  { method: 'DELETE' });
      } catch (err) { /* keep local change anyway */ }
    }
    state.watchlist = state.watchlist.filter(s => s !== sym);
    delete state.watchData[sym];
    saveJSON('churnlence.watchlist', state.watchlist);
    Sound.click();
    refreshWatchlist();
  }

  // One-time migration: if the localStorage watchlist has symbols the server
  // doesn't yet know about, POST them.  Idempotent on the server (INSERT OR IGNORE).
  async function migrateWatchlistToServer() {
    if (!state.currentPortfolioId) return;
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/watchlist`);
      const server = new Set((r.watchlist || []).map(w => w.symbol));
      const local = state.watchlist || [];
      const missing = local.filter(s => !server.has(s));
      for (const sym of missing) {
        try {
          await api(`/api/portfolios/${state.currentPortfolioId}/watchlist`,
            { method: 'POST', body: JSON.stringify({ symbol: sym }) });
        } catch { /* skip invalid */ }
      }
      // Re-read from server so state is canonical
      const r2 = await api(`/api/portfolios/${state.currentPortfolioId}/watchlist`);
      state.watchlist = (r2.watchlist || []).map(w => w.symbol);
      saveJSON('churnlence.watchlist', state.watchlist);
    } catch (err) {
      console.warn('watchlist migration failed:', err);
    }
  }

  async function refreshWatchlist() {
    const grid = $('#watch-grid');
    if (!state.watchlist.length) {
      grid.innerHTML = '<div class="empty-row">Add a symbol to start watching.</div>';
      return;
    }
    const results = await Promise.allSettled(
      state.watchlist.map(s => api(withMode(`/api/quote/${encodeURIComponent(s)}`)))
    );
    grid.innerHTML = '';
    results.forEach((res, i) => {
      const sym = state.watchlist[i];
      if (res.status !== 'fulfilled') {
        grid.insertAdjacentHTML('beforeend',
          `<div class="watch-tile"><div class="wt-sym">${sym}</div><div class="wt-name">Not found</div></div>`);
        state.watchData[sym] = null;
        return;
      }
      const q = res.value;
      state.watchData[sym] = q;
      const chg = q.change_pct ?? 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const arrow = chg >= 0 ? '▲' : '▼';
      grid.insertAdjacentHTML('beforeend', `
        <div class="watch-tile" data-sym="${sym}">
          <span class="wt-sig"><span class="sig-chip ${(q.signal||'hold').toLowerCase()}">${q.signal}</span></span>
          <div class="wt-sym">${q.symbol}</div>
          <div class="wt-name">${escapeHtml(q.name || '')}</div>
          <div class="wt-px">${fmtMoneySm(q.price)}</div>
          <div class="wt-chg ${cls}">${arrow} ${fmtPct(chg)} · EMA21 ${fmtMoneySm(q.ema21)}</div>
          <button class="icon-btn wt-bell" data-walert="${sym}" title="Price / volume alerts">🔔</button>
          <button class="icon-btn wt-del" data-wdel="${sym}" title="Remove">✕</button>
        </div>`);
    });
    // bind
    $$('#watch-grid [data-wdel]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromWatchlist(btn.dataset.wdel);
      });
    });
    $$('#watch-grid [data-walert]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAlertRulesModal(btn.dataset.walert);
      });
    });
    $$('#watch-grid [data-sym]').forEach(tile => {
      tile.addEventListener('click', () => {
        state.chartSymbol = tile.dataset.sym;
        const sel = $('#chart-symbol-select');
        if (sel) sel.value = tile.dataset.sym;
        setTab('charts');
      });
    });
  }

  // ---------- actions --------------------------------------------------------
  async function refreshOnce() {
    if (!state.currentPortfolioId) return;
    const snap = await api(withMode(`/api/portfolios/${state.currentPortfolioId}/holdings`));
    applySnapshot(snap);
  }

  function openModal(id) { $(`#${id}`).hidden = false; }
  function closeModal(id) { $(`#${id}`).hidden = true; }

  // ---------- sell / close position ------------------------------------------
  function openSellModal(symbol) {
    const rows = (state.snapshot?.rows || []).filter(r => r.symbol === symbol && !r.error);
    if (!rows.length) { toast(`No holdings of ${symbol}`, 'error'); return; }
    const totalShares = rows.reduce((s, r) => s + (r.shares || 0), 0);
    const last = rows[0].price || 0;
    $('#sell-symbol').textContent = symbol;
    $('#sell-holdings').textContent = `${fmtNum(totalShares)} shares held · last ${fmtMoneySm(last)}`;
    const form = $('#sell-form');
    form.elements.shares.value = totalShares;
    form.elements.shares.max = totalShares;
    form.elements.sell_price.value = last || '';
    form.elements.sell_price.dataset.last = String(last || '');
    $('#sell-error').textContent = '';
    form.dataset.symbol = symbol;
    openModal('sell-modal');
    setTimeout(() => form.elements.shares.select(), 50);
  }

  async function refreshTransactions() {
    if (!state.currentPortfolioId) return;
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/transactions`);
      renderTransactions(r.transactions || [], r.total_realized || 0);
    } catch (err) { /* non-fatal */ }
  }

  // Pulls active theses + alert rules and renders a compact summary on the
  // Signals tab — the user gets a single place to glance "what custom rules
  // do I have wired into the watcher?"  Editing happens via the per-symbol
  // 📋/🔔 entry points; this view is read+toggle+delete only.
  async function refreshThesesRules() {
    if (!state.currentPortfolioId) return;
    const host = $('#theses-rules-host');
    if (!host) return;
    try {
      const [t, r] = await Promise.all([
        api(`/api/portfolios/${state.currentPortfolioId}/theses`),
        api(`/api/portfolios/${state.currentPortfolioId}/alert-rules`),
      ]);
      const theses = t.theses || [];
      const rules  = r.rules  || [];
      $('#theses-rules-sub').textContent =
        `${theses.length} theses · ${rules.length} alert rules`;
      if (!theses.length && !rules.length) {
        host.innerHTML = `
          <div class="empty-row" style="padding:8px 0;">
            Nothing custom yet — click 📋 on a holding (Custom thesis) or 🔔 on a
            watchlist tile (Alert rules) to add some.
          </div>`;
        return;
      }
      const fmtRuleVal = p =>
        p.value     != null ? `$${p.value}` :
        p.pct       != null ? `${p.pct}%` :
        p.threshold != null ? `${p.threshold}×` : '';
      const thesisHtml = theses.length ? `
        <h3 style="margin: 4px 0 8px; font-size: 13px;">Theses</h3>
        ${theses.map(th => {
          const summary = [...(th.buy_rules || []).map(g => 'BUY ' + (g.conds||[]).map(c => `${c.indicator} ${c.op} ${c.value}`).join(' & ')),
                           ...(th.sell_rules || []).map(g => 'SELL ' + (g.conds||[]).map(c => `${c.indicator} ${c.op} ${c.value}`).join(' & '))].join(' · ');
          return `
            <div class="rule-row">
              <span class="rule-kind ${th.enabled ? '' : 'off'}">
                <strong>${th.symbol}</strong> · ${escapeHtml(th.name)}
                <span style="color: var(--ink-mute); font-size:11px;"> — ${escapeHtml(summary || 'no rules')}</span>
              </span>
              <span class="rule-last">${th.last_fired_signal ? 'last ' + th.last_fired_signal : 'idle'}</span>
              <button class="link-btn" data-th-edit="${th.symbol}">edit</button>
              <button class="link-btn" data-th-toggle="${th.id}" data-on="${th.enabled?1:0}">${th.enabled ? 'disable' : 'enable'}</button>
            </div>`;
        }).join('')}` : '';
      const ruleHtml = rules.length ? `
        <h3 style="margin: 12px 0 8px; font-size: 13px;">Alert rules</h3>
        ${rules.map(rule => `
          <div class="rule-row">
            <span class="rule-kind ${rule.enabled ? '' : 'off'}">
              <strong>${rule.symbol}</strong> · ${rule.kind} ${fmtRuleVal(rule.params)}
            </span>
            <span class="rule-last">${rule.last_fired_at ? 'last ' + (rule.last_fired_at.split('T')[0]) : 'idle'}</span>
            <button class="link-btn" data-r-edit="${rule.symbol}">edit</button>
            <button class="link-btn" data-r-toggle="${rule.id}" data-on="${rule.enabled?1:0}">${rule.enabled ? 'disable' : 'enable'}</button>
          </div>`).join('')}` : '';
      host.innerHTML = thesisHtml + ruleHtml;
      $$('[data-th-edit]', host).forEach(b => b.addEventListener('click',
        () => openThesisModal(b.dataset.thEdit)));
      $$('[data-th-toggle]', host).forEach(b => b.addEventListener('click', async () => {
        const next = b.dataset.on === '1' ? false : true;
        try {
          await api(`/api/portfolios/${state.currentPortfolioId}/theses/${b.dataset.thToggle}`,
            { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
          refreshThesesRules();
          refreshOnce();
        } catch (err) { toast(err.message, 'error'); }
      }));
      $$('[data-r-edit]', host).forEach(b => b.addEventListener('click',
        () => openAlertRulesModal(b.dataset.rEdit)));
      $$('[data-r-toggle]', host).forEach(b => b.addEventListener('click', async () => {
        const next = b.dataset.on === '1' ? false : true;
        try {
          await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules/${b.dataset.rToggle}`,
            { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
          refreshThesesRules();
        } catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) {
      host.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderTransactions(txs, totalRealized) {
    const tbody = $('#transactions-body');
    $('#realized-sub').textContent = `${txs.length} sells · ${fmtMoney(totalRealized)} realized`;
    if (!txs.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No sells recorded yet — close a position from Holdings to start the tax log.</td></tr>';
      return;
    }
    tbody.innerHTML = txs.map(t => {
      const plUp = (t.realized_pl || 0) >= 0;
      const d = (t.sold_at || '').split('T')[0] || (t.sold_at || '').split(' ')[0] || t.sold_at || '';
      return `
        <tr>
          <td>${escapeHtml(d)}</td>
          <td><span class="sym">${t.symbol}</span></td>
          <td>${t.method}</td>
          <td class="num">${fmtNum(t.shares)}</td>
          <td class="num">${fmtMoneySm(t.cost_basis)}</td>
          <td class="num">${fmtMoneySm(t.sell_price)}</td>
          <td class="num">${fmtMoney(t.proceeds)}</td>
          <td class="num ${plUp ? 'up' : 'down'}">${fmtMoney(t.realized_pl)}</td>
        </tr>`;
    }).join('');
  }

  // ---------- CSV export -----------------------------------------------------
  function exportCsv() {
    const rows = state.snapshot?.rows || [];
    if (!rows.length) { toast('Nothing to export', 'info'); return; }
    const header = 'Symbol,Shares,Cost Basis,Price,Value,P/L,Signal';
    const body = rows.map(r =>
      [r.symbol, r.shares, r.cost_basis, r.price, r.value, r.pl, r.signal].join(',')
    ).join('\n');
    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = (state.portfolios.find(p => p.id === state.currentPortfolioId)?.name || 'portfolio').replace(/\s+/g, '-');
    a.href = url;
    a.download = `churnlence-${name}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported', 'success');
  }

  // ---------- event wiring ---------------------------------------------------
  function applyMode() {
    const tg = $('#mode-toggle');
    if (!tg) return;
    $$('button', tg).forEach(b => {
      const on = b.dataset.mode === state.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    document.body.classList.toggle('mode-day', state.mode === 'day');
    document.body.classList.toggle('mode-swing', state.mode === 'swing');
  }
  function setMode(next) {
    if (next !== 'day' && next !== 'swing') return;
    if (state.mode === next) return;
    state.mode = next;
    saveJSON('churnlence.mode', next);
    applyMode();
    // Reset render hashes so the snapshot UI redraws with new signal text/colors
    Object.keys(renderHashes || {}).forEach(k => delete renderHashes[k]);
    toast(`Switched to ${next === 'day' ? 'Day-trade' : 'Swing'} mode`, 'info');
    Sound.click();
    openStream();   // re-open SSE with new mode
    refreshOnce();
    refreshWatchlist();
    if (state.chartSymbol) renderDetailChart();
  }

  // ---------- memecoin scanner ---------------------------------------------
  const scannerState = {
    view: 'trending',  // 'trending' | 'new'
    network: 'solana',
    minLiq: 25000,
    pools: [],
    loadedAt: 0,
  };

  async function refreshScanner(force = false) {
    const tbody = $('#scanner-body');
    if (!tbody) return;
    // Cache for 30s on the client too
    if (!force && Date.now() - scannerState.loadedAt < 30_000 && scannerState.pools.length) {
      renderScanner(scannerState.pools);
      return;
    }
    tbody.innerHTML = '<tr class="empty-row"><td colspan="11">Loading…</td></tr>';
    try {
      const r = await api(`/api/scanner/${scannerState.view}?network=${scannerState.network}&min_liq=${scannerState.minLiq}`);
      scannerState.pools = r.pools || [];
      scannerState.loadedAt = Date.now();
      renderScanner(scannerState.pools);
    } catch (err) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="11" style="color:var(--danger)">Scanner failed: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderScanner(pools) {
    const tbody = $('#scanner-body');
    if (!pools.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="11">No pools matched. Lower the min liquidity filter or try a different network.</td></tr>';
      return;
    }
    const fmtCompact = v => {
      if (v == null) return '—';
      const a = Math.abs(v);
      if (a >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
      if (a >= 1e6) return '$' + (v/1e6).toFixed(2) + 'M';
      if (a >= 1e3) return '$' + (v/1e3).toFixed(1) + 'K';
      return '$' + v.toFixed(2);
    };
    const arrow = v => v >= 0 ? '▲' : '▼';
    const cls = v => v >= 0 ? 'up' : 'down';
    tbody.innerHTML = pools.map(p => {
      const sigBadge = p.score > 50 ? '<span class="ac-tag" style="background:rgba(0,255,156,0.15);color:#00ff9c;">HOT</span>'
                     : p.score > 15 ? '<span class="ac-tag">warm</span>'
                     : '';
      return `
        <tr data-sym="${escapeHtml(p.symbol)}" data-pool="${escapeHtml(p.pool_address)}">
          <td>
            <span class="sym">${escapeHtml(p.symbol || '?')}</span>
            <span class="sym-name">${escapeHtml((p.name || '').slice(0, 28))} ${sigBadge}</span>
          </td>
          <td class="num">${p.score.toFixed(0)}</td>
          <td class="num">${p.price_usd != null ? p.price_usd.toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '—'}</td>
          <td class="num ${cls(p.change_1h)}">${arrow(p.change_1h)} ${p.change_1h.toFixed(1)}%</td>
          <td class="num ${cls(p.change_6h)}">${arrow(p.change_6h)} ${p.change_6h.toFixed(1)}%</td>
          <td class="num ${cls(p.change_24h)}">${arrow(p.change_24h)} ${p.change_24h.toFixed(1)}%</td>
          <td class="num">${fmtCompact(p.volume_24h)}</td>
          <td class="num">${fmtCompact(p.liquidity)}</td>
          <td class="num"><span class="up">${p.buys_24h}</span> / <span class="down">${p.sells_24h}</span></td>
          <td><span style="font-size:11px;color:var(--ink-mute);text-transform:uppercase;">${escapeHtml(p.dex)}</span></td>
          <td class="num row-actions">
            <a class="row-act" href="${escapeHtml(p.dexscreener_url)}" target="_blank" rel="noopener" title="Open on DexScreener">View</a>
            <button class="row-act" data-watch="${escapeHtml(p.symbol)}" title="Add to watchlist">Watch</button>
          </td>
        </tr>`;
    }).join('');

    $$('#scanner-body [data-watch]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.watch + '-USD';
        if (state.watchlist.includes(sym)) { toast(`${sym} already on watchlist`, 'info'); return; }
        state.watchlist.push(sym);
        saveJSON('churnlence.watchlist', state.watchlist);
        refreshWatchlist();
        toast(`${sym} added to watchlist`, 'success');
        Sound.ding();
      });
    });
  }

  function bind() {
    // mode toggle
    const tg = $('#mode-toggle');
    if (tg) {
      $$('button', tg).forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
      applyMode();
    }
    // tabs
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      Sound.click();
      setTab(t.dataset.tab);
    }));
    window.addEventListener('resize', moveTabUnderline);

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      const map = { '1':'overview','2':'holdings','3':'charts','4':'signals','5':'watchlist','6':'planner','7':'backtest','8':'scanner' };
      if (map[e.key]) { setTab(map[e.key]); Sound.click(); }
      else if (e.key.toLowerCase() === 'n') { openModal('add-holding-modal'); Sound.click(); }
      else if (e.key.toLowerCase() === 'm') toggleSound();
    });

    // unlock audio on first user gesture
    const unlock = () => { Sound.unlock(); document.removeEventListener('click', unlock); };
    document.addEventListener('click', unlock);

    // sound toggle
    $('#sound-toggle').addEventListener('click', toggleSound);
    applySoundIcon();

    // desktop notifications toggle
    const notifyBtn = $('#notify-toggle');
    if (notifyBtn) {
      notifyBtn.addEventListener('click', toggleNotify);
      applyNotifyIcon();
    }

    // portfolio switcher
    $('#portfolio-select').addEventListener('change', (e) => {
      state.currentPortfolioId = parseInt(e.target.value, 10);
      openStream();
      refreshOnce();
      refreshTransactions();
    });

    // new portfolio
    $('#new-portfolio-btn').addEventListener('click', () => { openModal('new-portfolio-modal'); Sound.click(); });
    $('#new-portfolio-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      const err = $('#new-portfolio-error');
      err.textContent = '';
      try {
        const p = await api('/api/portfolios', { method: 'POST', body: JSON.stringify({ name }) });
        await loadPortfolios();
        state.currentPortfolioId = p.id;
        $('#portfolio-select').value = p.id;
        closeModal('new-portfolio-modal');
        e.target.reset();
        openStream(); refreshOnce();
        toast(`Portfolio "${name}" created`, 'success');
        Sound.ding();
      } catch (ex) { err.textContent = ex.message; Sound.alert(); }
    });

    // autocomplete wiring
    const symInput = $('#symbol-input');
    const symPreview = $('#symbol-preview');
    const symList = $('#symbol-suggestions');
    if (symInput) {
      symInput.addEventListener('input', () => {
        const q = symInput.value.trim();
        symPreview.textContent = '';
        clearTimeout(acDebounce);
        if (q.length < 1) { symList.hidden = true; symList.innerHTML = ''; return; }
        acDebounce = setTimeout(async () => {
          const items = await fetchSuggestions(q);
          renderSuggestions(items);
        }, 120);
      });
      symInput.addEventListener('keydown', (e) => {
        const items = symList.querySelectorAll('li');
        if (!items.length) {
          if (e.key === 'Enter' && symInput.value.trim()) {
            // commit raw symbol and fetch price
            autoFillCurrentPrice(symInput.value.trim().toUpperCase());
          }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          acActiveIdx = (acActiveIdx + 1) % items.length;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          acActiveIdx = (acActiveIdx - 1 + items.length) % items.length;
        } else if (e.key === 'Enter' && acActiveIdx >= 0) {
          e.preventDefault();
          pickSuggestion(items[acActiveIdx].dataset.symbol);
          return;
        } else if (e.key === 'Escape') {
          symList.hidden = true;
          return;
        } else {
          return;
        }
        items.forEach(li => li.classList.remove('active'));
        items[acActiveIdx].classList.add('active');
        items[acActiveIdx].scrollIntoView({ block: 'nearest' });
      });
      symInput.addEventListener('blur', () => {
        // delay so mousedown on suggestion can fire first
        setTimeout(() => { symList.hidden = true; }, 150);
      });
      symInput.addEventListener('change', () => {
        const v = symInput.value.trim().toUpperCase();
        if (v) autoFillCurrentPrice(v);
      });
    }

    // "Use last" in cost basis
    const useLastBtn = $('#use-current-price');
    if (useLastBtn) {
      useLastBtn.addEventListener('click', () => {
        const costInput = $('#cost-basis-input');
        const sym = symInput.value.trim().toUpperCase();
        if (!sym) return toast('Enter a symbol first', 'info');
        autoFillCurrentPrice(sym).then(() => {
          if (costInput.dataset.last) costInput.value = costInput.dataset.last;
        });
        Sound.click();
      });
    }

    // add holding
    $('#add-holding-btn').addEventListener('click', () => { openModal('add-holding-modal'); Sound.click(); });
    $('#add-holding-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const symbol = f.symbol.value.trim().toUpperCase();
      let cost = parseFloat(f.cost_basis.value);
      const err = $('#add-holding-error');
      err.textContent = '';
      // if cost missing, backfill with the current price preview
      if (!Number.isFinite(cost) || cost <= 0) {
        const preview = $('#cost-basis-input').dataset.last;
        if (preview) cost = parseFloat(preview);
      }
      const payload = {
        symbol,
        shares: parseFloat(f.shares.value),
        cost_basis: cost,
        note: f.note.value.trim() || null,
      };
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/holdings`,
          { method: 'POST', body: JSON.stringify(payload) });
        closeModal('add-holding-modal');
        e.target.reset();
        $('#symbol-preview').textContent = '';
        $('#cost-basis-input').removeAttribute('data-last');
        await refreshOnce();
        toast(`${symbol} added`, 'success');
        Sound.ding();
      } catch (ex) { err.textContent = ex.message; Sound.alert(); }
    });

    // modal close
    $$('[data-close]').forEach(el => el.addEventListener('click', () => {
      $$('.modal-backdrop').forEach(b => b.hidden = true);
      Sound.click();
    }));
    $$('.modal-backdrop').forEach(b => b.addEventListener('click', (e) => {
      if (e.target === b) { b.hidden = true; Sound.click(); }
    }));

    // watchlist form
    $('#watch-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const sym = $('#watch-input').value.trim().toUpperCase();
      if (!sym) return;
      $('#watch-input').value = '';
      await addToWatchlist(sym);
    });
    // "+ Add coin" CTA in the Watchlist tab header — focuses the input
    const addCoinBtn = $('#watch-add-coin-btn');
    if (addCoinBtn) {
      addCoinBtn.addEventListener('click', () => {
        setTab('watchlist');
        const inp = $('#watch-input');
        if (inp) { inp.focus(); inp.select(); }
      });
    }

    // planner: show/hide fields per stop_method
    const plannerForm = $('#planner-form');
    if (plannerForm) {
      // restore saved defaults
      const d = state.plannerDefaults || {};
      if (d.account) plannerForm.elements.account.value = d.account;
      if (d.risk_pct) plannerForm.elements.risk_pct.value = d.risk_pct;
      if (d.stop_method) plannerForm.elements.stop_method.value = d.stop_method;
      if (d.atr_multiplier) plannerForm.elements.atr_multiplier.value = d.atr_multiplier;
      const stopSelect = plannerForm.elements.stop_method;
      const syncPlannerFields = () => {
        $$('label[data-stop]', plannerForm).forEach(l => {
          l.hidden = l.dataset.stop !== stopSelect.value;
        });
      };
      stopSelect.addEventListener('change', syncPlannerFields);
      syncPlannerFields();
      // persist on any change
      plannerForm.addEventListener('change', () => {
        const fe = plannerForm.elements;
        saveJSON('churnlence.planner', {
          account: parseFloat(fe.account.value) || 0,
          risk_pct: parseFloat(fe.risk_pct.value) || 0,
          stop_method: fe.stop_method.value,
          atr_multiplier: parseFloat(fe.atr_multiplier.value) || 2,
        });
      });

      plannerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        const payload = {
          symbol: f.symbol.value.trim().toUpperCase(),
          account: parseFloat(f.account.value),
          risk_pct: parseFloat(f.risk_pct.value),
          stop_method: f.stop_method.value,
          atr_multiplier: parseFloat(f.atr_multiplier.value || 2),
          custom_stop: f.custom_stop ? parseFloat(f.custom_stop.value || 0) : null,
        };
        const err = $('#planner-error');
        err.textContent = '';
        try {
          const r = await api('/api/position-size', { method: 'POST', body: JSON.stringify(payload) });
          renderPlannerResult(r, payload);
          Sound.ding();
        } catch (ex) {
          err.textContent = ex.message;
          $('#planner-result').hidden = true;
          Sound.alert();
        }
      });
    }

    // sort
    $$('#holdings-table th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir *= -1;
        else { state.sortKey = k; state.sortDir = -1; }
        if (state.snapshot) renderHoldings(state.snapshot);
        Sound.click();
      });
    });

    // chart symbol select
    $('#chart-symbol-select').addEventListener('change', (e) => {
      state.chartSymbol = e.target.value;
      renderDetailChart();
    });

    // scanner
    $$('#scanner-view-tabs button').forEach(b => b.addEventListener('click', () => {
      $$('#scanner-view-tabs button').forEach(x => x.classList.toggle('active', x === b));
      scannerState.view = b.dataset.view;
      refreshScanner(true);
    }));
    const netSel = $('#scanner-network');
    if (netSel) netSel.addEventListener('change', (e) => {
      scannerState.network = e.target.value;
      refreshScanner(true);
    });
    const liqSel = $('#scanner-minliq');
    if (liqSel) liqSel.addEventListener('change', (e) => {
      scannerState.minLiq = parseInt(e.target.value, 10);
      refreshScanner(true);
    });
    const refreshBtn = $('#scanner-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshScanner(true));

    // ----- sell modal -----
    $('#sell-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const symbol = f.dataset.symbol;
      const payload = {
        symbol,
        shares: parseFloat(f.elements.shares.value),
        sell_price: parseFloat(f.elements.sell_price.value),
        method: f.elements.method.value,
      };
      const err = $('#sell-error');
      err.textContent = '';
      try {
        const r = await api(`/api/portfolios/${state.currentPortfolioId}/sell`,
          { method: 'POST', body: JSON.stringify(payload) });
        closeModal('sell-modal');
        const pl = r.realized_pl || 0;
        toast(`${symbol}: sold ${r.shares} @ ${fmtMoneySm(r.sell_price)} · realized ${fmtMoney(pl)}`,
          pl >= 0 ? 'success' : 'info', 5000);
        await refreshOnce();
        await refreshTransactions();
        Sound.ding();
      } catch (ex) { err.textContent = ex.message; Sound.alert(); }
    });
    $('#sell-use-last').addEventListener('click', () => {
      const inp = $('#sell-price-input');
      if (inp.dataset.last) inp.value = inp.dataset.last;
    });

    // ----- import CSV -----
    $('#import-csv-btn').addEventListener('click', () => { openModal('import-csv-modal'); Sound.click(); });
    $('#import-csv-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = $('#import-csv-file');
      const textInput = $('#import-csv-text');
      const err = $('#import-csv-error');
      err.textContent = '';
      let payload = null;
      let opts = { method: 'POST' };
      if (fileInput.files.length) {
        const fd = new FormData();
        fd.append('file', fileInput.files[0]);
        opts.body = fd;  // no Content-Type header — let browser set multipart boundary
        opts.headers = {};
      } else if (textInput.value.trim()) {
        payload = { csv: textInput.value };
        opts.body = JSON.stringify(payload);
        opts.headers = { 'Content-Type': 'application/json' };
      } else {
        err.textContent = 'Attach a CSV file or paste CSV text.';
        return;
      }
      try {
        const r = await fetch(`/api/portfolios/${state.currentPortfolioId}/import`, opts);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Import failed');
        const added = data.added?.length || 0;
        const errs = data.errors?.length || 0;
        toast(`Imported ${added} position${added===1?'':'s'}${errs?` · ${errs} error${errs===1?'':'s'}`:''}`, added ? 'success' : 'info', 5000);
        if (errs && data.errors[0]) console.warn('import errors', data.errors);
        closeModal('import-csv-modal');
        e.target.reset();
        $('#import-csv-text').value = '';
        await refreshOnce();
        Sound.ding();
      } catch (ex) { err.textContent = ex.message; Sound.alert(); }
    });

    // ----- portfolio menu (rename / delete / alerts / import / export) -----
    const pmBtn = $('#portfolio-menu-btn');
    const pmMenu = $('#portfolio-menu');
    if (pmBtn) {
      pmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pmMenu.hidden = !pmMenu.hidden;
      });
      document.addEventListener('click', (e) => {
        if (!pmMenu.hidden && !pmMenu.contains(e.target) && e.target !== pmBtn) pmMenu.hidden = true;
      });
      pmMenu.addEventListener('click', async (e) => {
        const action = e.target.dataset?.pm;
        if (!action) return;
        pmMenu.hidden = true;
        if (action === 'rename') {
          const p = state.portfolios.find(x => x.id === state.currentPortfolioId);
          $('#rename-portfolio-form').elements.name.value = p ? p.name : '';
          $('#rename-portfolio-error').textContent = '';
          openModal('rename-portfolio-modal');
        } else if (action === 'delete') {
          if (!confirm('Delete this portfolio and all its holdings + transactions? This cannot be undone.')) return;
          try {
            await api(`/api/portfolios/${state.currentPortfolioId}`, { method: 'DELETE' });
            toast('Portfolio deleted', 'success');
            state.currentPortfolioId = null;
            await loadPortfolios();
            state.currentPortfolioId = state.portfolios[0]?.id || null;
            if (state.currentPortfolioId) $('#portfolio-select').value = state.currentPortfolioId;
            openStream(); refreshOnce(); refreshTransactions();
          } catch (ex) { toast(ex.message, 'error'); }
        } else if (action === 'alerts') {
          openAlertsModal();
        } else if (action === 'import') {
          openModal('import-csv-modal');
        } else if (action === 'export') {
          exportCsv();
        }
      });
    }

    $('#rename-portfolio-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      const err = $('#rename-portfolio-error');
      err.textContent = '';
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}`,
          { method: 'PATCH', body: JSON.stringify({ name }) });
        await loadPortfolios();
        $('#portfolio-select').value = state.currentPortfolioId;
        closeModal('rename-portfolio-modal');
        toast(`Renamed to "${name}"`, 'success');
      } catch (ex) { err.textContent = ex.message; Sound.alert(); }
    });

    // ----- alerts (email prefs) -----
    async function openAlertsModal() {
      try {
        const p = await api(`/api/portfolios/${state.currentPortfolioId}/alerts`);
        const f = $('#alerts-form');
        f.elements.email.value = p.email || '';
        f.elements.enabled.checked = !!p.enabled;
        f.elements.daily_digest.checked = !!p.daily_digest;
        f.elements.digest_hour_utc.value = String(p.digest_hour_utc ?? 13);
        if (f.elements.discord_webhook) f.elements.discord_webhook.value = p.discord_webhook || '';
        if (f.elements.discord_enabled) f.elements.discord_enabled.checked = !!p.discord_enabled;
        if (f.elements.telegram_bot_token) f.elements.telegram_bot_token.value = p.telegram_bot_token || '';
        if (f.elements.telegram_chat_id)   f.elements.telegram_chat_id.value   = p.telegram_chat_id   || '';
        if (f.elements.telegram_enabled)   f.elements.telegram_enabled.checked = !!p.telegram_enabled;
        const status = $('#alerts-status');
        status.style.color = '';
        const lines = [];
        if (p.smtp_configured) {
          lines.push('SMTP is configured — alerts will send.');
          if (p.last_digest_date) lines.push(`Last digest sent: ${p.last_digest_date}.`);
        } else {
          lines.push('SMTP is NOT configured on the server. Set SMTP_HOST / SMTP_USER / SMTP_PASS env vars to enable sending — you can still save the preference.');
          status.style.color = '#ffb84d';
        }
        status.textContent = lines.join(' ');
        $('#digest-preview-out').hidden = true;
        $('#digest-preview-out').textContent = '';
        openModal('alerts-modal');
      } catch (ex) { toast(ex.message, 'error'); }
    }
    $('#alerts-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const payload = {
        email: f.email.value.trim(),
        enabled: f.enabled.checked,
        daily_digest: f.daily_digest.checked,
        digest_hour_utc: parseInt(f.digest_hour_utc.value, 10),
        discord_webhook: f.discord_webhook ? f.discord_webhook.value.trim() : '',
        discord_enabled: f.discord_enabled ? f.discord_enabled.checked : false,
        telegram_bot_token: f.telegram_bot_token ? f.telegram_bot_token.value.trim() : '',
        telegram_chat_id:   f.telegram_chat_id   ? f.telegram_chat_id.value.trim()   : '',
        telegram_enabled:   f.telegram_enabled   ? f.telegram_enabled.checked        : false,
      };
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/alerts`,
          { method: 'POST', body: JSON.stringify(payload) });
        closeModal('alerts-modal');
        const bits = [];
        if (payload.enabled) bits.push('per-signal');
        if (payload.daily_digest) bits.push('daily digest');
        toast(bits.length ? `Alerts saved (${bits.join(' + ')})` : 'Alerts disabled', 'success');
      } catch (ex) { toast(ex.message, 'error'); }
    });

    $('#digest-preview-btn')?.addEventListener('click', async () => {
      const out = $('#digest-preview-out');
      out.hidden = false;
      out.textContent = 'Loading…';
      try {
        const r = await api(`/api/portfolios/${state.currentPortfolioId}/digest/preview`);
        out.textContent = r.body || '(empty)';
      } catch (ex) { out.textContent = `Error: ${ex.message}`; }
    });

    $('#digest-send-btn')?.addEventListener('click', async () => {
      // Save current settings first so the email used is the one in the form.
      const f = $('#alerts-form').elements;
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/alerts`, {
          method: 'POST',
          body: JSON.stringify({
            email: f.email.value.trim(),
            enabled: f.enabled.checked,
            daily_digest: f.daily_digest.checked,
            digest_hour_utc: parseInt(f.digest_hour_utc.value, 10),
          }),
        });
        const r = await api(`/api/portfolios/${state.currentPortfolioId}/digest/send`,
          { method: 'POST' });
        toast(`Digest emailed to ${r.to}`, 'success', 5000);
      } catch (ex) { toast(ex.message, 'error', 5000); }
    });

    $('#kelly-refresh-btn')?.addEventListener('click', refreshKelly);

    // Save current modal state then post to the channel's test endpoint so
    // the user can verify their config without leaving the modal.  Shared
    // helper because Telegram and Discord follow the same pattern.
    async function saveAlertsThenTest(channel) {
      const f = $('#alerts-form').elements;
      const payload = {
        email: f.email.value.trim(),
        enabled: f.enabled.checked,
        daily_digest: f.daily_digest.checked,
        digest_hour_utc: parseInt(f.digest_hour_utc.value, 10),
        discord_webhook: f.discord_webhook ? f.discord_webhook.value.trim() : '',
        discord_enabled: f.discord_enabled ? f.discord_enabled.checked : false,
        telegram_bot_token: f.telegram_bot_token ? f.telegram_bot_token.value.trim() : '',
        telegram_chat_id:   f.telegram_chat_id   ? f.telegram_chat_id.value.trim()   : '',
        telegram_enabled:   f.telegram_enabled   ? f.telegram_enabled.checked        : false,
      };
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/alerts`,
          { method: 'POST', body: JSON.stringify(payload) });
        await api(`/api/portfolios/${state.currentPortfolioId}/${channel}/test`,
          { method: 'POST' });
        toast(`${channel[0].toUpperCase()+channel.slice(1)} test ping sent`, 'success');
      } catch (ex) { toast(ex.message, 'error'); }
    }
    $('#discord-test-btn') ?.addEventListener('click', () => saveAlertsThenTest('discord'));
    $('#telegram-test-btn')?.addEventListener('click', () => saveAlertsThenTest('telegram'));

    // ----- backtest -----
    $('#backtest-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const payload = {
        symbol: f.symbol.value.trim().toUpperCase(),
        starting_cash: parseFloat(f.starting_cash.value),
        years: parseFloat(f.years.value),
      };
      const err = $('#backtest-error');
      err.textContent = '';
      try {
        const r = await api('/api/backtest', { method: 'POST', body: JSON.stringify(payload) });
        renderBacktest(r);
        Sound.ding();
      } catch (ex) {
        err.textContent = ex.message;
        Sound.alert();
        $('#backtest-summary').hidden = true;
        $('#backtest-chart-card').hidden = true;
        $('#backtest-trades-card').hidden = true;
      }
    });
  }

  // ---------- backtest rendering --------------------------------------------
  let backtestChart = null;
  function renderBacktest(r) {
    $('#backtest-summary').hidden = false;
    $('#backtest-chart-card').hidden = false;
    $('#backtest-trades-card').hidden = false;
    $('#bt-symbol').textContent = r.symbol;
    $('#bt-window').textContent = `${r.from} → ${r.to} · ${r.bars} bars`;
    const up = r.strategy_return_pct >= 0;
    const diffUp = r.outperformance_pct >= 0;
    const stratEl = $('#bt-strat'); stratEl.textContent = fmtPct(r.strategy_return_pct); stratEl.className = 'n-val ' + (up?'up':'down');
    $('#bt-bh').textContent = fmtPct(r.buy_hold_return_pct);
    const diffEl = $('#bt-diff'); diffEl.textContent = (diffUp?'+':'') + r.outperformance_pct.toFixed(2) + '%'; diffEl.className = 'n-val ' + (diffUp?'up':'down');
    $('#bt-final').textContent = fmtMoney(r.final_equity);
    $('#bt-trips').textContent = String(r.round_trips);
    $('#bt-winrate').textContent = r.win_rate_pct.toFixed(1) + '%';

    // equity curve
    const ctx = $('#backtest-chart');
    if (ctx && typeof Chart !== 'undefined') {
      const labels = r.equity_curve.map(p => p.date);
      const equity = r.equity_curve.map(p => p.equity);
      const bhStart = r.equity_curve[0]?.price || 1;
      const bhShares = r.starting_cash / bhStart;
      const bh = r.equity_curve.map(p => p.price * bhShares);
      const cfg = {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Strategy', data: equity, borderColor: '#00e5ff', backgroundColor: 'rgba(0,229,255,0.08)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.1 },
            { label: 'Buy & Hold', data: bh, borderColor: '#b388ff', borderWidth: 1.5, pointRadius: 0, tension: 0.1, borderDash: [6,5] },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: true, labels: { color: '#9aa3b2' } } },
          scales: {
            x: { ticks: { color: '#5a6378', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#5a6378' }, grid: { color: 'rgba(255,255,255,0.04)' } },
          }
        }
      };
      if (!backtestChart) backtestChart = new Chart(ctx, cfg);
      else { backtestChart.data = cfg.data; backtestChart.options = cfg.options; backtestChart.update('none'); }
    }

    const body = $('#backtest-trades-body');
    $('#bt-trades-count').textContent = `${r.trades.length} execution${r.trades.length===1?'':'s'}`;
    if (!r.trades.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="5">No signals triggered in the selected window.</td></tr>';
    } else {
      body.innerHTML = r.trades.map(t => `
        <tr>
          <td>${t.date}</td>
          <td><span class="sig-chip ${t.action === 'BUY' ? 'buy' : 'sell'}">${t.action}</span></td>
          <td class="num">${fmtMoneySm(t.price)}</td>
          <td class="num">${fmtNum(t.shares)}</td>
          <td class="num">${fmtMoney(t.cost || t.proceeds || 0)}</td>
        </tr>`).join('');
    }
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    saveJSON('churnlence.sound', state.soundOn);
    applySoundIcon();
    if (state.soundOn) Sound.ding();
  }
  function applySoundIcon() {
    const btn = $('#sound-toggle');
    btn.textContent = state.soundOn ? '🔔' : '🔕';
    btn.classList.toggle('muted', !state.soundOn);
    btn.title = state.soundOn ? 'Mute (M)' : 'Unmute (M)';
  }

  async function toggleNotify() {
    const btn = $('#notify-toggle');
    if (!Notify.supported) { toast('This browser does not support desktop notifications.', 'error'); return; }
    if (state.notifyOn) {
      state.notifyOn = false;
      saveJSON('churnlence.notify', false);
      applyNotifyIcon();
      toast('Desktop notifications off', 'info');
      return;
    }
    const res = await Notify.request();
    if (res === 'granted') {
      state.notifyOn = true;
      saveJSON('churnlence.notify', true);
      applyNotifyIcon();
      toast('Desktop notifications on — fires on BUY/SELL signal changes.', 'success');
      Notify.fire('ChurnLence', 'You will get a desktop alert on BUY/SELL signal transitions.', 'welcome');
    } else if (res === 'denied') {
      applyNotifyIcon();
      toast('Browser blocked notifications. Allow them in site settings and try again.', 'error');
    }
  }
  function applyNotifyIcon() {
    const btn = $('#notify-toggle');
    if (!btn) return;
    const perm = Notify.status();
    btn.classList.toggle('enabled', state.notifyOn && perm === 'granted');
    btn.classList.toggle('denied', perm === 'denied');
    btn.title = (state.notifyOn && perm === 'granted')
      ? 'Desktop notifications on — click to disable'
      : perm === 'denied' ? 'Notifications blocked by browser'
      : 'Enable desktop notifications for BUY/SELL';
  }

  // ---------- Custom thesis modal -------------------------------------------
  // A small declarative rule builder: indicator + op + value, combined by an
  // AND/OR logic toggle.  Server validates every rule against the same
  // whitelist (see _validate_thesis_rules in app.py).
  const THESIS_INDICATORS = [
    ['price',           'Price ($)'],
    ['rsi',             'RSI (0-100)'],
    ['pct_24h',         '24h change (%)'],
    ['price_vs_ema21',  'Price vs EMA21 (%)'],
    ['ema9',            'EMA 9 ($)'],
    ['ema21',           'EMA 21 ($)'],
    ['ema50',           'EMA 50 ($)'],
    ['ema200',          'EMA 200 ($)'],
    ['macd_hist',       'MACD histogram'],
    ['rvol',            'Relative volume (×)'],
    ['atr_pct',         'ATR (%)'],
    ['bb_pct',          'Bollinger %B (0-1)'],
    ['sentiment_pct',   'CoinGecko sentiment (0-100)'],
  ];
  const THESIS_OPS = [
    ['lt',  '<  less than'],
    ['lte', '≤  at most'],
    ['gt',  '>  greater than'],
    ['gte', '≥  at least'],
    ['crosses_above', '↑ crosses above'],
    ['crosses_below', '↓ crosses below'],
    ['eq',  '=  equals'],
  ];

  function thesisCondRow(c) {
    c = c || { indicator: 'price', op: 'lt', value: '' };
    const inds = THESIS_INDICATORS.map(([v, lbl]) =>
      `<option value="${v}"${v === c.indicator ? ' selected' : ''}>${lbl}</option>`).join('');
    const ops = THESIS_OPS.map(([v, lbl]) =>
      `<option value="${v}"${v === c.op ? ' selected' : ''}>${lbl}</option>`).join('');
    return `
      <div class="thesis-cond" data-thesis-cond>
        <select class="t-ind">${inds}</select>
        <select class="t-op">${ops}</select>
        <input class="t-val" type="number" step="any" value="${c.value ?? ''}" placeholder="value" />
        <button type="button" class="icon-btn t-del" title="Remove condition">✕</button>
      </div>`;
  }

  function thesisGroupBlock(label, kind, group) {
    group = group || { logic: 'AND', conds: [{}] };
    const conds = (group.conds || [{}]).map(thesisCondRow).join('');
    return `
      <div class="thesis-group" data-thesis-group data-kind="${kind}">
        <header class="thesis-group-head">
          <strong>${label}</strong>
          <label class="thesis-logic">
            <select class="t-logic">
              <option value="AND"${(group.logic||'AND')==='AND'?' selected':''}>ALL of (AND)</option>
              <option value="OR" ${(group.logic||'AND')==='OR' ?' selected':''}>ANY of (OR)</option>
            </select>
          </label>
        </header>
        <div class="thesis-conds">${conds}</div>
        <button type="button" class="ghost-btn t-add-cond">+ Add condition</button>
      </div>`;
  }

  function readThesisGroup(groupEl) {
    const logic = groupEl.querySelector('.t-logic').value;
    const conds = [...groupEl.querySelectorAll('[data-thesis-cond]')].map(row => ({
      indicator: row.querySelector('.t-ind').value,
      op:        row.querySelector('.t-op').value,
      value:     parseFloat(row.querySelector('.t-val').value),
    })).filter(c => Number.isFinite(c.value));
    if (!conds.length) return null;
    return { logic, conds };
  }

  let thesisModal = null;
  function buildThesisModal() {
    if (thesisModal) return thesisModal;
    thesisModal = document.createElement('div');
    thesisModal.className = 'modal-backdrop';
    thesisModal.id = 'thesis-modal';
    thesisModal.hidden = true;
    thesisModal.innerHTML = `
      <div class="modal glass-card" style="max-width:680px;">
        <header class="modal-head">
          <h3>Custom thesis · <span id="thesis-sym">—</span></h3>
          <button class="icon-btn" data-close>✕</button>
        </header>
        <form id="thesis-form" class="form-grid">
          <label class="full">Thesis name
            <input name="name" placeholder="e.g. SOL bargain hunt" autocomplete="off" required />
          </label>
          <div class="full" style="font-size:12px; color:var(--ink-mute); margin: -4px 0 -2px;
                                    display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span>Quick templates — click to fill the rule builder, then tweak:</span>
            <button type="button" class="ghost-btn" id="thesis-suggest-btn"
                    title="Suggest rules based on this coin's current state">✨ Suggest from live data</button>
          </div>
          <div class="full preset-row" id="thesis-templates" style="gap:6px; margin-bottom:6px;"></div>
          <div class="full" id="thesis-suggestions" style="font-size:12px;"></div>
          <label class="full" style="display:flex; flex-direction:row; align-items:center; gap:10px;">
            <input name="enabled" type="checkbox" style="width:auto;" checked />
            <span>Active — evaluate every 5 min and alert on hits</span>
          </label>
          <div class="full" id="thesis-buy-host"></div>
          <div class="full" id="thesis-sell-host"></div>
          <label class="full">Notes
            <textarea name="notes" rows="2" placeholder="Why this thesis? Optional, helps future-you."></textarea>
          </label>
          <div class="form-error" id="thesis-error"></div>
          <div class="full" id="thesis-existing" style="font-size:12px; color:var(--ink-mute);"></div>
          <div class="full" id="thesis-backtest" style="font-size:12px; color:var(--ink-mute);"></div>
          <div class="form-actions">
            <button type="button" class="ghost-btn" data-close>Cancel</button>
            <button type="button" class="ghost-btn" id="thesis-backtest-btn"
                    title="Replay this thesis against the last 300 daily bars">▶ Backtest</button>
            <button type="submit" class="primary-btn">Save thesis</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(thesisModal);
    thesisModal.addEventListener('click', (e) => {
      if (e.target === thesisModal || e.target.closest('[data-close]')) {
        thesisModal.hidden = true;
      }
    });
    thesisModal.addEventListener('click', (e) => {
      const addBtn = e.target.closest('.t-add-cond');
      if (addBtn) {
        const host = addBtn.previousElementSibling;
        host.insertAdjacentHTML('beforeend', thesisCondRow());
      }
      const delBtn = e.target.closest('.t-del');
      if (delBtn) {
        const row = delBtn.closest('[data-thesis-cond]');
        const host = row.parentElement;
        row.remove();
        if (!host.children.length) host.insertAdjacentHTML('beforeend', thesisCondRow());
      }
    });
    // Render thesis templates (pre-baked rule sets the user can pick)
    const templates = [
      { id: 'rsi-oversold', label: '🩹 RSI oversold buy', name: 'RSI oversold',
        buy: { logic: 'AND', conds: [
          { indicator: 'rsi', op: 'lt', value: 30 },
        ]}, sell: null },
      { id: 'ema-pullback', label: '🎯 Pullback to EMA21', name: 'Pullback buy',
        buy: { logic: 'AND', conds: [
          { indicator: 'price_vs_ema21', op: 'lt', value: 1 },
          { indicator: 'ema9',  op: 'gt', value: 0 },  // value is placeholder; user edits
        ]}, sell: null },
      { id: 'premium-sell', label: '🍌 Take profit (extended)', name: 'Premium exit',
        buy: null,
        sell: { logic: 'AND', conds: [
          { indicator: 'price_vs_ema21', op: 'gt', value: 8 },
        ]} },
      { id: 'rsi-overbought', label: '🚨 RSI overbought sell', name: 'RSI overbought',
        buy: null,
        sell: { logic: 'AND', conds: [
          { indicator: 'rsi', op: 'gt', value: 75 },
        ]} },
      { id: 'dip-buy', label: '🩸 24h dip buy (-15%)', name: 'Dip buy',
        buy: { logic: 'AND', conds: [
          { indicator: 'pct_24h', op: 'lt', value: -15 },
        ]}, sell: null },
      { id: 'pump-warn', label: '🔥 Volume pump warn', name: 'Volume pump',
        buy: null,
        sell: { logic: 'AND', conds: [
          { indicator: 'rvol',    op: 'gt', value: 5 },
          { indicator: 'pct_24h', op: 'gt', value: 30 },
        ]} },
    ];
    const tplHost = thesisModal.querySelector('#thesis-templates');
    if (tplHost) {
      tplHost.innerHTML = templates.map(t =>
        `<button type="button" class="ghost-btn" data-thesis-tpl="${t.id}">${t.label}</button>`
      ).join('');
      tplHost.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-thesis-tpl]');
        if (!btn) return;
        const tpl = templates.find(t => t.id === btn.dataset.thesisTpl);
        if (!tpl) return;
        const f = thesisModal.querySelector('#thesis-form');
        if (!f.elements.name.value.trim()) f.elements.name.value = tpl.name;
        thesisModal.querySelector('#thesis-buy-host').innerHTML  =
          thesisGroupBlock('BUY when…',  'buy',  tpl.buy);
        thesisModal.querySelector('#thesis-sell-host').innerHTML =
          thesisGroupBlock('SELL when…', 'sell', tpl.sell);
      });
    }

    // ✨ Suggest: heuristic rule proposals based on the coin's current state.
    // Renders a small list under the templates; clicking one fills the rule
    // builder (same UX as templates, just data-driven from /thesis-suggest).
    thesisModal.querySelector('#thesis-suggest-btn').addEventListener('click', async () => {
      const sym = thesisModal.dataset.symbol;
      const host = $('#thesis-suggestions');
      host.innerHTML = '<em>Reading current setup…</em>';
      try {
        const r = await api(`/api/portfolios/${state.currentPortfolioId}/thesis-suggest?symbol=${encodeURIComponent(sym)}`);
        const sug = r.suggestions || [];
        if (!sug.length) {
          host.innerHTML = '<em>No suggestions — try again once the chart has more data.</em>';
          return;
        }
        const snap = r.snapshot || {};
        const snapLine = [
          snap.price != null ? `price ${fmtMoneySm(snap.price)}` : null,
          snap.rsi   != null ? `RSI ${snap.rsi}` : null,
          snap.ema21 != null ? `EMA21 ${fmtMoneySm(snap.ema21)}` : null,
          snap.pct_24h != null ? `24h ${snap.pct_24h.toFixed(2)}%` : null,
          snap.sentiment_pct != null ? `sentiment ${Math.round(snap.sentiment_pct)}%` : null,
        ].filter(Boolean).join(' · ');
        host.innerHTML = `
          <div style="color: var(--ink-mute); margin-bottom: 6px;">
            Live state: ${snapLine || 'no data yet'} · signal ${snap.signal || '—'}.
            Click a suggestion to load it into the builder, then tweak before saving.
          </div>
          ${sug.map((s, i) => `
            <button type="button" class="ghost-btn"
                    data-suggest-idx="${i}"
                    title="${escapeHtml(s.rationale)}"
                    style="display:block; width:100%; text-align:left; margin-bottom:4px;">
              <strong>${escapeHtml(s.label)}</strong>
              <span style="color: var(--ink-mute); font-size: 11px;"> — ${escapeHtml(s.rationale)}</span>
            </button>`).join('')}`;
        $$('[data-suggest-idx]', host).forEach(btn => {
          btn.addEventListener('click', () => {
            const s = sug[parseInt(btn.dataset.suggestIdx, 10)];
            const f = thesisModal.querySelector('#thesis-form');
            if (!f.elements.name.value.trim()) f.elements.name.value = s.name;
            $('#thesis-buy-host').innerHTML  = thesisGroupBlock(
              'BUY when…',  'buy',  (s.buy_rules  && s.buy_rules[0])  || null);
            $('#thesis-sell-host').innerHTML = thesisGroupBlock(
              'SELL when…', 'sell', (s.sell_rules && s.sell_rules[0]) || null);
            host.querySelectorAll('button').forEach(b => b.style.opacity = b === btn ? '1' : '0.55');
          });
        });
      } catch (err) {
        host.innerHTML = `<span style="color: var(--hollow-red);">${escapeHtml(err.message)}</span>`;
      }
    });

    // Backtest button: save first (so the thesis has an id), then replay
    // against history.  Shows compact stats inline.
    thesisModal.querySelector('#thesis-backtest-btn').addEventListener('click', async () => {
      const sym = thesisModal.dataset.symbol;
      const f = thesisModal.querySelector('#thesis-form');
      const buy  = readThesisGroup(thesisModal.querySelector('[data-kind="buy"]'));
      const sell = readThesisGroup(thesisModal.querySelector('[data-kind="sell"]'));
      const buys  = buy  ? [buy]  : [];
      const sells = sell ? [sell] : [];
      if (!buys.length && !sells.length) {
        $('#thesis-error').textContent = 'Add at least one buy or sell condition first.';
        return;
      }
      const out = $('#thesis-backtest');
      out.innerHTML = '<em>Running backtest…</em>';
      try {
        // Save (or update) so the backtest endpoint has a row to replay
        const url = thesisModal.dataset.editing
          ? `/api/portfolios/${state.currentPortfolioId}/theses/${thesisModal.dataset.editing}`
          : `/api/portfolios/${state.currentPortfolioId}/theses`;
        const method = thesisModal.dataset.editing ? 'PATCH' : 'POST';
        const saved = await api(url, { method, body: JSON.stringify({
          symbol: sym,
          name: f.elements.name.value.trim() || `${sym} thesis`,
          buy_rules: buys, sell_rules: sells,
          notes: f.elements.notes.value.trim(),
          enabled: f.elements.enabled.checked,
        }) });
        // Find the id we just wrote (PATCH returns the updated list; POST returns same shape)
        const mine = (saved.theses || []).filter(t => t.symbol === sym);
        const target = thesisModal.dataset.editing
          ? mine.find(t => String(t.id) === thesisModal.dataset.editing)
          : mine[0];   // newest first
        if (!target) { out.innerHTML = '<em>Could not locate saved thesis.</em>'; return; }
        thesisModal.dataset.editing = String(target.id);
        const r = await api(
          `/api/portfolios/${state.currentPortfolioId}/theses/${target.id}/backtest`,
          { method: 'POST', body: JSON.stringify({ starting_cash: 10000, mode: state.mode || 'swing' }) }
        );
        if (r.error) { out.innerHTML = `<span style="color:var(--hollow-red);">${escapeHtml(r.error)}</span>`; return; }
        const beat = r.outperformance_pct > 0;
        out.innerHTML = `
          <div style="display:flex; gap:14px; flex-wrap:wrap; padding:8px 10px;
                      border:1px solid var(--line); border-radius:8px;
                      background: rgba(0,0,0,0.2);">
            <span><strong>${r.fire_count}</strong> fires over ${r.bars} bars (${r.from} → ${r.to})</span>
            <span><strong>${r.round_trips}</strong> round-trips · ${r.win_rate_pct}% win rate</span>
            <span style="color:${beat ? 'var(--lime, #98ff66)' : 'var(--hollow-red, #ff3d7f)'};">
              ${r.strategy_return_pct >= 0 ? '+' : ''}${r.strategy_return_pct}% vs buy &amp; hold ${r.buy_hold_return_pct >= 0 ? '+' : ''}${r.buy_hold_return_pct}%
              (${beat ? '+' : ''}${r.outperformance_pct} edge)
            </span>
          </div>
          <div style="font-size:11px; color:var(--ink-mute); margin-top:4px;">
            ${r.fire_count === 0 ? 'No fires — rule may be too strict.' :
              r.round_trips === 0 ? 'Only one-sided fires — add the opposite rule to complete trades.' :
              `${r.wins} wins · ${r.losses} losses on completed trades.`}
          </div>`;
      } catch (err) {
        out.innerHTML = `<span style="color:var(--hollow-red);">${escapeHtml(err.message)}</span>`;
      }
    });

    thesisModal.querySelector('#thesis-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const sym = thesisModal.dataset.symbol;
      const buyEl  = thesisModal.querySelector('[data-kind="buy"]');
      const sellEl = thesisModal.querySelector('[data-kind="sell"]');
      const buy = readThesisGroup(buyEl);
      const sell = readThesisGroup(sellEl);
      const buys  = buy  ? [buy]  : [];
      const sells = sell ? [sell] : [];
      if (!buys.length && !sells.length) {
        $('#thesis-error').textContent = 'Add at least one buy or sell condition.';
        return;
      }
      const payload = {
        symbol: sym,
        name: f.elements.name.value.trim() || `${sym} thesis`,
        buy_rules:  buys,
        sell_rules: sells,
        notes: f.elements.notes.value.trim(),
        enabled: f.elements.enabled.checked,
      };
      $('#thesis-error').textContent = '';
      try {
        const url = thesisModal.dataset.editing
          ? `/api/portfolios/${state.currentPortfolioId}/theses/${thesisModal.dataset.editing}`
          : `/api/portfolios/${state.currentPortfolioId}/theses`;
        const method = thesisModal.dataset.editing ? 'PATCH' : 'POST';
        await api(url, { method, body: JSON.stringify(payload) });
        toast('Thesis saved', 'success');
        thesisModal.hidden = true;
        refreshOnce();
        refreshThesesRules();
      } catch (err) {
        $('#thesis-error').textContent = err.message;
      }
    });
    return thesisModal;
  }

  async function openThesisModal(symbol) {
    if (!state.currentPortfolioId) { toast('No portfolio loaded yet', 'error'); return; }
    symbol = String(symbol || '').toUpperCase();
    buildThesisModal();
    thesisModal.dataset.symbol = symbol;
    thesisModal.dataset.editing = '';
    $('#thesis-sym').textContent = symbol;
    const f = $('#thesis-form');
    f.elements.name.value = '';
    f.elements.notes.value = '';
    f.elements.enabled.checked = true;
    $('#thesis-buy-host').innerHTML  = thesisGroupBlock('BUY when…',  'buy',  null);
    $('#thesis-sell-host').innerHTML = thesisGroupBlock('SELL when…', 'sell', null);
    $('#thesis-error').textContent = '';
    $('#thesis-existing').innerHTML = '';
    const sugHost = $('#thesis-suggestions');
    if (sugHost) sugHost.innerHTML = '';
    const btHost = $('#thesis-backtest');
    if (btHost) btHost.innerHTML = '';
    thesisModal.hidden = false;

    // Load any existing theses for this symbol — show first as editable
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/theses`);
      const mine = (r.theses || []).filter(t => t.symbol === symbol);
      if (mine.length) {
        const list = mine.map(t => `
          <button type="button" class="link-btn" data-load-thesis="${t.id}">
            ${t.enabled ? '●' : '○'} ${escapeHtml(t.name)} ${t.last_fired_signal ? `· last ${t.last_fired_signal}` : ''}
          </button>
          <button type="button" class="link-btn" data-del-thesis="${t.id}" style="color:var(--hollow-red);">delete</button>
          <br/>`).join('');
        $('#thesis-existing').innerHTML = `Existing theses for ${symbol}:<br/>${list}`;
        $$('#thesis-existing [data-load-thesis]').forEach(btn => {
          btn.addEventListener('click', () => {
            const t = mine.find(x => String(x.id) === btn.dataset.loadThesis);
            if (!t) return;
            thesisModal.dataset.editing = String(t.id);
            f.elements.name.value = t.name || '';
            f.elements.notes.value = t.notes || '';
            f.elements.enabled.checked = !!t.enabled;
            $('#thesis-buy-host').innerHTML  = thesisGroupBlock('BUY when…',  'buy',
              (t.buy_rules && t.buy_rules[0])  || null);
            $('#thesis-sell-host').innerHTML = thesisGroupBlock('SELL when…', 'sell',
              (t.sell_rules && t.sell_rules[0]) || null);
          });
        });
        $$('#thesis-existing [data-del-thesis]').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('Delete this thesis?')) return;
            try {
              await api(`/api/portfolios/${state.currentPortfolioId}/theses/${btn.dataset.delThesis}`,
                { method: 'DELETE' });
              toast('Thesis deleted', 'success');
              thesisModal.hidden = true;
              refreshOnce();
              refreshThesesRules();
            } catch (err) { toast(err.message, 'error'); }
          });
        });
      }
    } catch (err) { /* non-fatal */ }
  }

  // ---------- Alert rules modal (per-symbol price/movement alerts) ----------
  const ALERT_KINDS = [
    ['price_above',  'Price rises above',  v => ({ value: parseFloat(v) }),    'value', 'e.g. 0.50'],
    ['price_below',  'Price falls below',  v => ({ value: parseFloat(v) }),    'value', 'e.g. 0.20'],
    ['pct_move_24h', '24h move beyond',    v => ({ pct: parseFloat(v) }),      'pct',   'e.g. -15 or 25'],
    ['volume_spike', 'Volume spike ≥',     v => ({ threshold: parseFloat(v) }),'threshold','e.g. 3 (3× avg)'],
    ['signal_flip',  'Signal changes',     ()=> ({}),                          null,    ''],
  ];

  let rulesModal = null;
  function buildRulesModal() {
    if (rulesModal) return rulesModal;
    rulesModal = document.createElement('div');
    rulesModal.className = 'modal-backdrop';
    rulesModal.id = 'rules-modal';
    rulesModal.hidden = true;
    rulesModal.innerHTML = `
      <div class="modal glass-card" style="max-width:560px;">
        <header class="modal-head">
          <h3>Alert rules · <span id="rules-sym">—</span></h3>
          <button class="icon-btn" data-close>✕</button>
        </header>
        <div class="form-grid">
          <div class="full" style="color:var(--ink-mute); font-size:13px;">
            Fire on price, % move, or volume.  Rules check every 5 min server-side
            (works even with the tab closed).  Email/Discord delivery uses your
            <em>Email alerts</em> settings.
          </div>
          <div class="full" id="rules-list"></div>
          <hr class="full" style="border:0; border-top:1px solid var(--line);" />
          <div class="full" style="font-size:12px; color:var(--ink-mute); margin-bottom:4px;">
            Quick presets (use the current price):
          </div>
          <div class="full preset-row" id="rule-presets" style="margin-bottom:8px; gap:6px;">
            <button type="button" class="ghost-btn" data-preset="up10">+10%</button>
            <button type="button" class="ghost-btn" data-preset="up25">+25%</button>
            <button type="button" class="ghost-btn" data-preset="down10">-10%</button>
            <button type="button" class="ghost-btn" data-preset="down25">-25%</button>
            <button type="button" class="ghost-btn" data-preset="pct15">±15% 24h</button>
            <button type="button" class="ghost-btn" data-preset="vol3">Vol ≥ 3×</button>
            <button type="button" class="ghost-btn" data-preset="flip">Signal flip</button>
          </div>
          <form id="rule-add-form" class="full form-grid" style="grid-template-columns: 1fr 1fr;">
            <label>Kind
              <select name="kind">
                ${ALERT_KINDS.map(([v,lbl]) => `<option value="${v}">${lbl}</option>`).join('')}
              </select>
            </label>
            <label id="rule-val-wrap">Value
              <input name="value" type="number" step="any" placeholder="" />
            </label>
            <div class="form-actions" style="grid-column: span 2;">
              <button type="button" class="ghost-btn" data-close>Close</button>
              <button type="submit" class="primary-btn">Add rule</button>
            </div>
            <div class="form-error full" id="rule-error"></div>
          </form>
        </div>
      </div>`;
    document.body.appendChild(rulesModal);
    rulesModal.addEventListener('click', (e) => {
      if (e.target === rulesModal || e.target.closest('[data-close]')) {
        rulesModal.hidden = true;
      }
    });
    const form = rulesModal.querySelector('#rule-add-form');
    const updateValVisibility = () => {
      const kind = form.elements.kind.value;
      const meta = ALERT_KINDS.find(k => k[0] === kind) || [];
      const wrap = $('#rule-val-wrap');
      if (!meta[3]) {
        wrap.style.display = 'none';
      } else {
        wrap.style.display = '';
        wrap.querySelector('input').placeholder = meta[4] || '';
      }
    };
    form.elements.kind.addEventListener('change', updateValVisibility);
    updateValVisibility();

    // Preset buttons — read the current price/quote off the live snapshot or
    // watchData, then POST the corresponding rule directly.
    $$('#rule-presets [data-preset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sym = rulesModal.dataset.symbol;
        const q = (state.snapshot?.rows || []).find(r => r.symbol === sym)
                  || state.watchData[sym] || null;
        const price = q && q.price;
        let body = null;
        switch (btn.dataset.preset) {
          case 'up10':   if (price) body = { symbol: sym, kind: 'price_above', params: { value: +(price * 1.10).toFixed(6) } }; break;
          case 'up25':   if (price) body = { symbol: sym, kind: 'price_above', params: { value: +(price * 1.25).toFixed(6) } }; break;
          case 'down10': if (price) body = { symbol: sym, kind: 'price_below', params: { value: +(price * 0.90).toFixed(6) } }; break;
          case 'down25': if (price) body = { symbol: sym, kind: 'price_below', params: { value: +(price * 0.75).toFixed(6) } }; break;
          case 'pct15':  body = { symbol: sym, kind: 'pct_move_24h', params: { pct: 15 } }; break;
          case 'vol3':   body = { symbol: sym, kind: 'volume_spike', params: { threshold: 3 } }; break;
          case 'flip':   body = { symbol: sym, kind: 'signal_flip',  params: {} }; break;
        }
        if (!body) {
          $('#rule-error').textContent = 'No live price for ' + sym + ' yet — fill the value field instead.';
          return;
        }
        $('#rule-error').textContent = '';
        try {
          await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules`,
            { method: 'POST', body: JSON.stringify(body) });
          toast('Alert rule added', 'success');
          loadRulesList(sym);
        } catch (err) { $('#rule-error').textContent = err.message; }
      });
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = form.elements.kind.value;
      const meta = ALERT_KINDS.find(k => k[0] === kind);
      const raw = form.elements.value.value;
      const params = meta[2](raw);
      const sym = rulesModal.dataset.symbol;
      $('#rule-error').textContent = '';
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules`,
          { method: 'POST', body: JSON.stringify({ symbol: sym, kind, params }) });
        form.elements.value.value = '';
        toast('Alert rule added', 'success');
        loadRulesList(sym);
      } catch (err) {
        $('#rule-error').textContent = err.message;
      }
    });
    return rulesModal;
  }

  async function loadRulesList(symbol) {
    const host = $('#rules-list');
    host.innerHTML = '<div class="empty-row">Loading…</div>';
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules`);
      const mine = (r.rules || []).filter(x => x.symbol === symbol);
      if (!mine.length) {
        host.innerHTML = '<div class="empty-row">No alerts yet — add one below.</div>';
        return;
      }
      host.innerHTML = mine.map(rule => {
        const meta = ALERT_KINDS.find(k => k[0] === rule.kind);
        const label = meta ? meta[1] : rule.kind;
        let valTxt = '';
        if (rule.params.value != null)     valTxt = `$${rule.params.value}`;
        if (rule.params.pct != null)       valTxt = `${rule.params.pct}%`;
        if (rule.params.threshold != null) valTxt = `${rule.params.threshold}×`;
        return `
          <div class="rule-row">
            <span class="rule-kind ${rule.enabled ? '' : 'off'}">${label} ${valTxt}</span>
            <span class="rule-last">${rule.last_fired_at ? 'last fired ' + (rule.last_fired_at.split('T')[0]) : 'idle'}</span>
            <button class="link-btn" data-rule-toggle="${rule.id}" data-on="${rule.enabled ? 1 : 0}">${rule.enabled ? 'disable' : 'enable'}</button>
            <button class="link-btn" data-rule-del="${rule.id}" style="color:var(--hollow-red);">delete</button>
          </div>`;
      }).join('');
      $$('[data-rule-toggle]', host).forEach(b => b.addEventListener('click', async () => {
        const next = b.dataset.on === '1' ? false : true;
        try {
          await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules/${b.dataset.ruleToggle}`,
            { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
          loadRulesList(symbol);
        } catch (err) { toast(err.message, 'error'); }
      }));
      $$('[data-rule-del]', host).forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this rule?')) return;
        try {
          await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules/${b.dataset.ruleDel}`,
            { method: 'DELETE' });
          loadRulesList(symbol);
        } catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) {
      host.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function openAlertRulesModal(symbol) {
    if (!state.currentPortfolioId) { toast('No portfolio loaded yet', 'error'); return; }
    symbol = String(symbol || '').toUpperCase();
    buildRulesModal();
    rulesModal.dataset.symbol = symbol;
    $('#rules-sym').textContent = symbol;
    $('#rule-error').textContent = '';
    rulesModal.hidden = false;
    loadRulesList(symbol);
  }

  // Expose for the Jarvis action dispatcher
  window.churnlence = window.churnlence || {};
  window.churnlence.openThesisModal = openThesisModal;
  window.churnlence.openAlertRulesModal = openAlertRulesModal;
  window.churnlence.addToWatchlist = addToWatchlist;
  window.churnlence.removeFromWatchlist = removeFromWatchlist;
  window.churnlence.requestMorningBriefing = () => requestMorningBriefing(true);

  // ---------- PWA: service worker + install prompt --------------------------
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Only register on https (or localhost) — browsers require secure context.
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    navigator.serviceWorker.register('/static/sw.js').catch(err => console.warn('SW register failed:', err));
  }

  let deferredInstall = null;
  function wireInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstall = e;
      // Surface an inline "Install app" button in the topbar
      const btn = document.createElement('button');
      btn.className = 'icon-btn install-btn';
      btn.id = 'install-btn';
      btn.title = 'Install ChurnLence as an app';
      btn.textContent = '⤓ Install';
      btn.style.cssText = 'padding:6px 12px; width:auto; font-size:12px; font-weight:600;';
      btn.addEventListener('click', async () => {
        if (!deferredInstall) return;
        deferredInstall.prompt();
        const { outcome } = await deferredInstall.userChoice;
        if (outcome === 'accepted') toast('Installed — check your home screen', 'success');
        deferredInstall = null;
        btn.remove();
      });
      const host = document.querySelector('.topbar-actions');
      if (host) host.insertBefore(btn, host.firstChild);
    });
    window.addEventListener('appinstalled', () => {
      toast('ChurnLence added to your home screen', 'success');
      document.getElementById('install-btn')?.remove();
    });
  }

  // Handle deep-link tab via ?tab=holdings|planner|...
  function applyLaunchTab() {
    const params = new URLSearchParams(location.search);
    const t = params.get('tab');
    if (t && ['overview','holdings','charts','signals','watchlist','planner','backtest'].includes(t)) {
      setTab(t);
    }
  }

  // ---------- Cmd-K palette wiring -----------------------------------------
  // Build the API the palette uses to hook back into the app.  Done up here
  // so it's initialised before bind() wires keyboard shortcuts.
  function initCommandPalette() {
    if (!window.CmdK) return; // module not loaded
    window.CmdK.init({
      snapshot:        () => state.snapshot,
      watchlist:       () => state.watchlist,
      setTab:          (name) => setTab(name),
      openChart:       (sym) => {
        state.chartSymbol = sym;
        const sel = $('#chart-symbol-select');
        if (sel && [...sel.options].some(o => o.value === sym)) sel.value = sym;
        setTab('charts');
      },
      addToWatchlist:  (sym) => addToWatchlist(sym),
      openSellModal:   (sym, qty) => {
        if (typeof openSellModal === 'function') {
          openSellModal(sym);
          if (qty) {
            const n = parseFloat(qty);
            if (Number.isFinite(n)) {
              const f = $('#sell-form');
              if (f) f.elements.shares.value = n;
            }
          }
        } else { toast(`Open sell for ${sym}`, 'info'); }
      },
      openAddPosition: () => openModal('add-holding-modal'),
      openImport:      () => openModal('import-csv-modal'),
      openAlerts:      () => {
        // The portfolio menu owns this — simulate a click
        const btn = $('[data-pm="alerts"]');
        if (btn) btn.click();
      },
      refresh:         () => { refreshOnce(); refreshWatchlist(); refreshMarket(); toast('Refreshed', 'info', 1500); },
      exportCsv:       () => { if (typeof exportCsv === 'function') exportCsv(); },
      setMode:         (mode) => { if (typeof setMode === 'function') setMode(mode); },
      setDensity:      (val) => window.CmdK.setDensity(val),
      toggleSound:     () => toggleSound(),
      toggleNotify:    () => toggleNotify(),
      openHotkeys:     () => window.CmdK.openHotkeys(),
      toast:           (msg, kind, ms) => toast(msg, kind, ms),
    });
  }

  // ---------- AI Copilot wiring --------------------------------------------
  function initAICopilot() {
    if (!window.AICopilot) return;
    window.AICopilot.init({
      snapshot:    () => state.snapshot,
      chartSymbol: () => state.chartSymbol,
      portfolioId: () => state.currentPortfolioId,
      mode:        () => state.mode,
      // Action handlers — Jarvis emits [[ACTION:name|json]] blocks and the
      // copilot calls these.  Read-only actions auto-run; destructive ones
      // require an explicit Run click in the chip.
      actions: {
        add_to_watchlist:      ({symbol}) => addToWatchlist(symbol),
        remove_from_watchlist: ({symbol}) => removeFromWatchlist(symbol),
        open_chart: ({symbol}) => {
          if (!symbol) return;
          state.chartSymbol = String(symbol).toUpperCase();
          const sel = $('#chart-symbol-select');
          if (sel) sel.value = state.chartSymbol;
          setTab('charts');
        },
        set_tab:  ({tab})  => { if (tab) setTab(tab); },
        set_mode: ({mode}) => { if (mode && typeof setMode === 'function') setMode(mode); },
        refresh:  () => { refreshOnce(); refreshWatchlist(); toast('Refreshed', 'info', 1500); },
        summarize_holdings: () => setTab('overview'),
        create_alert_rule: async ({symbol, kind, params}) => {
          if (!symbol || !kind) return;
          try {
            await api(`/api/portfolios/${state.currentPortfolioId}/alert-rules`,
              { method: 'POST',
                body: JSON.stringify({ symbol: String(symbol).toUpperCase(), kind, params: params || {} }) });
            toast(`Alert rule for ${symbol} created`, 'success');
          } catch (err) { toast(err.message, 'error'); }
        },
      },
    });
  }

  // ---------- morning briefing ----------------------------------------------
  // Jarvis-flavoured "what changed overnight" summary.  Auto-fires once per
  // UTC day on first open; also available manually via the AI drawer button
  // and the >briefing Cmd-K command.
  async function requestMorningBriefing(forceShow = true) {
    if (!state.currentPortfolioId) return null;
    try {
      const r = await api(`/api/portfolios/${state.currentPortfolioId}/jarvis/briefing`,
        { method: 'POST', body: JSON.stringify({ mode: state.mode || 'swing' }) });
      if (forceShow && r.briefing) {
        // Push into Jarvis as a proactive bubble (drives voice readback too)
        if (window.AICopilot && typeof window.AICopilot.pushProactive === 'function') {
          window.AICopilot.pushProactive('Morning briefing: ' + r.briefing);
        }
        // Also a quieter toast so it's not lost if the drawer is closed
        toast('Morning briefing ready in AI Copilot', 'info', 4000);
      }
      return r;
    } catch (err) {
      console.warn('briefing failed:', err);
      return null;
    }
  }

  function maybeMorningBriefing() {
    const today = new Date().toISOString().slice(0, 10);   // UTC date stamp
    const last = loadJSON('cl.briefing.lastDate', '');
    if (last === today) return;          // already done today
    requestMorningBriefing(true).then(r => {
      if (r) saveJSON('cl.briefing.lastDate', today);
    });
  }

  // ---------- boot -----------------------------------------------------------
  async function boot() {
    bind();
    initCommandPalette();
    initAICopilot();
    registerServiceWorker();
    wireInstallPrompt();
    try {
      await Promise.all([loadPortfolios(), loadPresets()]);
      await refreshOnce();
      // Server is the canonical watchlist now — push any localStorage-only
      // symbols up so the background watcher can see them.  Idempotent.
      await migrateWatchlistToServer();
      openStream();
      refreshWatchlist();
      refreshTransactions();
      refreshThesesRules();
      refreshMarket();
      refreshCorrelation();
      // Funding rates update on cycle boundaries; pull right after first
      // snapshot (so symbol list is populated from holdings + watchlist).
      setTimeout(refreshFunding, 1500);
      applyLaunchTab();
      // Morning briefing: first open of the day → Jarvis generates a
      // 3-sentence overnight summary and pushes it as a proactive bubble.
      // Tied to localStorage so it fires exactly once per UTC day per device.
      setTimeout(() => maybeMorningBriefing(), 4000);
      setInterval(refreshWatchlist, 30000);
      setInterval(refreshTransactions, 60000);
      setInterval(refreshMarket, 5 * 60 * 1000);
      setInterval(refreshCorrelation, 5 * 60 * 1000);
      setInterval(refreshFunding, 60 * 1000); // funding every minute
      setTimeout(moveTabUnderline, 50);
    } catch (err) {
      toast(`Boot failed: ${err.message}`, 'error');
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
