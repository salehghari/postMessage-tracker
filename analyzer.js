/*
 * analyzer.js — Security analysis engine for postMessage listeners
 *
 * Performs structured analysis with pattern confidence scoring:
 *   - Dynamic listener parameter extraction (regular, arrow, destructured)
 *   - Origin validation quality assessment (11 patterns)
 *   - Dangerous sink detection (17 categories, presence-based)
 *   - Wildcard targetOrigin detection (senders)
 *   - Pattern confidence classification: critical / high / medium / low / info
 *
 * Design principle: minimize false positives. Only flag what can be
 * reasoned about from the listener source code. Never claim "vulnerable"
 * — classify as "observation", "suspicious", "potential", or "needs validation".
 * When parameter identification is ambiguous, report insufficient evidence.
 */
var Analyzer = (function() {
  'use strict';

  var STANDARD_PARAMS = ['event', 'e', 'ev', 'evt', 'msg'];

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Parameter extraction ───────────────────────────────────────────

  function extractListenerParam(code) {
    var match;

    // Named function: function(param, ...) or function name(param, ...)
    match = code.match(/function\s*(?:\w+\s*)?\((\s*\{[^}]*\}|\s*[^,)]+)/);
    if (match) {
      var p = match[1].trim();
      if (p.charAt(0) === '{') {
        return {type: 'destructured', raw: p};
      }
      if (/^[a-zA-Z_$][\w$]*$/.test(p)) {
        return {type: 'named', name: p};
      }
    }

    // Arrow with parens: (param, ...) =>
    match = code.match(/\((\s*\{[^}]*\}|\s*[^,)]+)\s*(?:,[^)]*)?\)\s*=>/);
    if (match) {
      var p2 = match[1].trim();
      if (p2.charAt(0) === '{') {
        return {type: 'destructured', raw: p2};
      }
      if (/^[a-zA-Z_$][\w$]*$/.test(p2)) {
        return {type: 'named', name: p2};
      }
    }

    // Arrow without parens: param =>
    match = code.match(/\b([a-zA-Z_$][\w$]*)\s*=>/);
    if (match) {
      return {type: 'named', name: match[1]};
    }

    return {type: 'unknown'};
  }

  function buildParamGroup(extracted) {
    var names = STANDARD_PARAMS.slice();
    if (extracted && extracted.type === 'named' && names.indexOf(extracted.name) === -1) {
      names.push(extracted.name);
    }
    return '(?:' + names.map(escapeRegex).join('|') + ')';
  }

  // ── Pattern templates (PG = paramGroup placeholder) ────────────────

  var ORIGIN_CHECK_DEFS = [
    {name: 'strictEquality', template: 'PG\\.origin\\s*(?:===|!==)\\s*[\'"`]', strength: 'strong', note: 'Strict equality origin check'},
    {name: 'looseEquality', template: 'PG\\.origin\\s*(?:==(?!=)|!=(?!=))\\s*[\'"`]', strength: 'moderate', note: 'Loose equality origin check (type coercion possible)'},
    {name: 'indexOfCheck', template: '\\.origin\\.indexOf\\s*\\(', strength: 'weak', note: 'indexOf origin check — bypassable via subdomain (e.g. evil.com.example.com)'},
    {name: 'includesCheck', template: '\\.origin\\.includes\\s*\\(', strength: 'weak', note: 'includes() origin check — bypassable via subdomain or substring'},
    {name: 'startsWithCheck', template: '\\.origin\\.startsWith\\s*\\(', strength: 'moderate', note: 'startsWith origin check — ensure full origin matched, not just scheme'},
    {name: 'endsWithCheck', template: '\\.origin\\.endsWith\\s*\\(', strength: 'weak', note: 'endsWith origin check — bypassable via crafted domain suffix'},
    {name: 'regexTest', template: '\\.origin\\.match\\s*\\(|\\.origin\\.search\\s*\\(|\\.test\\s*\\(\\s*PG\\.origin', strength: 'variable', note: 'Regex origin check — strength depends on pattern specificity'},
    {name: 'switchCase', template: 'switch\\s*\\(\\s*PG\\.origin\\s*\\)', strength: 'strong', note: 'Switch-case origin check'},
    {name: 'variableComparison', template: 'PG\\.origin\\s*(?:===?|!==?)\\s*[a-zA-Z_$]', strength: 'moderate', note: 'Origin compared to variable — strength depends on variable source'},
    {name: 'allowListCheck', template: '(?:allowedOrigins?|validOrigins?|trustedOrigins?|whitelist|ALLOWED_ORIGINS)\\s*\\.(?:includes|indexOf|has|some)\\s*\\(\\s*PG\\.origin', strength: 'strong', note: 'Allow-list origin check'},
    {name: 'reverseAllowList', template: '\\.(?:includes|indexOf|has|some)\\s*\\(\\s*PG\\.origin\\s*\\)', strength: 'moderate', note: 'Array/Set membership check on origin'}
  ];

  var DESTRUCTURED_ORIGIN_CHECKS = [
    {name: 'strictEquality', pattern: /\borigin\s*(?:===|!==)\s*['"`]/, strength: 'strong', note: 'Strict equality origin check (destructured)'},
    {name: 'looseEquality', pattern: /\borigin\s*(?:==(?!=)|!=(?!=))\s*['"`]/, strength: 'moderate', note: 'Loose equality origin check (destructured)'},
    {name: 'switchCase', pattern: /switch\s*\(\s*origin\s*\)/, strength: 'strong', note: 'Switch-case origin check (destructured)'},
    {name: 'variableComparison', pattern: /\borigin\s*(?:===?|!==?)\s*[a-zA-Z_$]/, strength: 'moderate', note: 'Origin compared to variable (destructured)'},
    {name: 'allowListCheck', pattern: /(?:allowedOrigins?|validOrigins?|trustedOrigins?|whitelist|ALLOWED_ORIGINS)\s*\.(?:includes|indexOf|has|some)\s*\(\s*origin\b/, strength: 'strong', note: 'Allow-list origin check (destructured)'},
    {name: 'reverseAllowList', pattern: /\.(?:includes|indexOf|has|some)\s*\(\s*origin\s*\)/, strength: 'moderate', note: 'Array/Set membership check on origin (destructured)'}
  ];

  var SINK_DEFS = [
    {name: 'eval()', template: '\\beval\\s*\\(', severity: 'critical', category: 'code-execution'},
    {name: 'Function()', template: '\\bnew\\s+Function\\s*\\(', severity: 'critical', category: 'code-execution'},
    {name: 'setTimeout(string)', template: 'setTimeout\\s*\\(\\s*PG\\.data', severity: 'critical', category: 'code-execution'},
    {name: 'setInterval(string)', template: 'setInterval\\s*\\(\\s*PG\\.data', severity: 'critical', category: 'code-execution'},
    {name: 'innerHTML', template: '\\.innerHTML\\s*[\\+]?=', severity: 'high', category: 'dom-xss'},
    {name: 'outerHTML', template: '\\.outerHTML\\s*[\\+]?=', severity: 'high', category: 'dom-xss'},
    {name: 'insertAdjacentHTML', template: '\\.insertAdjacentHTML\\s*\\(', severity: 'high', category: 'dom-xss'},
    {name: 'document.write', template: 'document\\.write(?:ln)?\\s*\\(', severity: 'high', category: 'dom-xss'},
    {name: 'jQuery .html()', template: '\\.\\$?\\s*\\.?\\s*html\\s*\\(\\s*PG\\.data|\\.\\$?\\s*\\.?\\s*html\\s*\\([^)]*data', severity: 'high', category: 'dom-xss'},
    {name: 'jQuery .append()', template: '\\.append\\s*\\(\\s*PG\\.data', severity: 'high', category: 'dom-xss'},
    {name: 'location assignment', template: '(?:location\\.href|location\\.assign|location\\.replace|window\\.open)\\s*[\\(=]', severity: 'medium', category: 'open-redirect'},
    {name: 'location.hash', template: 'location\\.hash\\s*=', severity: 'low', category: 'open-redirect'},
    {name: 'script.src', template: '\\.src\\s*=\\s*PG\\.data', severity: 'critical', category: 'code-execution'},
    {name: 'postMessage relay', template: '\\.postMessage\\s*\\(\\s*PG\\.data', severity: 'medium', category: 'relay'},
    {name: 'cookie write', template: 'document\\.cookie\\s*=', severity: 'medium', category: 'data-manipulation'},
    {name: 'localStorage/sessionStorage', template: '(?:localStorage|sessionStorage)\\.setItem\\s*\\(', severity: 'low', category: 'data-manipulation'},
    {name: 'fetch/XMLHttpRequest', template: '(?:fetch|XMLHttpRequest|\\.ajax|\\.post|\\.get)\\s*\\(\\s*PG\\.data', severity: 'high', category: 'ssrf'}
  ];

  var DATA_ACCESS_TEMPLATES = [
    'PG\\.data',
    'PG\\[[\'"]data[\'"]\\]',
    'PG\\.data\\.',
    'PG\\.data\\[',
    'JSON\\.parse\\s*\\(\\s*PG\\.data\\s*\\)',
    'var\\s+\\w+\\s*=\\s*PG\\.data',
    '(?:let|const)\\s+\\w+\\s*=\\s*PG\\.data',
    '(?:let|const)\\s*\\{[^}]+\\}\\s*=\\s*PG\\.data'
  ];

  function buildPattern(template, paramGroup) {
    return new RegExp(template.replace(/PG/g, paramGroup));
  }

  // ── Analysis functions ──────────────────────────────────────────────

  function analyzeOriginValidation(code) {
    var result = {
      hasCheck: false,
      checks: [],
      strength: 'none',
      earlyReturn: false,
      paramName: null,
      paramUnknown: false
    };

    var extracted = extractListenerParam(code);
    var paramGroup = buildParamGroup(extracted);

    if (extracted.type === 'named') {
      result.paramName = extracted.name;
    } else if (extracted.type === 'destructured') {
      result.paramName = extracted.raw;
    } else {
      result.paramUnknown = true;
    }

    var destructuredOrigin = extracted.type === 'destructured'
      && extracted.raw && /\borigin\b/.test(extracted.raw);

    // Check for origin references using dynamic param group
    var hasOriginRef = new RegExp(paramGroup + '\\.origin').test(code);

    // Check for destructured origin
    if (!hasOriginRef && destructuredOrigin) {
      hasOriginRef = /\borigin\s*(?:===|!==|==|!=)/.test(code);
    }

    // Fallback: generic destructuring detection
    if (!hasOriginRef) {
      hasOriginRef = /\{\s*(?:.*,\s*)?origin(?:\s*,|\s*\})/.test(code)
        && /\borigin\s*(?:===|!==|==|!=)/.test(code);
    }

    if (!hasOriginRef) return result;

    result.hasCheck = true;

    // Check template-based patterns (param.origin)
    for (var i = 0; i < ORIGIN_CHECK_DEFS.length; i++) {
      var def = ORIGIN_CHECK_DEFS[i];
      var pat = buildPattern(def.template, paramGroup);
      if (pat.test(code)) {
        result.checks.push({
          name: def.name,
          strength: def.strength,
          note: def.note
        });
      }
    }

    // Check destructured origin patterns (bare origin variable)
    if (destructuredOrigin || /\{\s*(?:.*,\s*)?origin(?:\s*,|\s*\})/.test(code)) {
      for (var k = 0; k < DESTRUCTURED_ORIGIN_CHECKS.length; k++) {
        var dc = DESTRUCTURED_ORIGIN_CHECKS[k];
        if (dc.pattern.test(code)) {
          var alreadyFound = result.checks.some(function(c) { return c.name === dc.name; });
          if (!alreadyFound) {
            result.checks.push({
              name: dc.name,
              strength: dc.strength,
              note: dc.note
            });
          }
        }
      }
    }

    // Determine overall strength
    var strengths = result.checks.map(function(c) { return c.strength; });
    if (strengths.indexOf('strong') !== -1) result.strength = 'strong';
    else if (strengths.indexOf('moderate') !== -1) result.strength = 'moderate';
    else if (strengths.indexOf('weak') !== -1) result.strength = 'weak';
    else if (strengths.indexOf('variable') !== -1) result.strength = 'variable';
    else result.strength = 'present';

    // Check for early return pattern
    result.earlyReturn = /if\s*\([^)]*origin[^)]*\)\s*return\b/.test(code)
      || /if\s*\([^)]*origin[^)]*\)\s*\{?\s*return\b/.test(code)
      || /origin[^;]*!==?[^;]*\)\s*\{?\s*return\b/.test(code);

    return result;
  }

  function analyzeSinks(code, paramGroup) {
    if (!paramGroup) paramGroup = buildParamGroup(extractListenerParam(code));
    var found = [];
    for (var i = 0; i < SINK_DEFS.length; i++) {
      var sink = SINK_DEFS[i];
      var pat = buildPattern(sink.template, paramGroup);
      if (pat.test(code)) {
        found.push({
          name: sink.name,
          severity: sink.severity,
          category: sink.category
        });
      }
    }
    return found;
  }

  function analyzeDataFlow(code, paramGroup) {
    if (!paramGroup) paramGroup = buildParamGroup(extractListenerParam(code));

    var accessesData = false;
    for (var i = 0; i < DATA_ACCESS_TEMPLATES.length; i++) {
      var pat = buildPattern(DATA_ACCESS_TEMPLATES[i], paramGroup);
      if (pat.test(code)) {
        accessesData = true;
        break;
      }
    }

    var destructuresData = new RegExp(
      '(?:let|const|var)\\s*\\{[^}]+\\}\\s*=\\s*' + paramGroup + '\\.data'
    ).test(code)
      || /(?:let|const|var)\s*\{[^}]+\}\s*=\s*JSON\.parse/.test(code);

    var parsesJson = /JSON\.parse\s*\(/.test(code);

    return {
      accessesData: accessesData,
      destructuresData: destructuresData,
      parsesJson: parsesJson
    };
  }

  // ── Confidence classification ───────────────────────────────────────

  function classifyListener(code) {
    var extracted = extractListenerParam(code);
    var paramGroup = buildParamGroup(extracted);

    var origin = analyzeOriginValidation(code);
    var sinks = analyzeSinks(code, paramGroup);
    var dataFlow = analyzeDataFlow(code, paramGroup);

    var findings = [];
    var confidence = 'info';

    // When param extraction failed and no standard-name origin check found,
    // report insufficient evidence instead of claiming "no origin check"
    if (origin.paramUnknown && !origin.hasCheck) {
      confidence = 'low';
      findings.push({
        type: 'param-unknown',
        label: 'Unable to determine listener parameter',
        severity: 'low',
        detail: 'Could not extract listener parameter name. Origin validation status is uncertain. Manual review recommended.'
      });

      if (sinks.length > 0) {
        confidence = 'medium';
        findings[0].detail += ' Dangerous sinks detected — verify origin validation manually.';
      }
    }
    // Case 1: No origin check + dangerous sinks
    else if (!origin.hasCheck && sinks.length > 0) {
      var hasCriticalSink = sinks.some(function(s) { return s.severity === 'critical'; });
      var hasHighSink = sinks.some(function(s) { return s.severity === 'high'; });

      if (hasCriticalSink) {
        confidence = 'critical';
        findings.push({
          type: 'no-origin-with-critical-sink',
          label: 'No origin check with code execution sink',
          severity: 'critical',
          detail: 'Listener has no origin validation and contains code execution sinks. Needs manual validation.'
        });
      } else if (hasHighSink) {
        confidence = 'high';
        findings.push({
          type: 'no-origin-with-high-sink',
          label: 'No origin check with DOM XSS sink',
          severity: 'high',
          detail: 'Listener has no origin validation and contains dangerous DOM sinks. Needs manual validation.'
        });
      } else {
        confidence = 'medium';
        findings.push({
          type: 'no-origin-with-sink',
          label: 'No origin check with moderate sink',
          severity: 'medium',
          detail: 'Listener has no origin validation and contains potentially dangerous operations.'
        });
      }
    }
    // Case 2: Weak origin check + sinks
    else if (origin.hasCheck && origin.strength === 'weak' && sinks.length > 0) {
      confidence = 'high';
      findings.push({
        type: 'weak-origin-with-sink',
        label: 'Bypassable origin check with dangerous sink',
        severity: 'high',
        detail: 'Origin validation uses ' + origin.checks.map(function(c) { return c.note; }).join('; ') +
          '. These can be bypassed with crafted domains.'
      });
    }
    // Case 3: No origin check, no visible sinks, but accesses data
    else if (!origin.hasCheck && dataFlow.accessesData) {
      confidence = 'medium';
      findings.push({
        type: 'no-origin-accesses-data',
        label: 'No origin check — processes message data',
        severity: 'medium',
        detail: 'No origin validation but accesses event.data. Data flow into sinks may occur in called functions.'
      });
    }
    // Case 4: No origin check, no data access (might be benign)
    else if (!origin.hasCheck && !dataFlow.accessesData && sinks.length === 0) {
      confidence = 'low';
      findings.push({
        type: 'no-origin-no-data',
        label: 'No origin check (may be benign)',
        severity: 'low',
        detail: 'No origin validation visible, but no data access or dangerous sinks detected. May use message for signaling only.'
      });
    }
    // Case 5: Origin check present with sinks
    else if (origin.hasCheck && sinks.length > 0) {
      if (origin.strength === 'strong') {
        confidence = 'info';
        findings.push({
          type: 'origin-validated-with-sinks',
          label: 'Origin validated — sinks present',
          severity: 'info',
          detail: 'Strong origin validation detected. Sinks present but guarded. Review if validation matches expected origins.'
        });
      } else {
        confidence = 'low';
        findings.push({
          type: 'moderate-origin-with-sinks',
          label: 'Moderate origin check with sinks',
          severity: 'low',
          detail: 'Origin check present but strength is ' + origin.strength + '. Review validation logic.'
        });
      }
    }
    // Case 6: Origin check present, no sinks
    else if (origin.hasCheck) {
      confidence = 'info';
      findings.push({
        type: 'origin-validated',
        label: 'Origin check present',
        severity: 'info',
        detail: 'Origin validation detected (' + origin.strength + '). No dangerous sinks found.'
      });
    }

    // Add individual sink findings
    for (var i = 0; i < sinks.length; i++) {
      findings.push({
        type: 'sink',
        label: sinks[i].name,
        severity: sinks[i].severity,
        category: sinks[i].category,
        detail: 'Dangerous sink: ' + sinks[i].name
      });
    }

    // Add weak origin check warnings
    if (origin.hasCheck) {
      for (var j = 0; j < origin.checks.length; j++) {
        var check = origin.checks[j];
        if (check.strength === 'weak') {
          findings.push({
            type: 'weak-origin',
            label: check.note,
            severity: 'medium',
            detail: check.note
          });
        }
      }
    }

    return {
      confidence: confidence,
      findings: findings,
      origin: origin,
      sinks: sinks,
      dataFlow: dataFlow
    };
  }

  // ── Sender analysis ───────────────────────────────────────────────

  function analyzeSender(entry) {
    var findings = [];
    var confidence = 'info';

    if (entry.wildcardOrigin) {
      confidence = 'medium';
      findings.push({
        type: 'wildcard-target',
        label: 'Wildcard targetOrigin "*"',
        severity: 'medium',
        detail: 'postMessage sent with targetOrigin "*". Message readable by any window/frame, including attacker-controlled ones.'
      });
    }

    return {confidence: confidence, findings: findings};
  }

  // ── Public API ────────────────────────────────────────────────────

  return {
    classifyListener: classifyListener,
    analyzeSender: analyzeSender,
    analyzeOriginValidation: analyzeOriginValidation,
    analyzeSinks: analyzeSinks,
    analyzeDataFlow: analyzeDataFlow,
    extractListenerParam: extractListenerParam,
    CONFIDENCE_LEVELS: ['critical', 'high', 'medium', 'low', 'info'],
    SEVERITY_COLORS: {
      critical: '#f38ba8',
      high: '#fab387',
      medium: '#f9e2af',
      low: '#89b4fa',
      info: '#a6adc8'
    }
  };

})();
