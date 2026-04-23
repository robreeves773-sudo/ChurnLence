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
    sortKey: 'value',
    sortDir: -1,
    evtSource: null,
    reconnectDelay: 1000,
    chartSymbol: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
    renderOverview(snap);
    renderHoldings(snap);
    renderSignalBars(snap);
    renderAllocation(snap);
    renderTickerTape(snap);
    updateChartSymbolSelector(snap);
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
        if (r.signal === 'BUY') Sound.ding();
        else if (r.signal === 'SELL') Sound.alert();
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
      tbody.innerHTML = `<tr class="empty-row"><td colspan="12">No positions yet — add one to begin.</td></tr>`;
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
          <td class="num">${fmtNum(r.shares)}</td>
          <td class="num">${fmtMoneySm(r.cost_basis)}</td>
          <td class="num price-cell">${r.price != null ? fmtMoneySm(r.price) : '—'}</td>
          <td class="num ${up ? 'up' : 'down'}">${fmtPct(r.change_pct)}</td>
          <td class="num">${fmtMoney(r.value)}</td>
          <td class="num ${plUp ? 'up' : 'down'}">${fmtMoney(r.pl)}</td>
          <td class="num ${plUp ? 'up' : 'down'}">${fmtPct(r.pl_pct)}</td>
          <td><span class="sig-chip ${(r.signal||'hold').toLowerCase()}" title="${escapeHtml(r.signal_reason||'')}">${r.signal || 'HOLD'}</span></td>
          <td class="num">${r.stop_loss != null ? fmtMoneySm(r.stop_loss) : '—'}</td>
          <td class="num">${r.ema21 != null ? fmtMoneySm(r.ema21) : '—'}</td>
          <td class="num"><button class="row-del" data-del="${r.id}" title="Remove">✕</button></td>
        </tr>`;
    }).join('');

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
        const id = btn.dataset.del;
        Sound.click();
        try {
          await api(`/api/holdings/${id}`, { method: 'DELETE' });
          toast('Position removed', 'success');
          await refreshOnce();
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    // click row → charts tab
    $$('tr[data-sym]', tbody).forEach(tr => {
      tr.addEventListener('click', () => {
        state.chartSymbol = tr.dataset.sym;
        $('#chart-symbol-select').value = tr.dataset.sym;
        setTab('charts');
      });
    });
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

  // ---------- allocation doughnut -------------------------------------------
  let allocChart = null;
  const PALETTE = ['#00e5ff', '#b388ff', '#ff3d7f', '#00ff9c', '#ffb84d', '#ff9e3d', '#4d7cff', '#ff5577'];
  function renderAllocation(snap) {
    const rows = (snap.rows || []).filter(r => !r.error && (r.value || 0) > 0);
    const labels = rows.map(r => r.symbol);
    const data = rows.map(r => r.value);
    const colors = rows.map((_, i) => PALETTE[i % PALETTE.length]);
    const ctx = $('#alloc-chart');
    if (!ctx) return;
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
    try {
      const q = await api(`/api/quote/${encodeURIComponent(state.chartSymbol)}`);
      $('#chart-symbol-label').textContent = q.symbol + (q.name ? ` · ${q.name}` : '');
      $('#chart-price').textContent = fmtMoneySm(q.price);
      const chg = q.change_pct ?? 0;
      $('#chart-sub').innerHTML =
        `<span class="${chg >= 0 ? 'up' : 'down'}" style="color:${chg>=0?'var(--success)':'var(--danger)'}">${chg>=0?'▲':'▼'} ${fmtPct(chg)}</span>
         &nbsp; EMA21 ${fmtMoneySm(q.ema21)} · Stop ${fmtMoneySm(q.stop_loss)} · <span class="sig-chip ${(q.signal||'hold').toLowerCase()}">${q.signal}</span>`;

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
      const map = { '1':'overview','2':'holdings','3':'charts','4':'signals','5':'watchlist' };
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

    // portfolio switcher
    $('#portfolio-select').addEventListener('change', (e) => {
      state.currentPortfolioId = parseInt(e.target.value, 10);
      openStream();
      refreshOnce();
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

    // add holding
    $('#add-holding-btn').addEventListener('click', () => { openModal('add-holding-modal'); Sound.click(); });
    $('#add-holding-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const payload = {
        symbol: f.symbol.value.trim(),
        shares: parseFloat(f.shares.value),
        cost_basis: parseFloat(f.cost_basis.value),
        note: f.note.value.trim() || null,
      };
      const err = $('#add-holding-error');
      err.textContent = '';
      try {
        await api(`/api/portfolios/${state.currentPortfolioId}/holdings`,
          { method: 'POST', body: JSON.stringify(payload) });
        closeModal('add-holding-modal');
        e.target.reset();
        await refreshOnce();
        toast(`${payload.symbol.toUpperCase()} added`, 'success');
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

  // ---------- boot -----------------------------------------------------------
  async function boot() {
    bind();
    try {
      await loadPortfolios();
      await refreshOnce();
      openStream();
      refreshWatchlist();
      setInterval(refreshWatchlist, 30000);   // watchlist refreshes every 30s
      setTimeout(moveTabUnderline, 50);
    } catch (err) {
      toast(`Boot failed: ${err.message}`, 'error');
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
