/*
 * test_analyzer.js — Tests for the security analysis engine
 * Run in browser: open tests/test.html
 * Run in Node: node tests/test_analyzer.js (loads analyzer.js)
 */

// ── Node.js compatibility shim ──────────────────────────────────
if (typeof window === 'undefined') {
  var fs = require('fs');
  var vm = require('vm');
  var code = fs.readFileSync(require('path').join(__dirname, '..', 'analyzer.js'), 'utf8');
  var sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  var Analyzer = sandbox.Analyzer;
}

// ── Test framework ──────────────────────────────────────────────
var passed = 0, failed = 0, total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    log('  PASS: ' + message);
  } else {
    failed++;
    log('  FAIL: ' + message);
  }
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message + ' (got: ' + actual + ', expected: ' + expected + ')');
}

function assertIncludes(arr, item, message) {
  var found = arr.some(function(a) { return a === item; });
  assert(found, message + ' (looking for: ' + item + ' in [' + arr.join(', ') + '])');
}

function group(name) {
  log('\n── ' + name + ' ──');
}

function log(msg) {
  if (typeof console !== 'undefined') console.log(msg);
  if (typeof document !== 'undefined') {
    var el = document.getElementById('output');
    if (el) el.textContent += msg + '\n';
  }
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

group('Origin Validation Detection');

(function() {
  // No origin check at all
  var code1 = 'function(event) { document.body.innerHTML = event.data; }';
  var r1 = Analyzer.analyzeOriginValidation(code1);
  assert(!r1.hasCheck, 'No origin check detected in sink-only listener');

  // Strict equality check
  var code2 = 'function(event) { if (event.origin === "https://example.com") { process(event.data); } }';
  var r2 = Analyzer.analyzeOriginValidation(code2);
  assert(r2.hasCheck, 'Strict equality origin check detected');
  assertEqual(r2.strength, 'strong', 'Strict equality rated as strong');

  // indexOf check (weak)
  var code3 = 'function(e) { if (e.origin.indexOf("example.com") !== -1) { handle(e.data); } }';
  var r3 = Analyzer.analyzeOriginValidation(code3);
  assert(r3.hasCheck, 'indexOf origin check detected');
  assertEqual(r3.strength, 'weak', 'indexOf rated as weak');

  // includes check (weak)
  var code4 = 'function(evt) { if (evt.origin.includes("example")) { go(evt.data); } }';
  var r4 = Analyzer.analyzeOriginValidation(code4);
  assert(r4.hasCheck, 'includes origin check detected');
  assertEqual(r4.strength, 'weak', 'includes rated as weak');

  // endsWith check (weak)
  var code5 = 'function(msg) { if (msg.origin.endsWith(".example.com")) { go(msg.data); } }';
  var r5 = Analyzer.analyzeOriginValidation(code5);
  assert(r5.hasCheck, 'endsWith origin check detected');
  assertEqual(r5.strength, 'weak', 'endsWith rated as weak');

  // startsWith check (moderate)
  var code6 = 'function(e) { if (e.origin.startsWith("https://app.example")) { handle(e.data); } }';
  var r6 = Analyzer.analyzeOriginValidation(code6);
  assert(r6.hasCheck, 'startsWith origin check detected');
  assertEqual(r6.strength, 'moderate', 'startsWith rated as moderate');

  // Allow-list pattern (strong)
  var code7 = 'function(e) { var allowedOrigins = ["https://a.com"]; if (allowedOrigins.includes(e.origin)) { process(e.data); } }';
  var r7 = Analyzer.analyzeOriginValidation(code7);
  assert(r7.hasCheck, 'Allow-list origin check detected');
  assertEqual(r7.strength, 'strong', 'Allow-list rated as strong');

  // Regex origin check
  var code8 = 'function(e) { if (e.origin.match(/^https:\\/\\/.*\\.example\\.com$/)) { go(); } }';
  var r8 = Analyzer.analyzeOriginValidation(code8);
  assert(r8.hasCheck, 'Regex origin check detected');
  assertEqual(r8.strength, 'variable', 'Regex rated as variable');
})();


group('Sink Detection');

(function() {
  // eval
  var code1 = 'function(e) { eval(e.data); }';
  var sinks1 = Analyzer.analyzeSinks(code1);
  assert(sinks1.length > 0, 'eval() detected as sink');
  assertEqual(sinks1[0].severity, 'critical', 'eval() rated critical');

  // innerHTML
  var code2 = 'function(e) { document.getElementById("x").innerHTML = e.data; }';
  var sinks2 = Analyzer.analyzeSinks(code2);
  assert(sinks2.length > 0, 'innerHTML detected as sink');
  assertEqual(sinks2[0].severity, 'high', 'innerHTML rated high');

  // outerHTML
  var code3 = 'function(e) { el.outerHTML = e.data; }';
  var sinks3 = Analyzer.analyzeSinks(code3);
  assert(sinks3.length > 0, 'outerHTML detected as sink');

  // document.write
  var code4 = 'function(e) { document.write(e.data); }';
  var sinks4 = Analyzer.analyzeSinks(code4);
  assert(sinks4.length > 0, 'document.write detected as sink');

  // insertAdjacentHTML
  var code5 = 'function(e) { el.insertAdjacentHTML("beforeend", e.data); }';
  var sinks5 = Analyzer.analyzeSinks(code5);
  assert(sinks5.length > 0, 'insertAdjacentHTML detected as sink');

  // location assignment
  var code6 = 'function(e) { location.href = e.data.url; }';
  var sinks6 = Analyzer.analyzeSinks(code6);
  assert(sinks6.length > 0, 'location.href detected as sink');

  // postMessage relay
  var code7 = 'function(e) { parent.postMessage(e.data, "*"); }';
  var sinks7 = Analyzer.analyzeSinks(code7);
  assert(sinks7.length > 0, 'postMessage relay detected as sink');

  // No sinks
  var code8 = 'function(e) { console.log(e.data); }';
  var sinks8 = Analyzer.analyzeSinks(code8);
  assertEqual(sinks8.length, 0, 'console.log not flagged as sink');

  // new Function()
  var code9 = 'function(e) { var fn = new Function(e.data); fn(); }';
  var sinks9 = Analyzer.analyzeSinks(code9);
  assert(sinks9.length > 0, 'new Function() detected as sink');
  assertEqual(sinks9[0].severity, 'critical', 'new Function() rated critical');
})();


group('Data Flow Analysis');

(function() {
  // Direct data access
  var code1 = 'function(e) { var d = e.data; process(d); }';
  var df1 = Analyzer.analyzeDataFlow(code1);
  assert(df1.accessesData, 'Direct event.data access detected');

  // Destructured data
  var code2 = 'function(e) { const {type, payload} = e.data; }';
  var df2 = Analyzer.analyzeDataFlow(code2);
  assert(df2.destructuresData, 'Destructured event.data detected');

  // JSON.parse
  var code3 = 'function(e) { var d = JSON.parse(e.data); }';
  var df3 = Analyzer.analyzeDataFlow(code3);
  assert(df3.parsesJson, 'JSON.parse detected');
  assert(df3.accessesData, 'Data access through JSON.parse detected');

  // No data access
  var code4 = 'function(e) { console.log("message received"); }';
  var df4 = Analyzer.analyzeDataFlow(code4);
  assert(!df4.accessesData, 'No data access in signal-only listener');
})();


group('Confidence Classification');

(function() {
  // Critical: no origin + eval
  var code1 = 'function(event) { eval(event.data); }';
  var r1 = Analyzer.classifyListener(code1);
  assertEqual(r1.confidence, 'critical', 'No origin + eval = critical');
  assert(r1.findings.length > 0, 'Has findings for critical case');

  // High: no origin + innerHTML
  var code2 = 'function(e) { document.getElementById("x").innerHTML = e.data; }';
  var r2 = Analyzer.classifyListener(code2);
  assertEqual(r2.confidence, 'high', 'No origin + innerHTML = high');

  // High: weak origin + innerHTML
  var code3 = 'function(e) { if (e.origin.indexOf("example") > -1) { el.innerHTML = e.data; } }';
  var r3 = Analyzer.classifyListener(code3);
  assertEqual(r3.confidence, 'high', 'Weak origin + innerHTML = high');

  // Medium: no origin + data access + no visible sink
  var code4 = 'function(e) { var d = e.data; processMessage(d); }';
  var r4 = Analyzer.classifyListener(code4);
  assertEqual(r4.confidence, 'medium', 'No origin + data access = medium');

  // Low: no origin, no data, no sinks (signal-only)
  var code5 = 'function(e) { hideOverlay(); }';
  var r5 = Analyzer.classifyListener(code5);
  assertEqual(r5.confidence, 'low', 'No origin, no data, no sinks = low');

  // Info: strong origin + sinks
  var code6 = 'function(e) { if (e.origin === "https://trusted.com") { el.innerHTML = e.data; } }';
  var r6 = Analyzer.classifyListener(code6);
  assertEqual(r6.confidence, 'info', 'Strong origin + sinks = info');

  // Info: origin check, no sinks
  var code7 = 'function(e) { if (e.origin === "https://trusted.com") { update(e.data.count); } }';
  var r7 = Analyzer.classifyListener(code7);
  assertEqual(r7.confidence, 'info', 'Origin check + no sinks = info');
})();


group('False Positive Reduction');

(function() {
  // The word "origin" in a string should NOT count as origin check
  var code1 = 'function(e) { console.log("check origin"); el.innerHTML = e.data; }';
  var r1 = Analyzer.classifyListener(code1);
  // This should NOT be classified as having origin check because "origin" appears
  // in a string, not as event.origin access. However our regex looks for event.origin
  // pattern specifically, so this should correctly NOT match.
  assert(r1.confidence === 'high' || r1.confidence === 'critical',
    'String containing "origin" does not falsely trigger origin check');

  // Native code listener should be treated normally by analyzer
  // (filtering happens in instrumentation, not here)
  var code2 = 'function () { [native code] }';
  var r2 = Analyzer.classifyListener(code2);
  assertEqual(r2.confidence, 'low', 'Native code listener = low (benign)');

  // Listener that only checks type, not dangerous
  var code3 = 'function(e) { if (e.data.type === "resize") { updateLayout(); } }';
  var r3 = Analyzer.classifyListener(code3);
  assert(r3.confidence === 'medium' || r3.confidence === 'low',
    'Type-checking listener without sinks = medium or low');

  // Location sink with origin check should not be critical
  var code4 = 'function(e) { if (e.origin === "https://app.com") { location.href = e.data.url; } }';
  var r4 = Analyzer.classifyListener(code4);
  assert(r4.confidence !== 'critical' && r4.confidence !== 'high',
    'Location sink with strong origin check = not critical/high');
})();


group('Sender Analysis');

(function() {
  // Wildcard targetOrigin
  var r1 = Analyzer.analyzeSender({wildcardOrigin: true, targetOrigin: '*'});
  assertEqual(r1.confidence, 'medium', 'Wildcard sender = medium');
  assert(r1.findings.length > 0, 'Wildcard sender has findings');

  // Specific targetOrigin
  var r2 = Analyzer.analyzeSender({wildcardOrigin: false, targetOrigin: 'https://example.com'});
  assertEqual(r2.confidence, 'info', 'Specific origin sender = info');
  assertEqual(r2.findings.length, 0, 'Specific origin sender has no findings');
})();


group('Edge Cases');

(function() {
  // Empty listener
  var r1 = Analyzer.classifyListener('');
  assert(r1.confidence !== undefined, 'Empty string does not crash');

  // Minified code (single line, no spaces)
  var code2 = 'function(e){if(e.origin==="https://x.com"){el.innerHTML=e.data}}';
  var r2 = Analyzer.classifyListener(code2);
  assert(r2.origin.hasCheck, 'Minified code: origin check detected');
  assert(r2.sinks.length > 0, 'Minified code: sinks detected');

  // Arrow function
  var code3 = '(e) => { if (e.origin !== "https://trusted.com") return; process(e.data); }';
  var r3 = Analyzer.classifyListener(code3);
  assert(r3.origin.hasCheck, 'Arrow function: origin check detected');

  // Multiple sinks
  var code4 = 'function(e) { eval(e.data.code); document.write(e.data.html); location.href = e.data.url; }';
  var r4 = Analyzer.classifyListener(code4);
  assert(r4.sinks.length >= 3, 'Multiple sinks detected: ' + r4.sinks.length);
  assertEqual(r4.confidence, 'critical', 'Multiple sinks without origin check = critical');

  // Very long listener (performance)
  var longCode = 'function(e) { ' + 'var x = e.data; '.repeat(200) + '}';
  var start = Date.now();
  var r5 = Analyzer.classifyListener(longCode);
  var elapsed = Date.now() - start;
  assert(elapsed < 100, 'Long listener analyzed in < 100ms (took ' + elapsed + 'ms)');
})();


group('Parameter Extraction');

(function() {
  // Regular function
  var p1 = Analyzer.extractListenerParam('function(event) { }');
  assertEqual(p1.type, 'named', 'Regular function: type = named');
  assertEqual(p1.name, 'event', 'Regular function: name = event');

  // Named function
  var p2 = Analyzer.extractListenerParam('function handler(myEvent) { }');
  assertEqual(p2.type, 'named', 'Named function: type = named');
  assertEqual(p2.name, 'myEvent', 'Named function: name = myEvent');

  // Arrow with parens
  var p3 = Analyzer.extractListenerParam('(eventData) => { }');
  assertEqual(p3.type, 'named', 'Arrow (parens): type = named');
  assertEqual(p3.name, 'eventData', 'Arrow (parens): name = eventData');

  // Arrow without parens
  var p4 = Analyzer.extractListenerParam('evt => { }');
  assertEqual(p4.type, 'named', 'Arrow (no parens): type = named');
  assertEqual(p4.name, 'evt', 'Arrow (no parens): name = evt');

  // Destructured
  var p5 = Analyzer.extractListenerParam('function({origin, data}) { }');
  assertEqual(p5.type, 'destructured', 'Destructured: type = destructured');
  assert(p5.raw.indexOf('origin') !== -1, 'Destructured: raw contains origin');

  // Arrow destructured
  var p6 = Analyzer.extractListenerParam('({origin, data}) => { }');
  assertEqual(p6.type, 'destructured', 'Arrow destructured: type = destructured');

  // Unknown (no recognizable function)
  var p7 = Analyzer.extractListenerParam('some random code');
  assertEqual(p7.type, 'unknown', 'Unknown code: type = unknown');
})();


group('Custom Parameter Origin Detection');

(function() {
  // Arrow function with custom param — was previously missed
  var code1 = '(myEvent) => { if (myEvent.origin === "https://x.com") return; }';
  var r1 = Analyzer.analyzeOriginValidation(code1);
  assert(r1.hasCheck, 'Arrow fn with custom param "myEvent" — origin check detected');
  assertEqual(r1.strength, 'strong', 'Custom param strict equality rated strong');

  // Regular function with custom param
  var code2 = 'function(messageEvent) { if (messageEvent.origin !== "https://app.com") return; el.innerHTML = messageEvent.data; }';
  var r2 = Analyzer.analyzeOriginValidation(code2);
  assert(r2.hasCheck, 'Custom param "messageEvent" — origin check detected');

  // Custom param with no origin check should still classify correctly
  var code3 = 'function(eventData) { el.innerHTML = eventData.data; }';
  var r3 = Analyzer.classifyListener(code3);
  assertEqual(r3.confidence, 'high', 'Custom param with innerHTML, no origin = high');

  // Custom param with origin + sinks = info
  var code4 = 'function(messageEvent) { if (messageEvent.origin === "https://t.com") { el.innerHTML = messageEvent.data; } }';
  var r4 = Analyzer.classifyListener(code4);
  assertEqual(r4.confidence, 'info', 'Custom param with strong origin + sinks = info');

  // Arrow without parens + custom name
  var code5 = 'msgEvent => { if (msgEvent.origin === "https://t.com") return; }';
  var r5 = Analyzer.analyzeOriginValidation(code5);
  assert(r5.hasCheck, 'Arrow (no parens) custom param — origin check detected');

  // Destructured origin check
  var code6 = 'function({origin, data}) { if (origin === "https://t.com") { process(data); } }';
  var r6 = Analyzer.analyzeOriginValidation(code6);
  assert(r6.hasCheck, 'Destructured origin — check detected');
  assert(r6.checks.length > 0, 'Destructured origin — has specific check');

  // Custom param data flow detection
  var code7 = 'function(payload) { var d = payload.data; process(d); }';
  var r7 = Analyzer.analyzeDataFlow(code7);
  assert(r7.accessesData, 'Custom param "payload" — data access detected');

  // Custom param sink detection (param-dependent sinks)
  var code8 = 'function(msgObj) { setTimeout(msgObj.data, 100); }';
  var r8 = Analyzer.analyzeSinks(code8);
  assert(r8.some(function(s) { return s.name === 'setTimeout(string)'; }),
    'Custom param "msgObj" — setTimeout sink detected');
})();


group('Parameter Unknown Handling');

(function() {
  // When param extraction fails and no standard origin check found,
  // should report insufficient evidence, not "no origin check"
  var code1 = 'unknown_code_format: { origin_check_here; eval(something); }';
  var r1 = Analyzer.classifyListener(code1);
  assert(r1.origin.paramUnknown, 'Unknown param format — paramUnknown is true');
  assert(r1.confidence !== 'critical', 'Unknown param with eval — NOT critical (insufficient evidence)');

  // But standard params should still work even with paramUnknown
  var code2 = 'weird_wrapper { event.origin === "https://x.com" }';
  var r2 = Analyzer.analyzeOriginValidation(code2);
  assert(r2.hasCheck, 'Standard param detected even when extraction fails');
})();


group('looseEquality/strictEquality Overlap Fix');

(function() {
  // Strict equality should NOT also trigger loose equality
  var code1 = 'function(e) { if (e.origin === "https://x.com") {} }';
  var r1 = Analyzer.analyzeOriginValidation(code1);
  var checkNames = r1.checks.map(function(c) { return c.name; });
  assert(checkNames.indexOf('strictEquality') !== -1, '=== triggers strictEquality');
  assert(checkNames.indexOf('looseEquality') === -1, '=== does NOT trigger looseEquality');

  // Loose equality should still work
  var code2 = 'function(e) { if (e.origin == "https://x.com") {} }';
  var r2 = Analyzer.analyzeOriginValidation(code2);
  var checkNames2 = r2.checks.map(function(c) { return c.name; });
  assert(checkNames2.indexOf('looseEquality') !== -1, '== triggers looseEquality');
  assert(checkNames2.indexOf('strictEquality') === -1, '== does NOT trigger strictEquality');
})();


// ── Summary ─────────────────────────────────────────────────────
group('RESULTS');
log(passed + '/' + total + ' passed, ' + failed + ' failed');

if (typeof process !== 'undefined' && process.exit) {
  process.exit(failed > 0 ? 1 : 0);
}
