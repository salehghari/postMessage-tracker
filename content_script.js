/*
 * content_script.js — ISOLATED world bridge
 * Relays instrumentation events from page context (CustomEvent)
 * to the extension background service worker (chrome.runtime).
 * Also handles PoC sender commands from the popup.
 */
(function() {
  'use strict';

  // Skip non-HTML documents (XML, PDF, etc.)
  if (document.contentType && document.contentType.indexOf('html') === -1) return;

  // ── Relay instrumentation events to background ────────────────────

  document.addEventListener('__pmTracker__', function(event) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(event.detail);
      }
    } catch (e) {
      // Extension context invalidated (reload/update). Fail silently.
    }
  });

  // ── Track page navigation ─────────────────────────────────────────

  window.addEventListener('beforeunload', function() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({type: 'pageUnload'});
      }
    } catch (e) {}
  });

  // ── Handle PoC sender commands from popup ─────────────────────────

  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'FIRE_POST_MESSAGE') {
      try {
        var payload = request.payload;
        try { payload = JSON.parse(request.payload); } catch (e) {}
        document.dispatchEvent(new CustomEvent('__pmTrackerPoc__'));
        window.postMessage(payload, request.targetOrigin || '*');
        sendResponse({status: 'success'});
      } catch (err) {
        sendResponse({status: 'error', message: err.toString()});
      }
    }
    return true;
  });
})();
