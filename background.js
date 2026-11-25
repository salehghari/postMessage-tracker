/*
 * background.js — Service worker for postMessage Tracker
 * Manages per-tab data storage, badge updates, and popup communication.
 */
(function() {
  'use strict';

  // ── Per-tab data store ────────────────────────────────────────────
  var tabData = {};      // tabId -> {listeners: [], messages: [], senders: []}
  var tabPush = {};      // tabId -> bool (pushState navigation)
  var tabLoading = {};   // tabId -> bool (page is loading)
  var activeTabId = -1;

  var SAVE_DEBOUNCE_MS = 2000;
  var saveTimer = null;

  // ── Storage initialization with message queue ─────────────────────
  var storageReady = false;
  var pendingQueue = [];

  function whenReady(fn) {
    if (storageReady) {
      fn();
    } else {
      pendingQueue.push(fn);
    }
  }

  function drainQueue() {
    storageReady = true;
    var queue = pendingQueue;
    pendingQueue = [];
    for (var i = 0; i < queue.length; i++) {
      queue[i]();
    }
  }

  chrome.storage.local.get(['pmtracker_data'], function(result) {
    if (result.pmtracker_data) {
      tabData = result.pmtracker_data;
    }
    drainQueue();
  });

  function getTabData(tabId) {
    if (!tabData[tabId]) {
      tabData[tabId] = {listeners: [], messages: [], senders: []};
    }
    return tabData[tabId];
  }

  // ── Persistence ───────────────────────────────────────────────────

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function() {
      saveTimer = null;
      chrome.storage.local.set({pmtracker_data: tabData});
    }, SAVE_DEBOUNCE_MS);
  }

  // ── Badge ─────────────────────────────────────────────────────────

  function updateBadge(tabId) {
    if (!tabId || tabId < 0) return;
    var data = tabData[tabId];
    var listenerCount = data ? data.listeners.length : 0;
    var txt = listenerCount > 0 ? String(listenerCount) : '';

    chrome.tabs.get(tabId, function() {
      if (chrome.runtime.lastError) return;
      chrome.action.setBadgeText({text: txt, tabId: tabId});
      chrome.action.setBadgeBackgroundColor({
        color: listenerCount > 0 ? '#f38ba8' : [0, 0, 0, 0],
        tabId: tabId
      });
    });
  }

  // ── Log forwarding (optional) ─────────────────────────────────────

  function forwardToLogUrl(data) {
    chrome.storage.sync.get({log_url: ''}, function(items) {
      if (!items.log_url) return;
      try {
        fetch(items.log_url, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(data)
        });
      } catch (e) {}
    });
  }

  // ── Core message handler (called after storage ready) ─────────────

  function processMessage(msg, sender) {
    var tabId = sender.tab ? sender.tab.id : activeTabId;
    if (tabId < 0) return;

    var parentUrl = sender.tab ? sender.tab.url : '';

    if (parentUrl && (
      parentUrl.startsWith('chrome-extension://') ||
      parentUrl.startsWith('moz-extension://')
    )) return;

    var data = getTabData(tabId);

    if (msg.type === 'listener' || msg.type === 'port-listener') {
      msg.parentUrl = parentUrl;
      msg.tabId = tabId;
      data.listeners.push(msg);
      scheduleSave();
      forwardToLogUrl(msg);
      updateBadge(tabId);
    }
    else if (msg.type === 'sender' || msg.type === 'port-sender') {
      msg.parentUrl = parentUrl;
      msg.tabId = tabId;
      data.senders.push(msg);
      scheduleSave();
    }
    else if (msg.type === 'message') {
      msg.parentUrl = parentUrl;
      msg.tabId = tabId;
      data.messages.push(msg);
      scheduleSave();
    }
    else if (msg.type === 'listener-removed') {
      // Mark matching listener as removed
      for (var i = 0; i < data.listeners.length; i++) {
        if (data.listeners[i].id === msg.id) {
          data.listeners[i].removed = true;
          scheduleSave();
          updateBadge(tabId);
          break;
        }
      }
    }
    else if (msg.type === 'navigation') {
      tabPush[tabId] = true;
    }
    else if (msg.type === 'pageUnload') {
      delete tabLoading[tabId];
    }
  }

  // ── Message listener (queues until storage ready) ─────────────────

  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    whenReady(function() {
      processMessage(msg, sender);
    });
  });

  // ── Tab lifecycle ─────────────────────────────────────────────────

  chrome.tabs.onUpdated.addListener(function(tabId, props) {
    whenReady(function() {
      if (props.status === 'complete') {
        if (tabId === activeTabId) updateBadge(tabId);
      } else if (props.status === 'loading') {
        if (tabPush[tabId]) {
          delete tabPush[tabId];
        } else if (!tabLoading[tabId]) {
          tabData[tabId] = {listeners: [], messages: [], senders: []};
          scheduleSave();
        }
        tabLoading[tabId] = true;
      }
    });
  });

  chrome.tabs.onRemoved.addListener(function(tabId) {
    whenReady(function() {
      delete tabData[tabId];
      delete tabPush[tabId];
      delete tabLoading[tabId];
      scheduleSave();
    });
  });

  chrome.tabs.onActivated.addListener(function(activeInfo) {
    activeTabId = activeInfo.tabId;
    whenReady(function() {
      updateBadge(activeTabId);
    });
  });

  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if (tabs && tabs[0]) {
      activeTabId = tabs[0].id;
      whenReady(function() { updateBadge(activeTabId); });
    }
  });

  // ── Popup communication ───────────────────────────────────────────

  chrome.runtime.onConnect.addListener(function(port) {
    function sendData() {
      port.postMessage({tabData: tabData});
    }
    port.onMessage.addListener(function(msg) {
      whenReady(function() {
        if (msg === 'get-data') {
          sendData();
        } else if (msg.action === 'clear-tab' && msg.tabId) {
          tabData[msg.tabId] = {listeners: [], messages: [], senders: []};
          scheduleSave();
          updateBadge(msg.tabId);
          sendData();
        } else if (msg.action === 'export-tab' && msg.tabId) {
          port.postMessage({exportData: tabData[msg.tabId] || {listeners: [], messages: [], senders: []}});
        }
      });
    });
    whenReady(sendData);
  });

})();
