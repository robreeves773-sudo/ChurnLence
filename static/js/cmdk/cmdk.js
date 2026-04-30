/* Cmd-K command palette for ChurnLence.
 *
 * Vanilla JS, no dependencies, no framework.  Mounts a single modal once on
 * boot and shows/hides it on Cmd-K (Mac) / Ctrl-K (Win/Linux).  Recent items
 * persisted to localStorage.  Density toggle persisted to localStorage.
 *
 * Public API:
 *   CmdK.init(api)         - boot once, pass an api object with hooks
 *   CmdK.open()            - programmatic open
 *   CmdK.close()           - programmatic close
 *   CmdK.markUsed(id)      - bump recency when a command is run elsewhere
 *
 * Density (read by CSS via `body[data-density]`):
 *   CmdK.setDensity('cozy' | 'compact' | 'dense')
 *
 * Hotkey overlay:
 *   CmdK.openHotkeys()     - shows the keyboard cheatsheet
 */
(function (root) {
  'use strict';

  var RECENT_KEY = 'cl.cmdk.recent';
  var DENSITY_KEY = 'cl.density';
  var MAX_RECENT = 8;

  var state = {
    api: null,
    open: false,
    query: '',
    selectedIdx: 0,
    items: [],         // ranked items currently visible
    allCommands: [],   // last-built command list
    recent: [],        // [id, ts] tuples
    prevFocus: null,
  };

  // ---------- recency tracking --------------------------------------------
  function loadRecent() {
    try { state.recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
    catch (e) { state.recent = []; }
  }
  function saveRecent() {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent.slice(0, MAX_RECENT))); }
    catch (e) { /* ignore quota */ }
  }
  function bumpRecent(id) {
    state.recent = state.recent.filter(function (r) { return r[0] !== id; });
    state.recent.unshift([id, Date.now()]);
    if (state.recent.length > MAX_RECENT) state.recent.length = MAX_RECENT;
    saveRecent();
  }
  function recencyBoost(id) {
    var entry = state.recent.find(function (r) { return r[0] === id; });
    if (!entry) return 0;
    var ageMs = Date.now() - entry[1];
    if (ageMs < 60 * 60 * 1000) return 80;       // last hour
    if (ageMs < 24 * 60 * 60 * 1000) return 40;  // last day
    return 20;                                    // older but still recent
  }

  // ---------- command building / ranking ----------------------------------
  function rebuildCommands() {
    if (!root.CmdKCommands || !state.api) { state.allCommands = []; return; }
    state.allCommands = root.CmdKCommands.buildAll(state.api);
    // Apply recency boosts in place
    state.allCommands.forEach(function (c) { c.recency = recencyBoost(c.id); });
  }

  function rankedItems(query) {
    if (!root.CmdKFuzzy) return state.allCommands.slice(0, 30);
    var q = (query || '').trim();
    // No query: show recents + tabs + top tickers
    if (!q) {
      var recentIds = state.recent.map(function (r) { return r[0]; });
      var byId = {};
      state.allCommands.forEach(function (c) { byId[c.id] = c; });
      var out = [];
      recentIds.forEach(function (id) { if (byId[id]) out.push(byId[id]); });
      // Add tabs that aren't already in recents
      state.allCommands.forEach(function (c) {
        if (c.cat === 'Tabs' && out.indexOf(c) === -1) out.push(c);
      });
      // Then top 8 tickers
      var addedTickers = 0;
      state.allCommands.forEach(function (c) {
        if (c.cat === 'Tickers' && out.indexOf(c) === -1 && addedTickers < 8) {
          out.push(c); addedTickers++;
        }
      });
      return out.slice(0, 30);
    }
    // Has prefix? Limit category — and for action mode, only search by VERB
    // (the first word after '>'), so '>add wif' still matches the 'add' command
    // even though 'wif' is the argument, not part of the command label.
    var rest = q;
    var catFilter = null;
    if (q[0] === '>') {
      catFilter = ['Actions','View','Settings'];
      var afterPrefix = q.slice(1).trim();
      // Just the first word — args (like 'wif' in '>add wif') are passed
      // to the command's run() via parseArgs(state.query), not the search.
      rest = (afterPrefix.split(/\s+/)[0] || '');
    }
    else if (q[0] === '#') { catFilter = ['Tickers']; rest = q.slice(1).trim(); }
    else if (q[0] === '/') { catFilter = ['Tabs'];    rest = q.slice(1).trim(); }
    var pool = state.allCommands;
    if (catFilter) pool = pool.filter(function (c) { return catFilter.indexOf(c.cat) >= 0; });
    // Empty rest after prefix: return the whole filtered pool (no fuzzy)
    if (!rest) return pool.slice(0, 30);
    return root.CmdKFuzzy.rank(rest, pool);
  }

  // ---------- DOM ---------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  function buildModal() {
    var wrap = document.createElement('div');
    wrap.className = 'cmdk-backdrop';
    wrap.hidden = true;
    wrap.innerHTML = '' +
      '<div class="cmdk-modal" role="dialog" aria-label="Command palette" aria-modal="true">' +
      '  <div class="cmdk-input-row">' +
      '    <span class="cmdk-prompt" aria-hidden="true">⚡</span>' +
      '    <input class="cmdk-input" role="combobox" aria-controls="cmdk-list" aria-expanded="true"' +
      '           aria-autocomplete="list" autocomplete="off" autocapitalize="off"' +
      '           autocorrect="off" spellcheck="false"' +
      '           placeholder="Jump to ticker, run a command (try \\"&gt;\\", \\"#\\", \\"/\\") …" />' +
      '    <kbd class="cmdk-esc">esc</kbd>' +
      '  </div>' +
      '  <div class="cmdk-list" id="cmdk-list" role="listbox"></div>' +
      '  <div class="cmdk-footer">' +
      '    <span><kbd>↵</kbd> open</span>' +
      '    <span><kbd>↑↓</kbd> navigate</span>' +
      '    <span><kbd>esc</kbd> close</span>' +
      '    <span class="cmdk-brand">卍 ChurnLence</span>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);
    return wrap;
  }

  var dom = null;
  function ensureDom() {
    if (dom) return dom;
    dom = {
      backdrop: buildModal(),
    };
    dom.modal  = dom.backdrop.querySelector('.cmdk-modal');
    dom.input  = dom.backdrop.querySelector('.cmdk-input');
    dom.list   = dom.backdrop.querySelector('.cmdk-list');

    dom.backdrop.addEventListener('click', function (e) {
      if (e.target === dom.backdrop) close();
    });
    dom.input.addEventListener('input', function () {
      state.query = dom.input.value;
      state.items = rankedItems(state.query);
      state.selectedIdx = 0;
      renderList();
    });
    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.selectedIdx = Math.min(state.selectedIdx + 1, state.items.length - 1);
        renderList(true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.selectedIdx = Math.max(0, state.selectedIdx - 1);
        renderList(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        execute(state.selectedIdx);
      } else if (e.key === 'Home') {
        e.preventDefault(); state.selectedIdx = 0; renderList(true);
      } else if (e.key === 'End') {
        e.preventDefault(); state.selectedIdx = state.items.length - 1; renderList(true);
      }
    });
    return dom;
  }

  // ---------- render ------------------------------------------------------
  function categoryOf(idx) {
    var item = state.items[idx];
    return item ? item.cat : '';
  }

  function renderList(onlySelection) {
    if (onlySelection) {
      // Cheap re-paint of selection without rebuilding HTML
      var rows = dom.list.querySelectorAll('.cmdk-row');
      rows.forEach(function (r, i) {
        r.classList.toggle('active', i === state.selectedIdx);
        if (i === state.selectedIdx) r.scrollIntoView({ block: 'nearest' });
      });
      return;
    }
    if (!state.items.length) {
      dom.list.innerHTML = '<div class="cmdk-empty">' +
        'No results.  Try a ticker (' +
        '<kbd>btc</kbd> ' + '<kbd>sol</kbd>) or a command (' +
        '<kbd>&gt;sell sol 5</kbd> ' + '<kbd>&gt;add wif</kbd>).' +
        '</div>';
      return;
    }
    var html = '';
    var lastCat = null;
    state.items.forEach(function (item, i) {
      if (item.cat !== lastCat) {
        html += '<div class="cmdk-cat">' + escapeHtml(item.cat) + '</div>';
        lastCat = item.cat;
      }
      var icon  = item.icon ? '<span class="cmdk-icon">' + escapeHtml(item.icon) + '</span>' : '<span class="cmdk-icon"></span>';
      var hint  = item.hint ? '<span class="cmdk-hint">' + escapeHtml(item.hint) + '</span>' : '';
      var label = escapeHtml(item.label);
      var sub   = item.sub ? '<span class="cmdk-sub">' + escapeHtml(item.sub) + '</span>' : '';
      html += '<div class="cmdk-row' + (i === state.selectedIdx ? ' active' : '') +
              '" data-idx="' + i + '" role="option" aria-selected="' + (i === state.selectedIdx ? 'true' : 'false') + '">' +
                icon +
                '<div class="cmdk-text"><span class="cmdk-label">' + label + '</span>' + sub + '</div>' +
                hint +
              '</div>';
    });
    dom.list.innerHTML = html;
    dom.list.querySelectorAll('.cmdk-row').forEach(function (row) {
      row.addEventListener('click', function () {
        state.selectedIdx = parseInt(row.dataset.idx, 10);
        execute(state.selectedIdx);
      });
      row.addEventListener('mouseenter', function () {
        state.selectedIdx = parseInt(row.dataset.idx, 10);
        renderList(true);
      });
    });
  }

  // ---------- execute -----------------------------------------------------
  function parseArgs(query) {
    if (!query) return { tail: '', parts: [] };
    var trimmed = query.replace(/^[>#/]/, '').trim();
    // Skip the leading verb if the input starts with one we know
    var verbs = ['add','sell','buy','remove','alert','note','tag','scan','export','copy'];
    var parts = trimmed.split(/\s+/);
    var firstLower = (parts[0] || '').toLowerCase();
    if (verbs.indexOf(firstLower) >= 0) parts = parts.slice(1);
    return { tail: parts.join(' '), parts: parts };
  }

  function execute(idx) {
    var item = state.items[idx];
    if (!item || typeof item.run !== 'function') return;
    var args = parseArgs(state.query);
    bumpRecent(item.id);
    close();
    try { item.run(args); }
    catch (err) { if (state.api && state.api.toast) state.api.toast('Failed: ' + err.message, 'error'); }
  }

  // ---------- show / hide -------------------------------------------------
  function open() {
    ensureDom();
    if (state.open) return;
    rebuildCommands();
    state.prevFocus = document.activeElement;
    state.query = state.query || '';
    state.items = rankedItems(state.query);
    state.selectedIdx = 0;
    dom.input.value = state.query;
    dom.backdrop.hidden = false;
    // Force reflow before opacity transition
    void dom.backdrop.offsetWidth;
    dom.backdrop.classList.add('cmdk-visible');
    setTimeout(function () {
      dom.input.focus();
      dom.input.select();
    }, 16);
    renderList();
    state.open = true;
  }

  function close() {
    if (!state.open || !dom) return;
    dom.backdrop.classList.remove('cmdk-visible');
    dom.backdrop.hidden = true;
    state.open = false;
    if (state.prevFocus && typeof state.prevFocus.focus === 'function') {
      try { state.prevFocus.focus(); } catch (e) { /* ignore */ }
    }
  }

  // ---------- density toggle ----------------------------------------------
  function setDensity(value) {
    if (['cozy','compact','dense'].indexOf(value) < 0) value = 'cozy';
    document.body.setAttribute('data-density', value);
    try { localStorage.setItem(DENSITY_KEY, value); } catch (e) { /* ignore */ }
    if (state.api && state.api.toast) state.api.toast('Density: ' + value, 'info', 1800);
  }
  function loadDensity() {
    try {
      var v = localStorage.getItem(DENSITY_KEY) || 'cozy';
      document.body.setAttribute('data-density', v);
    } catch (e) { document.body.setAttribute('data-density', 'cozy'); }
  }

  // ---------- hotkeys overlay ('?' cheatsheet) ----------------------------
  var hotkeysDom = null;
  function buildHotkeys() {
    if (hotkeysDom) return hotkeysDom;
    var groups = [
      { name: 'Navigation', rows: [
        ['1 … 8',         'Switch to tab 1–8'],
        ['Ctrl/⌘ + K',    'Open command palette'],
        ['?',             'Open this cheatsheet'],
        ['Esc',           'Close any modal'],
      ]},
      { name: 'Actions', rows: [
        ['N',             'New position'],
        ['M',             'Toggle sound'],
        ['↵',             'Open / confirm'],
        ['↑ / ↓',         'Navigate list'],
      ]},
      { name: 'Palette tips', rows: [
        ['btc',           'Jump to BTC chart'],
        ['&gt;sell sol 5', 'Open sell modal pre-filled (SOL × 5)'],
        ['&gt;add wif',   'Add to watchlist'],
        ['#peng',         'Filter to tickers only'],
        ['/scanner',      'Filter to tabs only'],
      ]},
      { name: 'Trading mode', rows: [
        ['SHIKAI 始解',   'Daily candles · 9/21/50/200 EMA · slow & high-conviction'],
        ['BANKAI 卍解',   '15-min candles · tighter stops · faster signals'],
      ]},
    ];
    var html = '<div class="cmdk-hk-modal"><header><h2>Keyboard shortcuts</h2><button class="icon-btn" data-close>✕</button></header>';
    groups.forEach(function (g) {
      html += '<section><h3>' + escapeHtml(g.name) + '</h3><dl>';
      g.rows.forEach(function (r) {
        html += '<dt>' + r[0].split(' ').map(function (k) {
          return /^&|^[A-Za-z]$|↵|↑|↓|⌘|Ctrl|Esc|Cmd-K/.test(k)
            ? '<kbd>' + k + '</kbd>' : k;
        }).join(' ') + '</dt><dd>' + r[1] + '</dd>';
      });
      html += '</dl></section>';
    });
    html += '<footer>卍 Press <kbd>Esc</kbd> to dismiss</footer></div>';
    hotkeysDom = document.createElement('div');
    hotkeysDom.className = 'cmdk-hk-backdrop';
    hotkeysDom.hidden = true;
    hotkeysDom.innerHTML = html;
    document.body.appendChild(hotkeysDom);
    hotkeysDom.addEventListener('click', function (e) {
      if (e.target === hotkeysDom || e.target.closest('[data-close]')) closeHotkeys();
    });
    return hotkeysDom;
  }
  function openHotkeys() {
    buildHotkeys();
    hotkeysDom.hidden = false;
    void hotkeysDom.offsetWidth;
    hotkeysDom.classList.add('cmdk-visible');
  }
  function closeHotkeys() {
    if (!hotkeysDom) return;
    hotkeysDom.classList.remove('cmdk-visible');
    hotkeysDom.hidden = true;
  }

  // ---------- global keyboard handler -------------------------------------
  function installKeyHandler() {
    document.addEventListener('keydown', function (e) {
      var isMod = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl + K => toggle palette
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (state.open) close(); else open();
        return;
      }
      // '?' (no modifier) when not in input => hotkey overlay
      var inField = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (!inField && e.key === '?' && !isMod && !e.altKey) {
        e.preventDefault();
        openHotkeys();
        return;
      }
      // Esc closes hotkey overlay
      if (e.key === 'Escape' && hotkeysDom && !hotkeysDom.hidden) {
        e.preventDefault(); closeHotkeys();
      }
    }, true); // capture phase — beats Firefox quick-find
  }

  // ---------- init --------------------------------------------------------
  function init(api) {
    state.api = api;
    loadRecent();
    loadDensity();
    installKeyHandler();
  }

  function markUsed(id) { bumpRecent(id); }

  root.CmdK = {
    init: init,
    open: open,
    close: close,
    markUsed: markUsed,
    setDensity: setDensity,
    openHotkeys: openHotkeys,
  };
})(window);
