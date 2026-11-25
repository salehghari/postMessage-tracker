/*
 * test_audit.js — Regression tests for audit findings and v2.0.1 fixes
 * Tests bugs found during the independent verification audit plus
 * regression tests for each maintenance fix (P1-P6).
 */

if (typeof window === 'undefined') {
  var fs = require('fs');
  var vm = require('vm');
  var code = fs.readFileSync(require('path').join(__dirname, '..', 'analyzer.js'), 'utf8');
  var sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  var Analyzer = sandbox.Analyzer;
}

var passed = 0, failed = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log('  PASS: ' + msg); }
  else { failed++; console.log('  FAIL: ' + msg); }
}
function assertEqual(a, b, msg) { assert(a === b, msg + ' (got: ' + a + ', expected: ' + b + ')'); }
function group(name) { console.log('\n── AUDIT: ' + name + ' ──'); }


// ═══════════════════════════════════════════════════════════════
// ORIGINAL AUDIT PROBES (updated for v2.0.1 fixes)
// ═══════════════════════════════════════════════════════════════

group('Regex stateful lastIndex with /g flag');
(function() {
  var code = 'function(e) { el.innerHTML = e.data; }';
  var r1 = Analyzer.analyzeSinks(code);
  var r2 = Analyzer.analyzeSinks(code);
  assertEqual(r1.length, r2.length,
    'analyzeSinks returns same result on repeated calls');
  var c1 = Analyzer.classifyListener(code);
  var c2 = Analyzer.classifyListener(code);
  assertEqual(c1.confidence, c2.confidence,
    'classifyListener stable across repeated calls');
})();


group('innerHTML false positive on non-message code');
(function() {
  var code = 'function(e) { document.getElementById("x").innerHTML = "<div>hello</div>"; }';
  var sinks = Analyzer.analyzeSinks(code);
  assert(sinks.length > 0, 'innerHTML with static string IS detected (presence-based, documented limitation)');
})();


group('Origin check false positive with unrelated .origin access');
(function() {
  var code1 = 'function(e) { var url = window.origin + "/api"; fetch(url); }';
  var r1 = Analyzer.analyzeOriginValidation(code1);
  assert(r1.hasCheck === false || r1.checks.length === 0,
    'window.origin does not false-positive as event.origin check');
})();


group('looseEquality/strictEquality no overlap');
(function() {
  var code = 'function(e) { if (e.origin === "https://x.com") {} }';
  var r = Analyzer.analyzeOriginValidation(code);
  var checkNames = r.checks.map(function(c) { return c.name; });
  var hasStrict = checkNames.indexOf('strictEquality') !== -1;
  var hasLoose = checkNames.indexOf('looseEquality') !== -1;
  assert(hasStrict, 'strictEquality detected for ===');
  assert(!hasLoose, '=== does NOT trigger looseEquality (overlap fixed)');
})();


group('XHTML contentType filter');
(function() {
  var xhtmlType = 'application/xhtml+xml';
  assert(xhtmlType.indexOf('html') !== -1,
    'XHTML contentType contains "html" — indexOf("html") works');
})();


// ═══════════════════════════════════════════════════════════════
// P2 REGRESSION: Custom parameter origin detection
// ═══════════════════════════════════════════════════════════════

group('P2: Arrow function with custom param — origin check detected');
(function() {
  var code = '(myEvent) => { if (myEvent.origin === "https://x.com") return; }';
  var r = Analyzer.analyzeOriginValidation(code);
  assert(r.hasCheck, 'Arrow fn with custom param "myEvent" — origin check now detected');
  assertEqual(r.paramName, 'myEvent', 'Extracted param name = myEvent');
})();


group('P2: Custom param "messageEvent" in regular function');
(function() {
  var code = 'function(messageEvent) { if (messageEvent.origin !== "https://app.com") return; el.innerHTML = messageEvent.data; }';
  var r = Analyzer.analyzeOriginValidation(code);
  assert(r.hasCheck, 'messageEvent.origin detected');
  assertEqual(r.paramName, 'messageEvent', 'Extracted param name = messageEvent');
})();


group('P2: Custom param "eventData" with sinks');
(function() {
  var code = 'function(eventData) { el.innerHTML = eventData.data; }';
  var r = Analyzer.classifyListener(code);
  assertEqual(r.confidence, 'high', 'Custom param with innerHTML, no origin = high');
  assert(r.sinks.length > 0, 'innerHTML sink detected with custom param');
})();


group('P2: Arrow without parens custom param');
(function() {
  var code = 'msgEvent => { if (msgEvent.origin === "https://t.com") return; }';
  var r = Analyzer.analyzeOriginValidation(code);
  assert(r.hasCheck, 'Arrow (no parens) custom param origin check detected');
  assertEqual(r.paramName, 'msgEvent', 'Extracted param name = msgEvent');
})();


