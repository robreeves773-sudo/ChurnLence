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
  var MAX_HISTORY = 24; // 12 turns each side

  var state = {
    api: null,
    open: false,
    history: [],     // [{role, content, ts}]
    sending: false,
    prevFocus: null,
    configured: false,
  };

  function loadHistory() {
    try { state.history = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]'); }
    catch (e) { state.history = []; }
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_HISTORY, JSON.stringify(state.history.slice(-MAX_HISTORY))); }
    catch (e) { /* ignore */ }
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
    };
    dom.overlay.addEventListener('click', close);
    wrap.querySelector('#ai-close-btn').addEventListener('click', close);
    wrap.querySelector('#ai-clear-btn').addEventListener('click', clearConversation);
    wrap.querySelector('#ai-settings-btn').addEventListener('click', openSettings);
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
        if (data.error) {
          state.history.push({ role: 'assistant', content: '⚠ ' + data.error, ts: Date.now() });
        } else {
          state.history.push({ role: 'assistant', content: data.reply || '(no reply)', ts: Date.now() });
        }
        if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
        saveHistory();
        renderConversation();
        buildSuggestions();
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
      '    <details open><summary>Get a key (free signup)</summary>' +
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
      '  <p class="ai-settings-foot">' +
      '    Stored at: <code class="ai-config-path" id="ai-config-path">…</code>' +
      '  </p>' +
      '</div>';
    document.body.appendChild(settingsDom);
    settingsDom.addEventListener('click', function (e) {
      if (e.target === settingsDom || e.target.closest('[data-close]')) closeSettings();
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
  };
})(window);
