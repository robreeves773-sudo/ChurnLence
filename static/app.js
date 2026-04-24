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
    if (name === 'charts') renderDetailChart();
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
    const src = new EventSource(`/api/portfolios/${state.currentPortfolioId}/stream`);
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

  // ---------- snapshot handling ---------------------------------------------
  function applySnapshot(snap) {
    if (snap.error) { toast(snap.error, 'error'); return; }
    state.snapshot = snap;
    detectSignalTransitions(snap.rows || []);
    safeCall('overview', () => renderOverview(snap));
    safeCall('holdings', () => renderHoldings(snap));
    safeCall('signals', () => renderSignalBars(snap));
    safeCall('allocation', () => renderAllocation(snap));
    safeCall('concentration', () => renderConcentration(snap));
    safeCall('ticker', () => renderTickerTape(snap));
    safeCall('chart-selector', () => updateChartSymbolSelector(snap));
    if (state.chartSymbol && $('.panel.active')?.dataset.panel === 'charts') renderDetailChart();
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
          <td><span class="sig-chip ${(r.signal||'hold').toLowerCase()}" title="${escapeHtml(r.signal_reason||'')}">${r.signal || 'HOLD'}</span></td>
          <td class="num">${r.stop_loss != null ? fmtMoneySm(r.stop_loss) : '—'}</td>
          <td class="num">${r.stop_atr != null ? fmtMoneySm(r.stop_atr) : '—'}</td>
          <td class="num">${r.atr_pct != null ? fmtPct(r.atr_pct) : '—'}</td>
          <td class="num row-actions">
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
    for (const r of rows) {
      const prev = state.prevPrices[r.symbol];
      const tr = tbody.querySelector(`tr[data-sym="${r.symbol}"]`);
      if (!tr) continue;
      const cell = tr.querySelector('.price-cell');
      if (prev != null && r.price != null && Math.abs(r.price - prev) > 1e-9) {
        cell.classList.remove('flash-up','flash-down');
        // re-trigger
        void cell.offsetWidth;
        cell.classList.add(r.price >= prev ? 'flash-up' : 'flash-down');
      }
      state.prevPrices[r.symbol] = r.price;
    }

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
      const q = await api(`/api/quote/${encodeURIComponent(symbol)}`);
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
  const PALETTE = ['#00e5ff', '#b388ff', '#ff3d7f', '#00ff9c', '#ffb84d', '#ff9e3d', '#4d7cff', '#ff5577'];
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
      const q = await api(`/api/quote/${encodeURIComponent(state.chartSymbol)}`);
      $('#chart-symbol-label').textContent = q.symbol + (q.name ? ` · ${q.name}` : '');
      $('#chart-price').textContent = fmtMoneySm(q.price);
      const chg = q.change_pct ?? 0;
      $('#chart-sub').innerHTML =
        `<span class="${chg >= 0 ? 'up' : 'down'}" style="color:${chg>=0?'var(--success)':'var(--danger)'}">${chg>=0?'▲':'▼'} ${fmtPct(chg)}</span>
         &nbsp; EMA21 ${fmtMoneySm(q.ema21)} · Stop MA ${fmtMoneySm(q.stop_loss)} · Stop ATR ${fmtMoneySm(q.stop_atr)} · ATR% ${q.atr_pct != null ? fmtPct(q.atr_pct) : '—'} · <span class="sig-chip ${(q.signal||'hold').toLowerCase()}">${q.signal}</span>`;

      const hist = q.history || [];
      const labels = hist.map(h => h.date);
      const base = {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Close', data: hist.map(h => h.close), borderColor: '#e7ecf5', backgroundColor: 'rgba(231,236,245,0.06)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.12 },
            { label: 'EMA 9',   data: hist.map(h => h.ema9),   borderColor: '#ff9e3d', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            { label: 'EMA 21',  data: hist.map(h => h.ema21),  borderColor: '#ffffff', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            { label: 'EMA 50',  data: hist.map(h => h.ema50),  borderColor: '#00e5ff', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            { label: 'EMA 200', data: hist.map(h => h.ema200), borderColor: '#4d7cff', borderWidth: 1.3, pointRadius: 0, tension: 0.15 },
            { label: 'Stop',    data: hist.map(() => q.stop_loss),
              borderColor: '#ff3d7f', borderWidth: 1, pointRadius: 0, borderDash: [6,5] },
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
  async function refreshWatchlist() {
    const grid = $('#watch-grid');
    if (!state.watchlist.length) {
      grid.innerHTML = '<div class="empty-row">Add a symbol to start watching.</div>';
      return;
    }
    const results = await Promise.allSettled(
      state.watchlist.map(s => api(`/api/quote/${encodeURIComponent(s)}`))
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
          <button class="icon-btn wt-del" data-wdel="${sym}" title="Remove">✕</button>
        </div>`);
    });
    // bind
    $$('#watch-grid [data-wdel]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.wdel;
        state.watchlist = state.watchlist.filter(s => s !== sym);
        delete state.watchData[sym];
        saveJSON('churnlence.watchlist', state.watchlist);
        Sound.click();
        refreshWatchlist();
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
    const snap = await api(`/api/portfolios/${state.currentPortfolioId}/holdings`);
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
  function bind() {
    // tabs
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      Sound.click();
      setTab(t.dataset.tab);
    }));
    window.addEventListener('resize', moveTabUnderline);

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      const map = { '1':'overview','2':'holdings','3':'charts','4':'signals','5':'watchlist','6':'planner','7':'backtest' };
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
      if (state.watchlist.includes(sym)) { toast(`${sym} already watched`, 'info'); return; }
      try {
        await api(`/api/quote/${encodeURIComponent(sym)}`);
      } catch { toast(`Symbol ${sym} not found`, 'error'); Sound.alert(); return; }
      state.watchlist.push(sym);
      saveJSON('churnlence.watchlist', state.watchlist);
      $('#watch-input').value = '';
      refreshWatchlist();
      Sound.ding();
      toast(`${sym} added to watchlist`, 'success');
    });

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
        const status = $('#alerts-status');
        status.style.color = '';
        status.textContent = p.smtp_configured
          ? 'SMTP is configured on the server — alerts will send.'
          : 'SMTP is NOT configured on the server. Set SMTP_HOST / SMTP_USER / SMTP_PASS env vars to enable sending. You can still save the preference.';
        if (!p.smtp_configured) status.style.color = 'var(--warn, #ffb84d)';
        openModal('alerts-modal');
      } catch (ex) { toast(ex.message, 'error'); }
    }
    $('#alerts-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        email: e.target.elements.email.value.trim(),
        enabled: e.target.elements.enabled.checked,
      };
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/alerts`,
          { method: 'POST', body: JSON.stringify(payload) });
        closeModal('alerts-modal');
        toast(payload.enabled ? 'Email alerts enabled' : 'Email alerts saved', 'success');
      } catch (ex) { toast(ex.message, 'error'); }
    });

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

  // ---------- boot -----------------------------------------------------------
  async function boot() {
    bind();
    registerServiceWorker();
    wireInstallPrompt();
    try {
      await Promise.all([loadPortfolios(), loadPresets()]);
      await refreshOnce();
      openStream();
      refreshWatchlist();
      refreshTransactions();
      applyLaunchTab();
      setInterval(refreshWatchlist, 30000);   // watchlist refreshes every 30s
      setInterval(refreshTransactions, 60000); // transactions every minute
      setTimeout(moveTabUnderline, 50);
    } catch (err) {
      toast(`Boot failed: ${err.message}`, 'error');
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
