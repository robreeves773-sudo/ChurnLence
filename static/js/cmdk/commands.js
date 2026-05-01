/* Command registry for ChurnLence's Cmd-K palette.
 * Commands are built lazily so they always reflect current state (current
 * portfolio, current watchlist, etc.).  Each command has:
 *   - id: stable unique key (used for recency tracking)
 *   - label: text shown in the row
 *   - hint: short keyboard / category hint
 *   - cat: category bucket ('Tickers', 'Tabs', 'Actions', 'View', 'Settings')
 *   - icon: optional unicode glyph (kept simple, no SVG dep)
 *   - keywords: extra search aliases
 *   - run: function called when the command is selected; receives args parsed
 *          from the input string (e.g. ">sell sol 5" -> {tail: "sol 5", parts: ["sol","5"]})
 */
(function (root) {
  'use strict';

  function buildTickerCommands(api) {
    // Pull tickers from current snapshot rows + watchlist + a static fallback.
    var seen = new Set();
    var out = [];
    function push(sym, name) {
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      out.push({
        id: 'tk:' + sym,
        label: sym,
        sub: name || '',
        hint: '↵ chart',
        cat: 'Tickers',
        icon: '◆',
        keywords: name ? (name + ' ' + sym).toLowerCase() : '',
        run: function () { api.openChart(sym); },
      });
    }
    var snap = api.snapshot();
    if (snap && snap.rows) snap.rows.forEach(function (r) { push(r.symbol, r.name); });
    var wl = api.watchlist();
    if (wl) wl.forEach(function (sym) { push(sym, ''); });
    // Curated fallback so empty portfolios still get useful results
    var defaults = [
      ['BTC-USD','Bitcoin'], ['ETH-USD','Ethereum'], ['SOL-USD','Solana'],
      ['XRP-USD','XRP'], ['DOGE-USD','Dogecoin'], ['ADA-USD','Cardano'],
      ['SHIB-USD','Shiba Inu'], ['PEPE-USD','Pepe'], ['BONK-USD','Bonk'],
      ['WIF-USD','dogwifhat'], ['ZBCN-USD','Zebec Network'], ['JUP-USD','Jupiter'],
      ['VET-USD','VeChain'], ['ALGO-USD','Algorand'], ['XLM-USD','Stellar'],
      ['HBAR-USD','Hedera'], ['CRO-USD','Cronos'], ['FLOKI-USD','Floki'],
      ['PENGU-USD','Pudgy Penguins'], ['ZORA-USD','Zora'],
    ];
    defaults.forEach(function (t) { push(t[0], t[1]); });
    return out;
  }

  function buildTabCommands(api) {
    var tabs = [
      ['overview',  'Overview',  '1'],
      ['holdings',  'Holdings',  '2'],
      ['charts',    'Charts',    '3'],
      ['signals',   'Signals',   '4'],
      ['watchlist', 'Watchlist', '5'],
      ['planner',   'Planner',   '6'],
      ['backtest',  'Backtest',  '7'],
      ['scanner',   'Scanner',   '8'],
    ];
    return tabs.map(function (t) {
      return {
        id: 'tab:' + t[0],
        label: t[1],
        sub: 'Go to ' + t[1] + ' tab',
        hint: t[2],
        cat: 'Tabs',
        icon: '▸',
        keywords: t[0] + ' ' + t[1].toLowerCase(),
        run: function () { api.setTab(t[0]); },
      };
    });
  }

  function buildActionCommands(api) {
    return [
      { id: 'act:add', label: '> add <ticker>', sub: 'Add to watchlist',
        cat: 'Actions', icon: '＋', keywords: 'add watch follow',
        prefix: '>add', run: function (args) {
          var sym = (args && args.parts[0] || '').toUpperCase();
          if (!sym) return api.toast('Usage: >add SOL', 'info');
          if (sym.indexOf('-') < 0) sym += '-USD';
          api.addToWatchlist(sym);
        } },
      { id: 'act:sell', label: '> sell <ticker> [shares]', sub: 'Open sell modal',
        cat: 'Actions', icon: '⤓', keywords: 'sell close exit',
        prefix: '>sell', run: function (args) {
          var sym = (args && args.parts[0] || '').toUpperCase();
          if (!sym) return api.toast('Usage: >sell SOL 5', 'info');
          if (sym.indexOf('-') < 0) sym += '-USD';
          api.openSellModal(sym, args.parts[1]);
        } },
      { id: 'act:buy', label: '+ Add position', sub: 'Open add-position modal',
        cat: 'Actions', icon: '＋', keywords: 'buy add position new',
        run: function () { api.openAddPosition(); } },
      { id: 'act:scan', label: 'Open scanner', sub: 'Memecoin scanner',
        cat: 'Actions', icon: '⌕', keywords: 'scan scanner pump memecoin',
        run: function () { api.setTab('scanner'); } },
      { id: 'act:refresh', label: 'Refresh data', sub: 'Reload portfolio + watchlist',
        cat: 'Actions', icon: '↻', hint: 'R', keywords: 'refresh reload sync',
        run: function () { api.refresh(); } },
      { id: 'act:export', label: 'Export portfolio CSV', sub: 'Download as .csv',
        cat: 'Actions', icon: '⤓', keywords: 'export csv download',
        run: function () { api.exportCsv(); } },
      { id: 'act:import', label: 'Import CSV', sub: 'Upload broker export',
        cat: 'Actions', icon: '⤒', keywords: 'import upload csv',
        run: function () { api.openImport(); } },
      { id: 'act:alerts', label: 'Email & Discord alerts', sub: 'Configure notifications',
        cat: 'Actions', icon: '◉', keywords: 'alert notify email discord',
        run: function () { api.openAlerts(); } },
      { id: 'act:ai', label: 'Ask AI Copilot', sub: 'Claude Haiku — explain signals, summarise coins, draft journal',
        cat: 'Actions', icon: '⚡', hint: 'Ctrl+J', keywords: 'ai chat copilot claude llm assistant ask help',
        run: function () { if (window.AICopilot) window.AICopilot.open(); } },
      { id: 'act:ai:settings', label: 'AI Copilot · API key', sub: 'Add or update your Anthropic / OpenAI key',
        cat: 'Settings', icon: '⚙', keywords: 'ai key api anthropic openai claude config settings',
        run: function () { if (window.AICopilot) window.AICopilot.openSettings(); } },
    ];
  }

  function buildViewCommands(api) {
    return [
      { id: 'view:swing', label: 'Mode · SWING (始解 Shikai)', sub: 'Daily candles · 9/21/50/200 EMA',
        cat: 'View', icon: '◐', keywords: 'shikai swing daily slow',
        run: function () { api.setMode('swing'); } },
      { id: 'view:bankai', label: 'Mode · BANKAI (卍解)', sub: '15-min candles · faster signals · tighter stops',
        cat: 'View', icon: '◑', keywords: 'bankai day intraday fast',
        run: function () { api.setMode('day'); } },
      { id: 'view:density:cozy', label: 'Density · Comfortable', sub: 'Default row height',
        cat: 'View', icon: '☰', keywords: 'cozy density spacious',
        run: function () { api.setDensity('cozy'); } },
      { id: 'view:density:compact', label: 'Density · Compact', sub: 'Tighter rows',
        cat: 'View', icon: '☱', keywords: 'compact density tight',
        run: function () { api.setDensity('compact'); } },
      { id: 'view:density:dense', label: 'Density · Dense', sub: 'Maximum rows on screen',
        cat: 'View', icon: '☲', keywords: 'dense bloomberg packed',
        run: function () { api.setDensity('dense'); } },
      { id: 'view:mute', label: 'Toggle sound', sub: 'Mute / unmute audio cues',
        cat: 'View', icon: '🔔', hint: 'M', keywords: 'mute unmute sound audio',
        run: function () { api.toggleSound(); } },
      { id: 'view:notify', label: 'Toggle desktop notifications', sub: 'Browser push for BUY/SELL',
        cat: 'View', icon: '🖥', keywords: 'notify push desktop',
        run: function () { api.toggleNotify(); } },
    ];
  }

  function buildHelpCommands(api) {
    return [
      { id: 'help:shortcuts', label: 'Keyboard shortcuts', sub: 'Show all hotkeys',
        cat: 'Settings', icon: '?', hint: '?', keywords: 'help shortcuts hotkeys cheatsheet',
        run: function () { api.openHotkeys(); } },
    ];
  }

  function buildAll(api) {
    return [].concat(
      buildTickerCommands(api),
      buildTabCommands(api),
      buildActionCommands(api),
      buildViewCommands(api),
      buildHelpCommands(api)
    );
  }

  root.CmdKCommands = { buildAll: buildAll };
})(window);
