/*
 * popup.js — postMessage Tracker popup UI
 * Renders listeners, messages, senders with security analysis.
 */
(function() {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────
  var port = null;
  var currentTabId = -1;
  var currentTabUrl = '';
  var tabListeners = [];
  var tabMessages = [];
  var tabSenders = [];
  var activeTab = 'listeners';
  var searchQuery = '';
  var confidenceFilter = 'all';

  // ── Init ──────────────────────────────────────────────────────────

  window.onload = function() {
    initTheme();
    setupTabs();
    setupFilters();
    setupPoc();
    setupActions();
    connectToBackground();
  };

  // ── Theme ─────────────────────────────────────────────────────────

  function initTheme() {
    chrome.storage.sync.get({theme: 'dark'}, function(items) {
      if (items.theme === 'light') document.body.classList.add('light-mode');
    });
    document.getElementById('btn-theme').addEventListener('click', function() {
      document.body.classList.toggle('light-mode');
      chrome.storage.sync.set({
        theme: document.body.classList.contains('light-mode') ? 'light' : 'dark'
      });
    });
  }

  // ── Tab navigation ────────────────────────────────────────────────

  function setupTabs() {
    var btns = document.querySelectorAll('.tab-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        btns.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeTab = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-view').forEach(function(v) { v.classList.remove('active'); });
        document.getElementById('tab-' + activeTab).classList.add('active');
      });
    });
  }

  // ── Filters ───────────────────────────────────────────────────────

  function setupFilters() {
    document.getElementById('search-input').addEventListener('input', function(e) {
      searchQuery = e.target.value.toLowerCase();
      renderListeners();
    });

    document.querySelectorAll('.pill').forEach(function(pill) {
      pill.addEventListener('click', function() {
        document.querySelectorAll('.pill').forEach(function(p) { p.classList.remove('active'); });
        pill.classList.add('active');
        confidenceFilter = pill.getAttribute('data-filter');
        renderListeners();
      });
    });

    document.getElementById('msg-search-input').addEventListener('input', function(e) {
      renderMessages(e.target.value.toLowerCase());
    });

    document.getElementById('sender-search-input').addEventListener('input', function(e) {
      renderSenders(e.target.value.toLowerCase());
    });
  }

  // ── Background connection ─────────────────────────────────────────

  function connectToBackground() {
    port = chrome.runtime.connect({name: 'popup'});

    port.onMessage.addListener(function(msg) {
      if (msg.tabData) {
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
          if (tabs && tabs[0]) {
            currentTabId = tabs[0].id;
            currentTabUrl = tabs[0].url || '';

            var data = msg.tabData[currentTabId];
            tabListeners = (data && data.listeners) ? data.listeners : [];
            tabMessages = (data && data.messages) ? data.messages : [];
            tabSenders = (data && data.senders) ? data.senders : [];

            updateTargetUrl();
            updateCounts();
            updateStats();
            renderListeners();
            renderMessages('');
            renderSenders('');
          }
        });
      }

      if (msg.exportData) {
        downloadJson(msg.exportData);
      }
    });

    port.postMessage('get-data');
  }

  // ── Header & counts ───────────────────────────────────────────────

  function updateTargetUrl() {
    var el = document.getElementById('target-url');
    el.textContent = currentTabUrl ? currentTabUrl : 'No page detected';
  }

  function updateCounts() {
    document.getElementById('count-listeners').textContent = tabListeners.length;
    document.getElementById('count-messages').textContent = tabMessages.length;
    document.getElementById('count-senders').textContent = tabSenders.length;
  }

  function updateStats() {
    var bar = document.getElementById('stats-bar');
    if (tabListeners.length === 0) {
      bar.style.display = 'none';
      return;
    }

    var counts = {critical: 0, high: 0, medium: 0, low: 0, info: 0};
    tabListeners.forEach(function(l) {
      var analysis = Analyzer.classifyListener(l.listenerSource || '');
      counts[analysis.confidence]++;
    });

    bar.style.display = 'flex';
    bar.innerHTML = '';

    if (counts.critical > 0) addStat(bar, 'red', counts.critical + ' critical pattern' + (counts.critical > 1 ? 's' : ''));
    if (counts.high > 0) addStat(bar, 'peach', counts.high + ' high pattern' + (counts.high > 1 ? 's' : ''));
    if (counts.medium > 0) addStat(bar, 'yellow', counts.medium + ' medium pattern' + (counts.medium > 1 ? 's' : ''));
    addStat(bar, 'blue', tabListeners.length + ' total listeners');
    var note = document.createElement('div');
    note.className = 'stat-item';
    note.style.cssText = 'font-style:italic;color:var(--muted);';
    note.textContent = 'Pattern analysis — manual validation required';
    bar.appendChild(note);
    if (tabSenders.length > 0) {
      var wildcards = tabSenders.filter(function(s) { return s.wildcardOrigin; }).length;
      if (wildcards > 0) addStat(bar, 'peach', wildcards + ' wildcard senders');
    }
  }

  function addStat(parent, colorClass, text) {
    var item = document.createElement('div');
    item.className = 'stat-item';
    item.innerHTML = '<span class="stat-dot ' + colorClass + '"></span>' + escapeHtml(text);
    parent.appendChild(item);
  }

  // ── Render: Listeners ─────────────────────────────────────────────

  function renderListeners() {
    var container = document.getElementById('listeners-list');
    container.innerHTML = '';

    if (tabListeners.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📡</div>No postMessage listeners detected on this page.</div>';
      return;
    }

    // Analyze and sort by confidence (critical first)
    var analyzed = tabListeners.map(function(listener) {
      return {
        listener: listener,
        analysis: Analyzer.classifyListener(listener.listenerSource || '')
      };
    });

    var order = {critical: 0, high: 1, medium: 2, low: 3, info: 4};
    analyzed.sort(function(a, b) {
      return (order[a.analysis.confidence] || 4) - (order[b.analysis.confidence] || 4);
    });

    var rendered = 0;
    analyzed.forEach(function(item) {
      var listener = item.listener;
      var analysis = item.analysis;

      // Confidence filter
      if (confidenceFilter !== 'all' && analysis.confidence !== confidenceFilter) return;

      // Search filter
      if (searchQuery) {
        var haystack = [
          listener.pageOrigin || listener.domain || '',
          listener.listenerSource || '',
          (listener.stack || []).join(' '),
          listener.frame || ''
        ].join(' ').toLowerCase();
        if (haystack.indexOf(searchQuery) === -1) return;
      }

      container.appendChild(buildListenerCard(listener, analysis));
      rendered++;
    });

    if (rendered === 0) {
      container.innerHTML = '<div class="empty-state">No listeners match current filters.</div>';
    }
  }

  function buildListenerCard(listener, analysis) {
    var card = document.createElement('div');
    card.className = 'card';
    if (listener.removed) card.style.opacity = '0.55';

    // Header: domain + frame
    var header = document.createElement('div');
    header.className = 'card-header';

    var domain = document.createElement('span');
    domain.className = 'card-domain';
    domain.textContent = listener.pageOrigin || listener.domain || 'unknown';

    var right = document.createElement('span');
    right.className = 'card-frame';
    right.textContent = listener.frame || '';

    header.appendChild(domain);
    header.appendChild(right);
    card.appendChild(header);

    // Confidence badge + wrappers
    var badgeRow = document.createElement('div');
    badgeRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin:4px 0;flex-wrap:wrap;';

    var confBadge = document.createElement('span');
    confBadge.className = 'confidence confidence-' + analysis.confidence;
    confBadge.textContent = analysis.confidence;
    confBadge.title = 'Pattern confidence: ' + analysis.confidence + '. Not a confirmed vulnerability — manual validation required.';
    badgeRow.appendChild(confBadge);

    if (listener.removed) {
      var removedTag = document.createElement('span');
      removedTag.className = 'wrapper-tag';
      removedTag.style.cssText = 'color:var(--red);border-color:var(--red);background:rgba(243,139,168,0.1);';
      removedTag.textContent = 'removed';
      badgeRow.appendChild(removedTag);
    }

    if (listener.once) {
      var onceTag = document.createElement('span');
      onceTag.className = 'wrapper-tag';
      onceTag.textContent = 'once';
      onceTag.title = 'Registered with {once: true} — auto-removed after first dispatch';
      badgeRow.appendChild(onceTag);
    }

    if (listener.registrationMethod && listener.registrationMethod !== 'addEventListener') {
      var methodTag = document.createElement('span');
      methodTag.className = 'wrapper-tag';
      methodTag.textContent = listener.registrationMethod;
      badgeRow.appendChild(methodTag);
    }

    if (listener.wrappers && listener.wrappers.length > 0) {
      listener.wrappers.forEach(function(w) {
        var tag = document.createElement('span');
        tag.className = 'wrapper-tag';
        tag.textContent = w;
        badgeRow.appendChild(tag);
      });
    }

    card.appendChild(badgeRow);

    // Findings
    if (analysis.findings.length > 0) {
      var findingsRow = document.createElement('div');
      findingsRow.className = 'findings-row';

      analysis.findings.forEach(function(f) {
        var badge = document.createElement('span');
        badge.className = 'finding-badge finding-' + f.severity;
        badge.textContent = f.label;
        badge.title = f.detail;
        findingsRow.appendChild(badge);
      });

      card.appendChild(findingsRow);
    }

    // Stack
    if (listener.stack && listener.stack.length > 0) {
      var stackRow = document.createElement('div');
      stackRow.className = 'stack-row';
      stackRow.textContent = listener.stack[0];
      if (listener.fullStack) {
        stackRow.title = listener.fullStack.join('\n');
      }
      card.appendChild(stackRow);
    }

    // Code block (collapsible)
    var code = listener.listenerSource || '';
    var codeBlock = document.createElement('div');
    codeBlock.className = 'code-block' + (code.length > 300 ? ' collapsed' : '');

    var pre = document.createElement('pre');
    pre.innerHTML = highlightCode(code);
    codeBlock.appendChild(pre);

    if (code.length > 300) {
      var toggle = document.createElement('button');
      toggle.className = 'code-toggle';
      toggle.textContent = 'Show more';
      toggle.addEventListener('click', function() {
        var isCollapsed = codeBlock.classList.toggle('collapsed');
        toggle.textContent = isCollapsed ? 'Show more' : 'Show less';
      });
      codeBlock.appendChild(toggle);
    }

    card.appendChild(codeBlock);

    // Actions
    var actionRow = document.createElement('div');
    actionRow.className = 'action-row';

    var copyCodeBtn = createActionBtn('Copy Code', function() {
      copyToClipboard(code, copyCodeBtn);
    });
    actionRow.appendChild(copyCodeBtn);

    var copyHarnessBtn = createActionBtn('Copy Harness', function() {
      var harness = generateHarness(currentTabUrl, listener.domain || 'target');
      copyToClipboard(harness, copyHarnessBtn);
    });
    actionRow.appendChild(copyHarnessBtn);

    if (listener.fullStack && listener.fullStack.length > 0) {
      var copyStackBtn = createActionBtn('Copy Stack', function() {
        copyToClipboard(listener.fullStack.join('\n'), copyStackBtn);
      });
      actionRow.appendChild(copyStackBtn);
    }

    card.appendChild(actionRow);

    return card;
  }

  // ── Render: Messages ──────────────────────────────────────────────

  function renderMessages(query) {
    var container = document.getElementById('messages-list');
    container.innerHTML = '';

    var msgs = tabMessages.filter(function(m) { return m.type === 'message'; });

    if (msgs.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📨</div>No messages captured yet. Interact with the page to trigger postMessage communication.</div>';
      return;
    }

    // Show newest first
    msgs = msgs.slice().reverse();

    var rendered = 0;
    msgs.forEach(function(msg) {
      if (query) {
        var haystack = [msg.origin || '', msg.data || '', msg.sourceFrame || '', msg.receiverFrame || ''].join(' ').toLowerCase();
        if (haystack.indexOf(query) === -1) return;
      }

      var card = document.createElement('div');
      card.className = 'msg-card';
      if (msg.pocGenerated) card.style.borderColor = 'var(--teal)';

      // Flow: source -> receiver
      var flow = document.createElement('div');
      flow.className = 'msg-flow';
      flow.innerHTML =
        (msg.pocGenerated ? '<span class="wrapper-tag" style="color:var(--teal);border-color:var(--teal);">PoC</span>' : '') +
        '<span class="msg-source">' + escapeHtml(msg.sourceFrame || 'unknown') + '</span>' +
        '<span class="msg-arrow">→</span>' +
        '<span class="msg-receiver">' + escapeHtml(msg.receiverFrame || 'this') + '</span>' +
        '<span class="msg-origin">origin: ' + escapeHtml(msg.origin || 'null') + '</span>';
      card.appendChild(flow);

      // Timestamp + ports
      var meta = document.createElement('div');
      meta.className = 'card-time';
      var time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
      meta.textContent = time + (msg.hasPorts ? ' | ' + msg.portCount + ' port(s)' : '');
      card.appendChild(meta);

      // Data preview
      if (msg.data) {
        var dataDiv = document.createElement('div');
        dataDiv.className = 'msg-data';
        dataDiv.textContent = msg.data;
        card.appendChild(dataDiv);
      }

      container.appendChild(card);
      rendered++;
    });

    if (rendered === 0) {
      container.innerHTML = '<div class="empty-state">No messages match search.</div>';
    }
  }

  // ── Render: Senders ───────────────────────────────────────────────

  function renderSenders(query) {
    var container = document.getElementById('senders-list');
    container.innerHTML = '';

    if (tabSenders.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="icon">📤</div>No postMessage senders detected. Interact with the page to trigger sends.</div>';
      return;
    }

    // Show newest first
    var senders = tabSenders.slice().reverse();

    var rendered = 0;
    senders.forEach(function(sender) {
      if (query) {
        var haystack = [sender.targetOrigin || '', sender.data || '', sender.domain || ''].join(' ').toLowerCase();
        if (haystack.indexOf(query) === -1) return;
      }

      var analysis = Analyzer.analyzeSender(sender);

      var card = document.createElement('div');
      card.className = 'msg-card';

      // Target origin
      var targetRow = document.createElement('div');
      targetRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';

      var targetLabel = document.createElement('span');
      targetLabel.style.cssText = 'font-size:10px;color:var(--muted);';
      targetLabel.textContent = 'targetOrigin:';

      var targetVal = document.createElement('span');
      targetVal.className = 'sender-target ' + (sender.wildcardOrigin ? 'wildcard' : 'specific');
      targetVal.textContent = sender.targetOrigin || '*';

      targetRow.appendChild(targetLabel);
      targetRow.appendChild(targetVal);

      if (analysis.findings.length > 0) {
        analysis.findings.forEach(function(f) {
          var badge = document.createElement('span');
          badge.className = 'finding-badge finding-' + f.severity;
          badge.textContent = f.label;
          badge.title = f.detail;
          targetRow.appendChild(badge);
        });
      }

      card.appendChild(targetRow);

      // Frame + time
      var meta = document.createElement('div');
      meta.className = 'card-time';
      var time = sender.timestamp ? new Date(sender.timestamp).toLocaleTimeString() : '';
      meta.textContent = (sender.frame || '') + ' | ' + time;
      card.appendChild(meta);

      // Stack
      if (sender.stack && sender.stack.length > 0) {
        var stackRow = document.createElement('div');
        stackRow.className = 'stack-row';
        stackRow.textContent = sender.stack[0];
        card.appendChild(stackRow);
      }

      // Data preview
      if (sender.data) {
        var dataDiv = document.createElement('div');
        dataDiv.className = 'msg-data';
        dataDiv.textContent = sender.data;
        card.appendChild(dataDiv);
      }

      container.appendChild(card);
      rendered++;
    });

    if (rendered === 0) {
      container.innerHTML = '<div class="empty-state">No senders match search.</div>';
    }
  }

  // ── PoC Sender ────────────────────────────────────────────────────

  function setupPoc() {
    document.getElementById('btn-send-poc').addEventListener('click', function() {
      var origin = document.getElementById('poc-origin').value || '*';
      var payload = document.getElementById('poc-payload').value;
      var statusDiv = document.getElementById('poc-status');

      if (!payload) {
        statusDiv.style.color = 'var(--red)';
        statusDiv.textContent = 'Payload cannot be empty.';
        return;
      }

      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (!tabs || !tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'FIRE_POST_MESSAGE',
          payload: payload,
          targetOrigin: origin
        }, function(response) {
          if (chrome.runtime.lastError) {
            statusDiv.style.color = 'var(--red)';
            statusDiv.textContent = 'Failed: ' + chrome.runtime.lastError.message;
          } else if (response && response.status === 'success') {
            statusDiv.style.color = 'var(--green)';
            statusDiv.textContent = 'Payload sent.';
          } else {
            statusDiv.style.color = 'var(--red)';
            statusDiv.textContent = 'Error: ' + (response ? response.message : 'Unknown');
          }
        });
      });
    });

    document.getElementById('btn-harness').addEventListener('click', function() {
      var btn = this;
      var hostname = 'target';
      try { hostname = new URL(currentTabUrl).hostname || 'target'; } catch (e) {}
      var harness = generateHarness(currentTabUrl, hostname);
      copyToClipboard(harness, btn);
    });
  }

  // ── Actions (export, clear) ───────────────────────────────────────

  function setupActions() {
    document.getElementById('btn-export').addEventListener('click', function() {
      if (port) port.postMessage({action: 'export-tab', tabId: currentTabId});
    });

    document.getElementById('btn-clear').addEventListener('click', function() {
      if (port) {
        port.postMessage({action: 'clear-tab', tabId: currentTabId});
        tabListeners = [];
        tabMessages = [];
        tabSenders = [];
        updateCounts();
        updateStats();
        renderListeners();
        renderMessages('');
        renderSenders('');
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function highlightCode(code) {
    var safe = escapeHtml(code);
    // Keywords
    safe = safe.replace(/\b(function|return|var|let|const|if|else|try|catch|typeof|new|this|throw|switch|case|break|default|for|while|do|in|of|class|extends|import|export|async|await|yield)\b/g,
      '<span class="syn-keyword">$1</span>');
    // Strings (simple)
    safe = safe.replace(/(["'`])(?:(?!\1|\\).|\\.)*?\1/g, '<span class="syn-string">$&</span>');
    // Dangerous sinks
    safe = safe.replace(/(\beval\s*\()|(\.innerHTML\s*=)|(\.outerHTML\s*=)|(document\.write(?:ln)?\s*\()|(\.insertAdjacentHTML\s*\()/g,
      '<span class="hl-sink">$&</span>');
    // Weak patterns
    safe = safe.replace(/(\.origin\.indexOf\s*\()|(\.origin\.includes\s*\()|(\.origin\.endsWith\s*\()/g,
      '<span class="hl-weak">$&</span>');
    return safe;
  }

  function createActionBtn(text, onclick) {
    var btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.textContent = text;
    btn.addEventListener('click', onclick);
    return btn;
  }

  function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(function() {
      var orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = orig; }, 1200);
    });
  }

  function downloadJson(data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'postmessage-tracker-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function generateHarness(targetUrl, domain) {
    return '<!DOCTYPE html>\n' +
      '<html>\n<head>\n  <title>postMessage PoC - ' + escapeHtml(domain) + '</title>\n</head>\n<body>\n' +
      '  <h3>Target: ' + escapeHtml(domain) + '</h3>\n' +
      '  <iframe id="target" src="' + escapeHtml(targetUrl) + '" style="width:90%;height:500px;border:1px solid #ccc;"></iframe>\n\n' +
      '  <script>\n' +
      '    var iframe = document.getElementById("target");\n' +
      '    function send(data, origin) {\n' +
      '      iframe.contentWindow.postMessage(data, origin || "*");\n' +
      '    }\n\n' +
      '    // Modify payload and origin as needed:\n' +
      '    iframe.onload = function() {\n' +
      '      setTimeout(function() {\n' +
      '        send({"type": "test", "data": "<img src=x onerror=alert(document.domain)>"});\n' +
      '      }, 1000);\n' +
      '    };\n\n' +
      '    // Listen for responses:\n' +
      '    window.addEventListener("message", function(e) {\n' +
      '      console.log("Response from target:", e.origin, e.data);\n' +
      '    });\n' +
      '  </' + 'script>\n' +
      '</body>\n</html>';
  }

})();
