# postMessage Tracker

A Chrome extension for security researchers that monitors `window.postMessage` activity on web pages. It tracks message listeners, senders, and live message flows — then highlights patterns that might indicate security issues.

## What it does

When you visit a page, the extension:

- **Hooks** `addEventListener("message", ...)`, `window.onmessage`, and `window.postMessage` calls in the page's JavaScript
- **Captures** every message that flows between windows and iframes, including origin, data, and frame topology
- **Analyzes** listener source code for missing origin checks, weak validation patterns (like `indexOf` or `endsWith`), and dangerous sinks (`eval`, `innerHTML`, `document.write`, etc.)
- **Classifies** each listener with a pattern confidence level (critical / high / medium / low / info) based on what it finds in the code
- **Tracks** `MessagePort` and `MessageChannel` communication
- **Detects** monitoring wrappers (Sentry, New Relic, Datadog, Rollbar, Bugsnag) and unwraps them to show the real listener code
- **Logs** message flow to the browser console with colored output for quick inspection

## Features

- **Listener tab** — All registered `message` event listeners with source code, stack traces, confidence badges, and per-pattern findings
- **Messages tab** — Live feed of captured `postMessage` traffic with origin, data preview, and frame flow direction
- **Senders tab** — All `postMessage` calls made by the page, flagging wildcard `targetOrigin: "*"` usage
- **PoC tester** — Send test payloads directly to the page from the popup, or copy a ready-made exploit harness HTML
- **Filtering** — Search by domain, code, or stack trace; filter listeners by confidence level
- **Export** — Download all captured data as JSON for offline analysis
- **Webhook** — Optionally forward detected listeners to an external URL (configured in extension options)
- **Dark/light theme**

## Install

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the `postmsg-tracker` folder (the one containing `manifest.json`)
5. The extension icon appears in the toolbar

## Usage

1. Navigate to any web page
2. The badge on the extension icon shows the number of detected `message` listeners
3. Click the icon to open the popup
4. Browse the **Listeners**, **Messages**, and **Senders** tabs
5. Use the **PoC** tab to send test payloads to the page or copy a harness template

### Confidence levels

The analyzer classifies listeners based on code patterns it can observe:

| Level | Meaning |
|-------|---------|
| **Critical** | No origin check + code execution sink (eval, Function, setTimeout with string) |
| **High** | No origin check + DOM sink (innerHTML, document.write), or weak origin check + any sink |
| **Medium** | No origin check but processes message data, or other moderate-risk patterns |
| **Low** | No origin check but no visible data use, or unresolvable listener parameter |
| **Info** | Origin check present, no dangerous sinks detected |

## Important

**Detected patterns are not confirmed vulnerabilities.** The analyzer works by static pattern matching on listener source code. It cannot trace data flow through called functions, evaluate runtime conditions, or account for server-side defenses. Every finding needs manual validation before it can be considered a real security issue.

## Limitations

- Static analysis only — cannot follow data flow into external functions or evaluate runtime behavior
- Minified/obfuscated code reduces analysis accuracy
- Some framework-level listeners (React synthetic events, Angular zones) may not be captured at their original registration point
- jQuery handler detection works by scanning `jQuery._data` on page load — handlers added later may be missed
- The extension runs in MAIN world to hook native APIs, which means it modifies the page's JavaScript environment

## Architecture

The extension has five main components that work together through Chrome's messaging system:

```
[Web Page]
    |
    |  (MAIN world - runs in page context)
    v
instrumentation.js ──> hooks postMessage, addEventListener, onmessage
    |                   captures listeners, senders, messages
    |                   emits CustomEvent('__pmTracker__')
    |
    |  (CustomEvent bridge)
    v
content_script.js ──> (ISOLATED world - has chrome.runtime access)
    |                  relays events to background via chrome.runtime.sendMessage
    |                  handles PoC sender commands from popup
    |
    |  (chrome.runtime messaging)
    v
background.js ──> service worker
    |              stores per-tab data (listeners, messages, senders)
    |              manages badge count, tab lifecycle, persistence
    |              serves data to popup via chrome.runtime.connect port
    |
    v
popup.js + analyzer.js ──> popup UI
                            analyzer.js classifies listener code (origin checks, sinks, confidence)
                            popup.js renders cards, filters, search, PoC tester, export
```

### Component roles

- **instrumentation.js** — Injected into every page in MAIN world. Monkey-patches `window.postMessage`, `Window.prototype.addEventListener`, `removeEventListener`, `onmessage`, `MessagePort` methods, and `History.pushState`. Captures function source code, stack traces, frame paths, timestamps, and monitoring wrapper info. Sends everything to the content script via `CustomEvent`.

- **content_script.js** — Runs in ISOLATED world (has access to `chrome.runtime` but not page JS). Listens for `__pmTracker__` custom events and forwards them to the background service worker. Also receives PoC commands from the popup and dispatches test `postMessage` calls into the page.

- **background.js** — Service worker that stores all captured data per tab. Handles tab creation/removal/navigation, debounced persistence to `chrome.storage.local`, badge updates, optional webhook forwarding, and serves data to the popup over a `chrome.runtime.connect` port.

- **analyzer.js** — Pure analysis engine loaded by the popup. Extracts listener parameters (regular functions, arrow functions, destructured args), checks for origin validation patterns (11 types with strength ratings), detects dangerous sinks (17 categories), and classifies overall confidence. Designed to minimize false positives.

- **popup.js** — Renders the popup UI. Connects to background for data, runs `analyzer.js` on each listener, builds cards with confidence badges, findings, syntax-highlighted code, collapsible blocks, copy buttons, and the PoC testing interface.

## License

MIT