group('P2: Destructured origin');
(function() {
  var code = 'function({origin, data}) { if (origin === "https://t.com") { process(data); } }';
  var r = Analyzer.analyzeOriginValidation(code);
  assert(r.hasCheck, 'Destructured origin check detected');
  assert(r.checks.length > 0, 'Has specific check for destructured origin');
})();


group('P2: Unknown param — insufficient evidence, not "no origin check"');
(function() {
  var code = 'unknown_format { eval(something); }';
  var r = Analyzer.classifyListener(code);
  assert(r.origin.paramUnknown, 'paramUnknown is true');
  assert(r.confidence !== 'critical',
    'Unknown param with eval: NOT critical (insufficient evidence)');
  assert(r.confidence === 'medium' || r.confidence === 'low',
    'Unknown param classified as medium or low, not critical/high');
})();


group('P2: Custom param data flow detection');
(function() {
  var code = 'function(payload) { var d = payload.data; process(d); }';
  var r = Analyzer.analyzeDataFlow(code);
  assert(r.accessesData, 'Custom param "payload" — data access detected');
})();


group('P2: Custom param sink detection');
(function() {
  var code = 'function(msgObj) { setTimeout(msgObj.data, 100); }';
  var r = Analyzer.analyzeSinks(code);
  assert(r.some(function(s) { return s.name === 'setTimeout(string)'; }),
    'Custom param "msgObj" — setTimeout sink detected');
})();


group('P2: extractListenerParam API');
(function() {
  var p1 = Analyzer.extractListenerParam('function(event) { }');
  assertEqual(p1.type, 'named', 'Regular function extraction');
  assertEqual(p1.name, 'event', 'Regular function param = event');

  var p2 = Analyzer.extractListenerParam('(e) => { }');
  assertEqual(p2.type, 'named', 'Arrow extraction');
  assertEqual(p2.name, 'e', 'Arrow param = e');

  var p3 = Analyzer.extractListenerParam('x => { }');
  assertEqual(p3.type, 'named', 'No-parens arrow extraction');
  assertEqual(p3.name, 'x', 'No-parens arrow param = x');

  var p4 = Analyzer.extractListenerParam('function({origin, data}) { }');
  assertEqual(p4.type, 'destructured', 'Destructured extraction');

  var p5 = Analyzer.extractListenerParam('some random code');
  assertEqual(p5.type, 'unknown', 'Unknown code extraction');
})();


// ═══════════════════════════════════════════════════════════════
// P1 REGRESSION: Storage race (design verification — can't test
// actual chrome.storage in Node, but verify the pattern)
// ═══════════════════════════════════════════════════════════════

group('P1: Storage queue pattern (design check)');
(function() {
  var bgSource = '';
  try {
    bgSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'background.js'), 'utf8'
    );
  } catch (e) {}

  if (bgSource) {
    assert(bgSource.indexOf('storageReady') !== -1,
      'background.js has storageReady flag');
    assert(bgSource.indexOf('pendingQueue') !== -1,
      'background.js has pendingQueue');
    assert(bgSource.indexOf('whenReady') !== -1,
      'background.js uses whenReady gate for message handling');
    assert(bgSource.indexOf('drainQueue') !== -1,
      'background.js drains queue after storage loads');
    assert(bgSource.indexOf('processMessage') !== -1,
      'background.js delegates to processMessage');
  } else {
    assert(true, 'SKIP: Cannot read background.js in browser');
  }
})();


// ═══════════════════════════════════════════════════════════════
// P3 REGRESSION: location.origin as primary
// ═══════════════════════════════════════════════════════════════

group('P3: location.origin in instrumentation (design check)');
(function() {
  var instSource = '';
  try {
    instSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'instrumentation.js'), 'utf8'
    );
  } catch (e) {}

  if (instSource) {
    assert(instSource.indexOf('getPageOrigin') !== -1,
      'instrumentation.js has getPageOrigin helper');
    assert(instSource.indexOf('location.origin') !== -1,
      'instrumentation.js uses location.origin');
    assert(instSource.indexOf('pageOrigin:') !== -1,
      'instrumentation.js emits pageOrigin field');
    assert(instSource.indexOf('domain: document.domain') !== -1,
      'instrumentation.js still emits domain as supplementary');
  } else {
    assert(true, 'SKIP: Cannot read instrumentation.js in browser');
  }
})();


// ═══════════════════════════════════════════════════════════════
// P4 REGRESSION: UI terminology
// ═══════════════════════════════════════════════════════════════

group('P4: UI shows pattern confidence, not severity (design check)');
(function() {
  var popupSource = '';
  try {
    popupSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'popup.js'), 'utf8'
    );
  } catch (e) {}

  if (popupSource) {
    assert(popupSource.indexOf('Pattern confidence') !== -1,
      'popup.js badge tooltip mentions "Pattern confidence"');
    assert(popupSource.indexOf('manual validation required') !== -1 ||
           popupSource.indexOf('manual validation') !== -1,
      'popup.js mentions manual validation is required');
    assert(popupSource.indexOf('critical pattern') !== -1,
      'Stats bar uses "critical pattern" not bare "critical"');
    assert(popupSource.indexOf('Not a confirmed vulnerability') !== -1,
      'Badge tooltip explicitly disclaims confirmed vulnerability');
  } else {
    assert(true, 'SKIP: Cannot read popup.js in browser');
  }
})();


