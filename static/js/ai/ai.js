/* ChurnLence AI Copilot — chat drawer + settings modal.
 *
 * Public API:
 *   AICopilot.init(api)        - boot once with the same hooks Cmd-K uses
 *   AICopilot.open(prefill)    - open the drawer; optional pre-filled prompt
 *   AICopilot.close()          - close
 *   AICopilot.openSettings()   - show the API key settings modal
 *
 * Wave 7 designed this — the LLM is a research/explanation copilot, never
 * a signal generator or price predictor.  Hard rules in the system prompt.
 */
(function (root) {
  'use strict';

  var STORAGE_HISTORY = 'cl.ai.history';
  var STORAGE_VOICE   = 'cl.ai.voice';   // {input:bool, output:bool, rate:number}
  var MAX_HISTORY = 24; // 12 turns each side

  var state = {
    api: null,
    open: false,
    history: [],     // [{role, content, ts}]
    sending: false,
    prevFocus: null,
    configured: false,
    recognition: null,        // active SpeechRecognition instance
    recognizing: false,
    voice: { input: false, output: false, rate: 1.0 },
    lastProactiveTs: 0,       // throttle proactive bubbles to 1/10min
  };

  // --- destructive action allowlist (require explicit Run click) ----------
  var DESTRUCTIVE_ACTIONS = { sell: 1, delete_thesis: 1, delete_alert_rule: 1,
                              remove_from_watchlist: 1, confirm: 1 };
  // Safe read-only allowlist (auto-run after 800ms unless user clicks Skip)
  var SAFE_ACTIONS = { add_to_watchlist: 1, open_chart: 1, set_tab: 1,
                       set_mode: 1, refresh: 1, summarize_holdings: 1,
                       create_alert_rule: 1 };

  function loadHistory() {
    try { state.history = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]'); }
    catch (e) { state.history = []; }
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_HISTORY, JSON.stringify(state.history.slice(-MAX_HISTORY))); }
    catch (e) { /* ignore */ }
  }
  function loadVoicePrefs() {
    try {
      var v = JSON.parse(localStorage.getItem(STORAGE_VOICE) || '{}');
      state.voice = { input: !!v.input, output: !!v.output,
                      rate: Number(v.rate) || 1.0 };
    } catch (e) { /* keep defaults */ }
  }
  function saveVoicePrefs() {
    try { localStorage.setItem(STORAGE_VOICE, JSON.stringify(state.voice)); }
    catch (e) { /* ignore */ }
  }

  // ---------- Web Speech API ------------------------------------------------
  function speechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  function startListening() {
    if (state.recognizing) return;
    var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) return;
    var r = new Rec();
    r.continuous = false;
    r.interimResults = true;
    r.lang = 'en-US';
    state.recognition = r;
    state.recognizing = true;
    if (dom && dom.mic) dom.mic.classList.add('on');
    r.onresult = function (e) {
      var t = '';
      for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      if (dom && dom.input) dom.input.value = t;
    };
    r.onend = function () {
      state.recognizing = false;
      if (dom && dom.mic) dom.mic.classList.remove('on');
      // Auto-send if there's a transcript and "voice mode" is on
      if (dom && dom.input && dom.input.value.trim() && state.voice.input) {
        sendMessage(dom.input.value);
      }
    };
    r.onerror = function () {
      state.recognizing = false;
      if (dom && dom.mic) dom.mic.classList.remove('on');
    };
    try { r.start(); } catch (e) { state.recognizing = false; }
  }
  function stopListening() {
    if (state.recognition) { try { state.recognition.stop(); } catch (e) {} }
  }
  function speak(text) {
    if (!state.voice.output || !window.speechSynthesis) return;
    // Strip action blocks and markdown so we don't read brackets aloud
    var clean = String(text || '').replace(/\[\[ACTION:[^\]]+\]\]/g, '')
                                   .replace(/\*\*([^*]+)\*\*/g, '$1')
                                   .replace(/`([^`]+)`/g, '$1');
    if (!clean.trim()) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(clean);
      u.rate = state.voice.rate || 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  // Tiny markdown-lite: **bold**, `code`, line breaks
  function renderMd(text) {
    var s = escapeHtml(text);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\n/g, '<br/>');
    return s;
  }

  // ---------- DOM -----------------------------------------------------------
  var dom = null;
  function buildDom() {
    if (dom) return dom;
    var wrap = document.createElement('div');
    wrap.className = 'ai-drawer';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="ai-overlay"></div>' +
      '<aside class="ai-panel" role="dialog" aria-label="AI Copilot">' +
      '  <header class="ai-head">' +
      '    <div class="ai-title">' +
      '      <span class="ai-icon">⚡</span>' +
      '      <div><strong>AI Copilot</strong>' +
      '        <span class="ai-status" id="ai-status">demo mode</span></div>' +
      '    </div>' +
      '    <div class="ai-actions">' +
      '      <button class="icon-btn ai-mic-btn" id="ai-mic-btn" title="Push to talk (Web Speech)">🎙</button>' +
      '      <button class="icon-btn" id="ai-clear-btn" title="Clear conversation">⌫</button>' +
      '      <button class="icon-btn" id="ai-settings-btn" title="API key settings">⚙</button>' +
      '      <button class="icon-btn" id="ai-close-btn" title="Close (Esc)">✕</button>' +
      '    </div>' +
      '  </header>' +
      '  <div class="ai-suggestions" id="ai-suggestions"></div>' +
      '  <div class="ai-conversation" id="ai-conversation"></div>' +
      '  <form class="ai-input-row" id="ai-input-row">' +
      '    <textarea class="ai-input" id="ai-input" rows="1"' +
      '              placeholder="Ask about your portfolio, signals, indicators…"></textarea>' +
      '    <button type="submit" class="ai-send" id="ai-send" title="Send (Enter)">' +
      '      <span class="ai-send-glyph">▸</span>' +
      '    </button>' +
      '  </form>' +
      '  <div class="ai-footer">' +
      '    Claude Haiku · plain English · never predicts prices' +
      '  </div>' +
      '</aside>';
    document.body.appendChild(wrap);
    dom = {
      wrap: wrap,
      overlay: wrap.querySelector('.ai-overlay'),
      panel: wrap.querySelector('.ai-panel'),
      status: wrap.querySelector('#ai-status'),
      suggestions: wrap.querySelector('#ai-suggestions'),
      conversation: wrap.querySelector('#ai-conversation'),
      form: wrap.querySelector('#ai-input-row'),
      input: wrap.querySelector('#ai-input'),
      send: wrap.querySelector('#ai-send'),
      mic: wrap.querySelector('#ai-mic-btn'),
    };
    dom.overlay.addEventListener('click', close);
    wrap.querySelector('#ai-close-btn').addEventListener('click', close);
    wrap.querySelector('#ai-clear-btn').addEventListener('click', clearConversation);
    wrap.querySelector('#ai-settings-btn').addEventListener('click', openSettings);
    if (!speechSupported()) {
      dom.mic.style.display = 'none';
    } else {
      dom.mic.addEventListener('click', function () {
        if (state.recognizing) stopListening(); else startListening();
      });
    }
    dom.form.addEventListener('submit', function (e) {
      e.preventDefault();
      sendMessage(dom.input.value);
    });
    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(dom.input.value);
      }
    });
    // Auto-grow textarea up to 5 lines
    dom.input.addEventListener('input', function () {
      dom.input.style.height = 'auto';
      dom.input.style.height = Math.min(dom.input.scrollHeight, 120) + 'px';
    });
    return dom;
  }

  // ---------- suggestions ---------------------------------------------------
  function buildSuggestions() {
    if (!dom) return;
    // Context-aware suggestions based on current state
    var sug = [];
    var snap = state.api && state.api.snapshot && state.api.snapshot();
    var chartSym = state.api && state.api.chartSymbol && state.api.chartSymbol();

    if (chartSym) {
      sug.push('Why is ' + chartSym + ' on its current signal?');
      sug.push('Summarise ' + chartSym);
    }
    if (snap && snap.rows && snap.rows.length) {
      var buys = snap.rows.filter(function (r) { return r.signal === 'BUY'; });
      if (buys.length) sug.push("What's flagged BUY in my portfolio?");
      sug.push('How is my P/L looking?');
    }
    if (sug.length < 4) {
      sug.push('Explain MACD');
      sug.push('Explain RSI');
      sug.push('What does BANKAI mode change?');
      sug.push('How do I use the planner?');
    }
    sug = sug.slice(0, 4);
    dom.suggestions.innerHTML = sug.map(function (s) {
      return '<button class="ai-suggestion" data-text="' + escapeHtml(s) + '">' +
             escapeHtml(s) + '</button>';
    }).join('');
    dom.suggestions.querySelectorAll('.ai-suggestion').forEach(function (b) {
      b.addEventListener('click', function () { sendMessage(b.dataset.text); });
    });
  }

  // ---------- render conversation -------------------------------------------
  function renderConversation(thinking) {
    if (!dom) return;
    var html = state.history.map(function (m) {
      var who = m.role === 'user' ? 'you' : 'ai';
      var avatar = m.role === 'user' ? '👤' : '⚡';
      return '<div class="ai-msg ai-msg-' + who + '">' +
        '<div class="ai-msg-avatar">' + avatar + '</div>' +
        '<div class="ai-msg-body">' + renderMd(m.content) + '</div>' +
      '</div>';
    }).join('');
    if (thinking) {
      html += '<div class="ai-msg ai-msg-ai ai-thinking">' +
              '  <div class="ai-msg-avatar">⚡</div>' +
              '  <div class="ai-msg-body">' +
              '    <span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
              '  </div></div>';
    }
    if (!html) {
      html = '<div class="ai-empty">' +
             '  Ask me anything about your portfolio, signals, or indicators.' +
             '  I can explain why a signal fired, summarise a coin from live data, ' +
             '  or walk you through any feature in ChurnLence.' +
             '  <br/><br/><em>Hard rule: I never predict prices and never tell you what to trade.</em>' +
             '</div>';
    }
    dom.conversation.innerHTML = html;
    dom.conversation.scrollTop = dom.conversation.scrollHeight;
  }

  // ---------- agentic action chips ------------------------------------------
  // Parse [[ACTION:name|<json args>]] blocks from a model reply.  Returns a
  // list of {name, args}.  Malformed args fall back to {} so we never throw.
  function parseActions(text) {
    var out = [];
    var re = /\[\[ACTION:([A-Za-z_]+)\|([^\]]*?)\]\]/g;
    var m;
    while ((m = re.exec(text || '')) !== null) {
      var name = m[1];
      var raw = (m[2] || '').trim();
      var args = {};
      if (raw) {
        try { args = JSON.parse(raw); }
        catch (e) { args = { _raw: raw }; }
      }
      out.push({ name: name, args: args });
      if (out.length >= 5) break; // cap per reply
    }
    return out;
  }

  function executeAction(action) {
    var hooks = (state.api && state.api.actions) || {};
    var fn = hooks[action.name];
    if (!fn) return { ok: false, msg: 'unknown action "' + action.name + '"' };
    try {
      var res = fn(action.args || {});
      if (res && typeof res.then === 'function') {
        return { ok: true, msg: 'pending' };
      }
      return { ok: true, msg: 'done' };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : 'failed' };
    }
  }

  function renderActionChips(actions) {
    if (!dom) return;
    var bubble = document.createElement('div');
    bubble.className = 'ai-msg ai-msg-actions';
    bubble.innerHTML = '<div class="ai-msg-avatar">⚙</div>' +
                       '<div class="ai-msg-body"><div class="ai-actions-list"></div></div>';
    dom.conversation.appendChild(bubble);
    var listEl = bubble.querySelector('.ai-actions-list');
    actions.forEach(function (action) {
      var safe = SAFE_ACTIONS[action.name];
      var destructive = DESTRUCTIVE_ACTIONS[action.name];
      var chip = document.createElement('div');
      chip.className = 'ai-action-chip' + (destructive ? ' destructive' : '');
      var pretty = action.name + '(' + JSON.stringify(action.args || {}) + ')';
      chip.innerHTML =
        '<code>' + escapeHtml(pretty) + '</code>' +
        '<button type="button" class="ai-act-run">Run</button>' +
        '<button type="button" class="ai-act-skip">Skip</button>' +
        '<span class="ai-act-status"></span>';
      listEl.appendChild(chip);

      var run    = chip.querySelector('.ai-act-run');
      var skip   = chip.querySelector('.ai-act-skip');
      var status = chip.querySelector('.ai-act-status');
      var done = false;
      function doRun() {
        if (done) return;
        done = true;
        run.disabled = true; skip.disabled = true;
        var r = executeAction(action);
        status.textContent = r.ok ? '✓ ' + r.msg : '⚠ ' + r.msg;
        status.className = 'ai-act-status ' + (r.ok ? 'ok' : 'err');
      }
      function doSkip() {
        if (done) return;
        done = true;
        run.disabled = true; skip.disabled = true;
        status.textContent = 'skipped';
        status.className = 'ai-act-status';
      }
      run.addEventListener('click', doRun);
      skip.addEventListener('click', doSkip);
      // Safe + non-destructive auto-run after 800 ms
      if (safe && !destructive) {
        setTimeout(function () { if (!done) doRun(); }, 800);
      }
    });
    dom.conversation.scrollTop = dom.conversation.scrollHeight;
  }

  // Surface a proactive bubble (e.g. signal flip) in the drawer.  Throttled
  // to once per 10 min so we don't drown the user in noise.
  function pushProactive(text) {
    if (!text) return;
    var now = Date.now();
    if (now - state.lastProactiveTs < 10 * 60 * 1000) return;
    state.lastProactiveTs = now;
    state.history.push({ role: 'assistant', content: '💡 ' + text, ts: now,
                         proactive: true });
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
    saveHistory();
    if (state.open) {
      renderConversation();
    }
  }

  // ---------- send ----------------------------------------------------------
  function sendMessage(raw) {
    var text = (raw || '').trim();
    if (!text || state.sending) return;
    state.history.push({ role: 'user', content: text, ts: Date.now() });
    saveHistory();
    dom.input.value = '';
    dom.input.style.height = 'auto';
    state.sending = true;
    dom.send.disabled = true;
    renderConversation(true);

    var payload = {
      message: text,
      history: state.history.slice(-MAX_HISTORY, -1),  // exclude the just-pushed turn
      chart_symbol: state.api && state.api.chartSymbol && state.api.chartSymbol(),
      portfolio_id: state.api && state.api.portfolioId && state.api.portfolioId(),
      mode:         state.api && state.api.mode && state.api.mode(),
    };

    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        state.sending = false;
        dom.send.disabled = false;
        var reply;
        if (data.error) {
          reply = '⚠ ' + data.error;
          state.history.push({ role: 'assistant', content: reply, ts: Date.now() });
        } else {
          reply = data.reply || '(no reply)';
          state.history.push({ role: 'assistant', content: reply, ts: Date.now() });
        }
        if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
        saveHistory();
        renderConversation();
        buildSuggestions();
        // Voice readback (action tags stripped inside speak())
        speak(reply);
        // Parse and surface any tool-call blocks
        var actions = parseActions(reply);
        if (actions.length) renderActionChips(actions);
      })
      .catch(function (err) {
        state.sending = false;
        dom.send.disabled = false;
        state.history.push({ role: 'assistant', content: '⚠ Network error: ' + err.message, ts: Date.now() });
        renderConversation();
      });
  }

  function clearConversation() {
    if (!state.history.length) return;
    if (!confirm('Clear the conversation?')) return;
    state.history = [];
    saveHistory();
    renderConversation();
  }

  // ---------- open / close --------------------------------------------------
  function loadConfigStatus() {
    fetch('/api/ai/config').then(function (r) { return r.json(); })
      .then(function (cfg) {
        state.configured = !!cfg.configured;
        if (dom && dom.status) {
          if (cfg.configured) {
            dom.status.textContent = (cfg.provider || 'anthropic') + ' · ' + (cfg.model || 'claude-haiku-4-5');
            dom.status.className = 'ai-status ai-status-on';
          } else {
            dom.status.textContent = 'demo mode · click ⚙ to add a key';
            dom.status.className = 'ai-status';
          }
        }
      }).catch(function () { /* ignore */ });
  }

  function open(prefill) {
    buildDom();
    if (state.open) {
      if (prefill) { dom.input.value = prefill; dom.input.focus(); }
      return;
    }
    state.prevFocus = document.activeElement;
    dom.wrap.hidden = false;
    void dom.wrap.offsetWidth;
    dom.wrap.classList.add('ai-open');
    state.open = true;
    loadConfigStatus();
    renderConversation();
    buildSuggestions();
    setTimeout(function () {
      if (prefill) { dom.input.value = prefill; }
      dom.input.focus();
    }, 80);
  }
  function close() {
    if (!state.open || !dom) return;
    dom.wrap.classList.remove('ai-open');
    setTimeout(function () { if (!state.open) dom.wrap.hidden = true; }, 200);
    state.open = false;
    if (state.prevFocus && typeof state.prevFocus.focus === 'function') {
      try { state.prevFocus.focus(); } catch (e) { /* ignore */ }
    }
  }

  // ---------- settings modal -----------------------------------------------
  var settingsDom = null;
  function buildSettings() {
    if (settingsDom) return settingsDom;
    settingsDom = document.createElement('div');
    settingsDom.className = 'ai-settings-backdrop';
    settingsDom.hidden = true;
    settingsDom.innerHTML =
      '<div class="ai-settings-modal" role="dialog" aria-label="AI settings">' +
      '  <header><h2>AI Copilot · Settings</h2><button class="icon-btn" data-close>✕</button></header>' +
      '  <p class="ai-settings-intro">' +
      '    ChurnLence calls the LLM with your <strong>own API key</strong> — keys are stored locally on your machine and never sent anywhere except the LLM provider.' +
      '  </p>' +
      '  <section class="ai-providers">' +
      '    <details><summary>Get a key (free signup)</summary>' +
      '      <ol>' +
      '        <li><strong>Anthropic (Claude — recommended):</strong> sign up at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>, add a payment method, generate a key starting <code>sk-ant-…</code>. <em>Cost: ~$0.0005 per chat message at typical use.</em></li>' +
      '        <li><strong>OpenAI:</strong> sign up at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>, generate a key starting <code>sk-…</code>. Used for gpt-4o-mini.</li>' +
      '      </ol>' +
      '    </details>' +
      '  </section>' +
      '  <form id="ai-settings-form">' +
      '    <label>API key' +
      '      <input type="password" name="api_key" placeholder="sk-ant-… (Anthropic) or sk-… (OpenAI)" autocomplete="off" />' +
      '    </label>' +
      '    <label>Model (optional override)' +
      '      <input type="text" name="model" placeholder="claude-haiku-4-5  ·  gpt-4o-mini  ·  claude-sonnet-4-6" autocomplete="off" />' +
      '    </label>' +
      '    <div class="ai-settings-status" id="ai-settings-status"></div>' +
      '    <div class="ai-settings-actions">' +
      '      <button type="button" class="ghost-btn" data-close>Cancel</button>' +
      '      <button type="submit" class="primary-btn">Save</button>' +
      '    </div>' +
      '  </form>' +
      '  <hr class="ai-settings-divider"/>' +
      '  <section class="ai-jarvis">' +
      '    <h3>Jarvis · voice &amp; memory</h3>' +
      '    <div class="ai-voice-row">' +
      '      <label><input type="checkbox" id="ai-voice-in"/>  🎙 Auto-send after I stop talking</label>' +
      '      <label><input type="checkbox" id="ai-voice-out"/> 🔊 Read replies aloud</label>' +
      '      <label>Voice rate <input type="range" id="ai-voice-rate" min="0.6" max="1.5" step="0.1" /></label>' +
      '    </div>' +
      '    <h4>What Jarvis remembers</h4>' +
      '    <div class="ai-memory-list" id="ai-memory-list"><em>Loading…</em></div>' +
      '    <form id="ai-memory-form" class="ai-memory-form">' +
      '      <select name="kind">' +
      '        <option value="preference">preference</option>' +
      '        <option value="fact" selected>fact</option>' +
      '      </select>' +
      '      <input name="value" placeholder="e.g. I prefer conservative position sizing" />' +
      '      <button type="submit" class="ghost-btn">+ Remember</button>' +
      '    </form>' +
      '  </section>' +
      '  <p class="ai-settings-foot">' +
      '    Stored at: <code class="ai-config-path" id="ai-config-path">…</code>' +
      '  </p>' +
      '</div>';
    document.body.appendChild(settingsDom);
    settingsDom.addEventListener('click', function (e) {
      if (e.target === settingsDom || e.target.closest('[data-close]')) closeSettings();
    });
    // Voice toggles
    var vIn = settingsDom.querySelector('#ai-voice-in');
    var vOut = settingsDom.querySelector('#ai-voice-out');
    var vRate = settingsDom.querySelector('#ai-voice-rate');
    vIn.checked  = state.voice.input;
    vOut.checked = state.voice.output;
    vRate.value  = state.voice.rate;
    vIn.addEventListener('change',  function () { state.voice.input  = vIn.checked;  saveVoicePrefs(); });
    vOut.addEventListener('change', function () { state.voice.output = vOut.checked; saveVoicePrefs(); });
    vRate.addEventListener('input', function () { state.voice.rate = parseFloat(vRate.value) || 1.0; saveVoicePrefs(); });
    // Memory form
    settingsDom.querySelector('#ai-memory-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var pid = state.api && state.api.portfolioId && state.api.portfolioId();
      if (!pid) return;
      var payload = {
        kind:  f.elements.kind.value,
        value: f.elements.value.value.trim(),
      };
      if (!payload.value) return;
      fetch('/api/portfolios/' + pid + '/jarvis/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); }).then(function () {
        f.elements.value.value = '';
        loadMemoryList();
      });
    });
    settingsDom.querySelector('#ai-settings-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var payload = {
        api_key: f.elements.api_key.value.trim(),
        model:   f.elements.model.value.trim() || undefined,
      };
      var st = settingsDom.querySelector('#ai-settings-status');
      st.textContent = 'Saving…';
      fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data.error) { st.textContent = '⚠ ' + data.error; st.style.color = 'var(--hollow-red)'; return; }
        st.textContent = data.configured
          ? '✓ Saved.  ' + (data.provider || 'anthropic') + ' · ' + (data.model || 'claude-haiku-4-5')
          : '✓ Cleared.  Now in demo mode.';
        st.style.color = 'var(--lime)';
        loadConfigStatus();
        setTimeout(closeSettings, 1200);
      }).catch(function (err) { st.textContent = '⚠ ' + err.message; st.style.color = 'var(--hollow-red)'; });
    });
    return settingsDom;
  }
  function loadMemoryList() {
    var pid = state.api && state.api.portfolioId && state.api.portfolioId();
    var host = settingsDom && settingsDom.querySelector('#ai-memory-list');
    if (!host) return;
    if (!pid) { host.innerHTML = '<em>No portfolio selected.</em>'; return; }
    fetch('/api/portfolios/' + pid + '/jarvis/memory')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rows = (data && data.memory) || [];
        if (!rows.length) {
          host.innerHTML = '<em>Nothing remembered yet — add a fact below.</em>';
          return;
        }
        host.innerHTML = rows.map(function (m) {
          return '<div class="ai-mem-row">' +
                 '  <span class="ai-mem-kind">' + escapeHtml(m.kind) + '</span>' +
                 '  <span class="ai-mem-val">' + escapeHtml(m.value) + '</span>' +
                 '  <button class="link-btn" data-mem-del="' + m.id + '">forget</button>' +
                 '</div>';
        }).join('');
        host.querySelectorAll('[data-mem-del]').forEach(function (b) {
          b.addEventListener('click', function () {
            fetch('/api/portfolios/' + pid + '/jarvis/memory/' + b.dataset.memDel,
                  { method: 'DELETE' })
              .then(loadMemoryList);
          });
        });
      })
      .catch(function () { host.innerHTML = '<em>Failed to load.</em>'; });
  }

  function openSettings() {
    buildSettings();
    settingsDom.hidden = false;
    void settingsDom.offsetWidth;
    settingsDom.classList.add('ai-open');
    fetch('/api/ai/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var f = settingsDom.querySelector('#ai-settings-form');
      f.elements.api_key.placeholder = cfg.key_preview
        ? 'currently saved: ' + cfg.key_preview + '  (paste a new key to replace)'
        : 'sk-ant-… (Anthropic) or sk-… (OpenAI)';
      f.elements.model.value = cfg.model || '';
      settingsDom.querySelector('#ai-config-path').textContent = cfg.config_path || '';
    });
    loadMemoryList();
  }
  function closeSettings() {
    if (!settingsDom) return;
    settingsDom.classList.remove('ai-open');
    setTimeout(function () { settingsDom.hidden = true; }, 200);
  }

  // ---------- init ----------------------------------------------------------
  function init(api) {
    state.api = api;
    loadHistory();
    loadVoicePrefs();
    // Floating button — sits bottom-right, always visible
    var fab = document.createElement('button');
    fab.className = 'ai-fab';
    fab.title = 'AI Copilot — ask about your portfolio (Ctrl+J)';
    fab.innerHTML = '<span>⚡</span><span class="ai-fab-label">Ask AI</span>';
    fab.addEventListener('click', function () { open(); });
    document.body.appendChild(fab);
    // Keyboard: Ctrl/Cmd+J opens AI; Esc closes
    document.addEventListener('keydown', function (e) {
      var inField = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (state.open) close(); else open();
      }
      if (state.open && e.key === 'Escape' && !inField) close();
    }, true);
  }

  root.AICopilot = {
    init: init,
    open: open,
    close: close,
    openSettings: openSettings,
    pushProactive: pushProactive,
  };
})(window);
