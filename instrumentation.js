/*
 * instrumentation.js — MAIN world postMessage instrumentation
 * Runs in page context via MV3 "world": "MAIN" content script.
 * Hooks both senders (postMessage calls) and receivers (message listeners).
 * Captures message data, origins, stacks, timestamps, frame topology.
 *
 * Based on research by Frans Rosén (@fransrosen) and extended with
 * sender tracking, monitoring-wrapper unwrapping, and listener lifecycle.
 */
(function() {
  'use strict';

  if (window.__postMessageTrackerInstalled__) return;
  window.__postMessageTrackerInstalled__ = true;

  // ── Preserved originals ───────────────────────────────────────────
  var origPostMessage = window.postMessage.bind(window);
  var origAddEventListener = Window.prototype.addEventListener;
  var origRemoveEventListener = Window.prototype.removeEventListener;
  var origFunctionToString = Function.prototype.toString;
  var origMessagePortAddListener = MessagePort.prototype.addEventListener;
  var origMessagePortPostMessage = MessagePort.prototype.postMessage;
  var origPushState = History.prototype.pushState;

  // ── Configuration ─────────────────────────────────────────────────
  var MAX_DATA_LENGTH = 2048;
  var MAX_LISTENERS = 500;
  var MAX_MESSAGES = 1000;

  // ── State ─────────────────────────────────────────────────────────
  var registeredListeners = [];
  var listenerFingerprints = new Set();
  var capturedMessages = [];
  var listenerIdCounter = 0;
  var listenerIdMap = new WeakMap();
  var pocPending = false;

  // ── Utilities ─────────────────────────────────────────────────────

  function emit(detail) {
    try {
      document.dispatchEvent(new CustomEvent('__pmTracker__', {detail: detail}));
    } catch (e) { /* extension context gone */ }
  }

  function getTimestamp() {
    return Date.now();
  }

  function getPageOrigin() {
    try { return location.origin || ''; }
    catch (e) { return ''; }
  }

  function truncate(str, max) {
    if (typeof str !== 'string') return str;
    return str.length > max ? str.substring(0, max) + '…[truncated]' : str;
  }

  function safeStringify(data) {
    if (data === undefined) return 'undefined';
    if (data === null) return 'null';
    if (typeof data === 'string') return truncate(data, MAX_DATA_LENGTH);
    try {
      var str = JSON.stringify(data);
      return truncate(str, MAX_DATA_LENGTH);
    } catch (e) {
      return '[Unstringifiable: ' + typeof data + ']';
    }
  }

  function safeToString(fn) {
    try {
      return origFunctionToString.call(fn);
    } catch (e) {
      return '[Function: toString failed]';
    }
  }

  function getCleanStack(skipFrames) {
    var stack = '';
    try { throw new Error(); } catch (e) { stack = e.stack || ''; }
    var lines = stack.split('\n').map(function(l) { return l.trim(); });
    var cleaned = [];
    var skip = skipFrames || 3;
    for (var i = skip; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      if (line.indexOf('instrumentation.js') !== -1) continue;
      cleaned.push(line);
    }
    return cleaned;
  }

  function getFrameDescriptor(win) {
    if (!win) return 'unknown';
    try {
      if (win === window.top) return 'top';
      if (win === window) return getFramePath(window);
      if (win.top === window.top) return getFramePath(win);
      return 'cross-origin-window';
    } catch (e) {
      return 'cross-origin-window';
    }
  }

  function getFramePath(win) {
    if (!win) return 'unknown';
    try {
      if (win === window.top) return 'top';
      var hops = '';
      var current = win;
      while (current !== window.top) {
        var index = -1;
        try {
          for (var i = 0; i < current.parent.frames.length; i++) {
            if (current === current.parent.frames[i]) { index = i; break; }
          }
        } catch (e) { return 'cross-origin-frame'; }
        hops = 'frames[' + index + ']' + (hops ? '.' + hops : '');
        current = current.parent;
      }
      return 'top' + (hops ? '.' + hops : '');
    } catch (e) {
      return 'cross-origin-frame';
    }
  }

  // ── Monitoring wrapper detection & unwrapping ─────────────────────

  var WRAPPER_DETECTORS = [
    {
      name: 'sentry',
      test: function(fn) {
        return typeof fn.__sentry_original__ === 'function';
      },
      unwrap: function(fn) { return fn.__sentry_original__; }
    },
    {
      name: 'newrelic',
      test: function(fn) {
        var str = safeToString(fn);
        return /arguments.*(start|typeof).*err.*finally.*end/s.test(str)
          && fn['nr@original'] && typeof fn['nr@original'] === 'function';
      },
      unwrap: function(fn) { return fn['nr@original']; }
    },
    {
      name: 'raven',
      test: function(fn) {
        var str = safeToString(fn);
        return /\.deep.*apply.*captureException/s.test(str);
      },
      unwrap: function(fn) {
        for (var key in fn) {
          if (typeof fn[key] === 'function' && key !== 'toString') return fn[key];
        }
        return fn;
      }
    },
    {
      name: 'rollbar',
      test: function(fn) {
        var str = safeToString(fn);
        return /rollbarContext.*rollbarWrappedError/s.test(str) && fn._isWrap;
      },
      unwrap: function(fn) {
        return typeof fn._wrapped === 'function' ? fn._wrapped
          : typeof fn._rollbar_wrapped === 'function' ? fn._rollbar_wrapped
          : fn;
      }
    },
    {
      name: 'bugsnag',
      test: function(fn) {
        var str = safeToString(fn);
        return /autoNotify.*(unhandledException|notifyException)/s.test(str)
          && typeof fn.bugsnag === 'function';
      },
      unwrap: function(fn) { return fn; }
    },
    {
      name: 'datadog',
      test: function(fn) {
        var str = safeToString(fn);
        return /ddRumErrorHandler|__dd_wrapped__/s.test(str)
          && typeof fn.__dd_original__ === 'function';
      },
      unwrap: function(fn) { return fn.__dd_original__; }
    }
  ];

  function unwrapListener(fn) {
    var wrappers = [];
    var maxDepth = 5;
    var current = fn;

    for (var depth = 0; depth < maxDepth; depth++) {
      var found = false;
      for (var i = 0; i < WRAPPER_DETECTORS.length; i++) {
        try {
          if (WRAPPER_DETECTORS[i].test(current)) {
            wrappers.push(WRAPPER_DETECTORS[i].name);
            var unwrapped = WRAPPER_DETECTORS[i].unwrap(current);
            if (unwrapped && unwrapped !== current) {
              current = unwrapped;
              found = true;
              break;
            }
          }
        } catch (e) { /* detector failed, skip */ }
      }
      if (!found) break;
    }

    return { listener: current, wrappers: wrappers };
  }

  // ── Listener fingerprinting (deduplication) ───────────────────────

  function fingerprintListener(listenerStr, stack) {
    var body = listenerStr.replace(/\s+/g, ' ').substring(0, 500);
    var loc = (stack && stack[0]) ? stack[0].substring(0, 200) : '';
    return body + '||' + loc;
  }

  // ── jQuery message handler detection ──────────────────────────────

  function detectJQueryHandlers() {
    try {
      var props = Object.getOwnPropertyNames(window);
      for (var i = 0; i < props.length; i++) {
        var key = props[i];
        if (key.indexOf('jQuery') === -1) continue;
        try {
          var jq = window[key];
          if (typeof jq === 'function' && typeof jq._data === 'function') {
            extractJQueryEvents(jq._data(window, 'events'));
          } else if (jq && jq.expando) {
            var idx = 1;
            var instance;
            while ((instance = window[jq.expando + idx++]) && idx < 100) {
              if (instance.events) extractJQueryEvents(instance.events);
            }
          }
        } catch (e) { /* skip inaccessible jQuery instance */ }
      }
    } catch (e) { /* getOwnPropertyNames failed */ }
  }

  function extractJQueryEvents(events) {
    if (!events || !events.message || !events.message.length) return;
    for (var j = 0; j < events.message.length; j++) {
      var handler = events.message[j].handler;
      if (!handler) continue;
      var str = safeToString(handler);
      var fp = fingerprintListener(str, ['jQuery']);
      if (listenerFingerprints.has(fp)) continue;
      listenerFingerprints.add(fp);

      var entry = {
        type: 'listener',
        id: ++listenerIdCounter,
        listenerSource: str,
        stack: ['jQuery event binding'],
        fullStack: [],
        frame: getFramePath(window),
        pageOrigin: getPageOrigin(),
        domain: document.domain,
        timestamp: getTimestamp(),
        wrappers: [],
        registrationMethod: 'jQuery'
      };
      registeredListeners.push(entry);
      emit(entry);
    }
  }

  // ── Hook: window.addEventListener('message', ...) ─────────────────

  Window.prototype.addEventListener = function(type, listener, options) {
    if (type === 'message' && typeof listener === 'function') {
      var unwrapResult = unwrapListener(listener);
      var realListener = unwrapResult.listener;
      var listenerStr = safeToString(realListener);

      // Skip extension-internal and native code listeners
      if (listenerStr === 'function () { [native code] }') {
        return origAddEventListener.call(this, type, listener, options);
      }
      if (listenerStr.indexOf('__pmTracker__') !== -1) {
        return origAddEventListener.call(this, type, listener, options);
      }

      var stack = getCleanStack(3);
      var fp = fingerprintListener(listenerStr, stack);

      if (!listenerFingerprints.has(fp) && registeredListeners.length < MAX_LISTENERS) {
        listenerFingerprints.add(fp);

        var once = !!(options && typeof options === 'object' && options.once);

        var entry = {
          type: 'listener',
          id: ++listenerIdCounter,
          listenerSource: listenerStr,
          stack: stack.slice(0, 5),
          fullStack: stack,
          frame: getFramePath(window),
          pageOrigin: getPageOrigin(),
          domain: document.domain,
          timestamp: getTimestamp(),
          wrappers: unwrapResult.wrappers,
          registrationMethod: 'addEventListener',
          once: once
        };
        registeredListeners.push(entry);
        listenerIdMap.set(listener, entry.id);
        emit(entry);
      }
    }
    return origAddEventListener.call(this, type, listener, options);
  };

  // ── Hook: window.removeEventListener('message', ...) ──────────────

  Window.prototype.removeEventListener = function(type, listener, options) {
    if (type === 'message' && typeof listener === 'function') {
      var entryId = listenerIdMap.get(listener);
      if (entryId !== undefined) {
        for (var i = 0; i < registeredListeners.length; i++) {
          if (registeredListeners[i].id === entryId && !registeredListeners[i].removed) {
            registeredListeners[i].removed = true;
            registeredListeners[i].removedAt = getTimestamp();
            emit({type: 'listener-removed', id: entryId});
            break;
          }
        }
      }
    }
    return origRemoveEventListener.call(this, type, listener, options);
  };

  // ── Hook: window.onmessage setter ─────────────────────────────────

  var onmessageDescriptor = Object.getOwnPropertyDescriptor(window, 'onmessage')
    || Object.getOwnPropertyDescriptor(Window.prototype, 'onmessage');

  if (onmessageDescriptor && onmessageDescriptor.set) {
    var origOnmessageSetter = onmessageDescriptor.set;
    Object.defineProperty(window, 'onmessage', {
      get: onmessageDescriptor.get,
      set: function(listener) {
        if (typeof listener === 'function') {
          var listenerStr = safeToString(listener);
          var stack = getCleanStack(3);
          var fp = fingerprintListener(listenerStr, stack);

          if (!listenerFingerprints.has(fp) && registeredListeners.length < MAX_LISTENERS) {
            listenerFingerprints.add(fp);
            var entry = {
              type: 'listener',
              id: ++listenerIdCounter,
              listenerSource: listenerStr,
              stack: stack.slice(0, 5),
              fullStack: stack,
              frame: getFramePath(window),
              pageOrigin: getPageOrigin(),
              domain: document.domain,
              timestamp: getTimestamp(),
              wrappers: [],
              registrationMethod: 'onmessage'
            };
            registeredListeners.push(entry);
            emit(entry);
          }
        }
        return origOnmessageSetter.call(this, listener);
      },
      configurable: true,
      enumerable: true
    });
  }

  // ── Hook: window.postMessage (sender tracking) ────────────────────

  window.postMessage = function(message, targetOriginOrOptions, transfer) {
    var resolvedOrigin = '*';
    if (typeof targetOriginOrOptions === 'string') {
      resolvedOrigin = targetOriginOrOptions;
    } else if (targetOriginOrOptions && typeof targetOriginOrOptions === 'object') {
      resolvedOrigin = targetOriginOrOptions.targetOrigin || '*';
      if (!transfer && targetOriginOrOptions.transfer) {
        transfer = targetOriginOrOptions.transfer;
      }
    }

    var stack = getCleanStack(3);
    var entry = {
      type: 'sender',
      targetOrigin: resolvedOrigin,
      data: safeStringify(message),
      dataType: typeof message === 'object' ? 'object' : typeof message,
      frame: getFramePath(window),
      pageOrigin: getPageOrigin(),
      domain: document.domain,
      stack: stack.slice(0, 5),
      fullStack: stack,
      timestamp: getTimestamp(),
      wildcardOrigin: !resolvedOrigin || resolvedOrigin === '*'
    };

    if (capturedMessages.length < MAX_MESSAGES) {
      capturedMessages.push(entry);
    }
    emit(entry);

    return origPostMessage(message, targetOriginOrOptions, transfer);
  };

  // ── Hook: MessagePort.postMessage ─────────────────────────────────

  MessagePort.prototype.postMessage = function(message, transfer) {
    var stack = getCleanStack(3);
    var entry = {
      type: 'port-sender',
      data: safeStringify(message),
      dataType: typeof message === 'object' ? 'object' : typeof message,
      frame: getFramePath(window),
      pageOrigin: getPageOrigin(),
      domain: document.domain,
      stack: stack.slice(0, 3),
      timestamp: getTimestamp()
    };
    if (capturedMessages.length < MAX_MESSAGES) {
      capturedMessages.push(entry);
    }
    emit(entry);

    return origMessagePortPostMessage.call(this, message, transfer);
  };

  // ── Hook: MessagePort.addEventListener (port listeners) ───────────

  MessagePort.prototype.addEventListener = function(type, listener, options) {
    if (type === 'message' && typeof listener === 'function') {
      var listenerStr = safeToString(listener);
      var stack = getCleanStack(3);
      var fp = 'port:' + fingerprintListener(listenerStr, stack);

      if (!listenerFingerprints.has(fp) && registeredListeners.length < MAX_LISTENERS) {
        listenerFingerprints.add(fp);
        var entry = {
          type: 'port-listener',
          id: ++listenerIdCounter,
          listenerSource: listenerStr,
          stack: stack.slice(0, 5),
          fullStack: stack,
          frame: getFramePath(window),
          pageOrigin: getPageOrigin(),
          domain: document.domain,
          timestamp: getTimestamp(),
          wrappers: [],
          registrationMethod: 'MessagePort.addEventListener'
        };
        registeredListeners.push(entry);
        emit(entry);
      }
    }
    return origMessagePortAddListener.call(this, type, listener, options);
  };

  // ── Hook: History.pushState (SPA navigation tracking) ─────────────

  if (origPushState) {
    History.prototype.pushState = function(state, title, url) {
      emit({type: 'navigation', method: 'pushState', url: url});
      return origPushState.apply(this, arguments);
    };
  }

  // ── PoC marker listener (from ISOLATED world content script) ──────

  document.addEventListener('__pmTrackerPoc__', function() {
    pocPending = true;
  });

  // ── Passive message observer (captures received messages) ─────────

  origAddEventListener.call(window, 'message', function(event) {
    var sourceFrame = 'unknown';
    try { sourceFrame = getFrameDescriptor(event.source); } catch (e) {}

    var isPoc = pocPending;
    pocPending = false;

    var entry = {
      type: 'message',
      origin: event.origin,
      data: safeStringify(event.data),
      dataType: typeof event.data === 'object' ? 'object' : typeof event.data,
      sourceFrame: sourceFrame,
      receiverFrame: getFramePath(window),
      pageOrigin: getPageOrigin(),
      domain: document.domain,
      hasPorts: event.ports && event.ports.length > 0,
      portCount: event.ports ? event.ports.length : 0,
      timestamp: getTimestamp(),
      pocGenerated: isPoc
    };

    if (capturedMessages.length < MAX_MESSAGES) {
      capturedMessages.push(entry);
    }
    emit(entry);
  }, true);

  // ── jQuery detection on load ──────────────────────────────────────

  origAddEventListener.call(window, 'load', detectJQueryHandlers);
  origAddEventListener.call(window, 'postMessageTrackerUpdate', detectJQueryHandlers);

  // ── Console logging for researcher visibility ─────────────────────

  origAddEventListener.call(window, 'message', function(event) {
    var sourceDesc = 'unknown';
    try { sourceDesc = getFrameDescriptor(event.source); } catch (e) {}
    var receiverDesc = getFramePath(window);
    var dataPreview = typeof event.data === 'string'
      ? truncate(event.data, 120)
      : 'Object: ' + truncate(JSON.stringify(event.data), 120);

    console.log(
      '%c[PM-Tracker]%c %c' + sourceDesc + '%c → %c' + receiverDesc + '%c | origin: %c' + event.origin + '%c | ' + dataPreview,
      'background:#89b4fa;color:#11111b;font-weight:bold;padding:1px 4px;border-radius:2px', '',
      'color:#f38ba8;font-weight:bold', '',
      'color:#a6e3a1;font-weight:bold', '',
      'color:#f9e2af', ''
    );
  }, true);

})();