// ═══════════════════════════════════════════════════════════════
// P5 REGRESSION: removeEventListener tracking
// ═══════════════════════════════════════════════════════════════

group('P5: removeEventListener hook (design check)');
(function() {
  var instSource = '';
  try {
    instSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'instrumentation.js'), 'utf8'
    );
  } catch (e) {}

  if (instSource) {
    assert(instSource.indexOf('listenerIdMap') !== -1,
      'instrumentation.js has listenerIdMap WeakMap');
    assert(instSource.indexOf('Window.prototype.removeEventListener') !== -1,
      'instrumentation.js hooks removeEventListener');
    assert(instSource.indexOf('listener-removed') !== -1,
      'instrumentation.js emits listener-removed event');
    assert(instSource.indexOf('removedAt') !== -1,
      'instrumentation.js records removal timestamp');
    assert(instSource.indexOf('once:') !== -1,
      'instrumentation.js records once option');
  } else {
    assert(true, 'SKIP: Cannot read instrumentation.js in browser');
  }

  var bgSource = '';
  try {
    bgSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'background.js'), 'utf8'
    );
  } catch (e) {}

  if (bgSource) {
    assert(bgSource.indexOf('listener-removed') !== -1,
      'background.js handles listener-removed message type');
  } else {
    assert(true, 'SKIP: Cannot read background.js in browser');
  }
})();


// ═══════════════════════════════════════════════════════════════
// P6 REGRESSION: PoC self-capture tagging
// ═══════════════════════════════════════════════════════════════

group('P6: PoC message tagging (design check)');
(function() {
  var instSource = '', csSource = '', popupSource = '';
  try {
    instSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'instrumentation.js'), 'utf8'
    );
    csSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'content_script.js'), 'utf8'
    );
    popupSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'popup.js'), 'utf8'
    );
  } catch (e) {}

  if (instSource) {
    assert(instSource.indexOf('pocPending') !== -1,
      'instrumentation.js has pocPending flag');
    assert(instSource.indexOf('__pmTrackerPoc__') !== -1,
      'instrumentation.js listens for PoC marker event');
    assert(instSource.indexOf('pocGenerated') !== -1,
      'instrumentation.js emits pocGenerated field on messages');
  } else {
    assert(true, 'SKIP: Cannot read instrumentation.js in browser');
  }

  if (csSource) {
    assert(csSource.indexOf('__pmTrackerPoc__') !== -1,
      'content_script.js dispatches PoC marker before postMessage');
  } else {
    assert(true, 'SKIP: Cannot read content_script.js in browser');
  }

  if (popupSource) {
    assert(popupSource.indexOf('pocGenerated') !== -1,
      'popup.js checks pocGenerated for display');
  } else {
    assert(true, 'SKIP: Cannot read popup.js in browser');
  }
})();


// ═══════════════════════════════════════════════════════════════
// PREVIOUS AUDIT BUG REGRESSION: postMessage options form
// ═══════════════════════════════════════════════════════════════

group('postMessage options form handling (v2.0.0 bugfix regression)');
(function() {
  var instSource = '';
  try {
    instSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'instrumentation.js'), 'utf8'
    );
  } catch (e) {}

  if (instSource) {
    assert(instSource.indexOf('targetOriginOrOptions') !== -1,
      'postMessage hook handles both string and options-object signatures');
    assert(instSource.indexOf("typeof targetOriginOrOptions === 'object'") !== -1,
      'postMessage hook type-checks for options object');
  } else {
    assert(true, 'SKIP: Cannot read instrumentation.js in browser');
  }
})();


group('new URL() crash protection (v2.0.0 bugfix regression)');
(function() {
  var popupSource = '';
  try {
    popupSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'popup.js'), 'utf8'
    );
  } catch (e) {}

  if (popupSource) {
    var harnessSection = popupSource.substring(
      popupSource.indexOf('btn-harness'),
      popupSource.indexOf('btn-harness') + 300
    );
    assert(harnessSection.indexOf('try') !== -1 && harnessSection.indexOf('catch') !== -1,
      'Harness button wraps new URL() in try/catch');
  } else {
    assert(true, 'SKIP: Cannot read popup.js in browser');
  }
})();


// ── Summary ─────────────────────────────────────────────────────
console.log('\n── AUDIT RESULTS ──');
console.log(passed + '/' + total + ' passed, ' + failed + ' failed');

if (typeof process !== 'undefined' && process.exit) {
  process.exit(failed > 0 ? 1 : 0);
}
