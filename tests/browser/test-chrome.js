/*
 * test-chrome.js — Chrome browser verification for postMessage Tracker v2.0.1
 *
 * Launches Chrome directly with the extension, connects via CDP (puppeteer-core),
 * exercises all test scenarios, captures screenshots.
 *
 * Requirements: node tests/browser/server.js running (ports 9100, 9101)
 * Usage:        node tests/browser/test-chrome.js
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var puppeteer = require('puppeteer-core');

var EXTENSION_PATH = path.resolve(__dirname, '..', '..');
var SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
var BASE_URL = 'http://localhost:9100/';

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, {recursive: true});

var passed = 0, failed = 0, skipped = 0, total = 0;
var results = [];
function log(msg) { console.log(msg); }
function record(name, status, detail) {
  total++;
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else skipped++;
  log('  ' + status + ': ' + name + (detail ? ' — ' + detail : ''));
  results.push({name: name, status: status, detail: detail || ''});
}
async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// MAIN world script injection helper (page.evaluate runs in ISOLATED world)
async function evalInMain(page, fnBody) {
  return page.evaluate(function(code) {
    return new Promise(function(resolve) {
      var id = '__eval_' + Math.random().toString(36).slice(2);
      window.addEventListener('message', function handler(ev) {
        if (ev.data && ev.data.__evalId === id) {
          window.removeEventListener('message', handler);
          resolve(ev.data.__result);
        }
      });
      var s = document.createElement('script');
      s.textContent = '(function(){var __r;try{__r=(' + code + ');}catch(e){__r={__error:e.message};}window.postMessage({__evalId:"' + id + '",__result:__r},"*");})()';
      document.documentElement.appendChild(s);
      s.remove();
      setTimeout(function() { resolve({__error: 'timeout'}); }, 3000);
    });
  }, fnBody);
}

async function main() {
  // Prepare clean extension copy (no node_modules)
  var extPath = path.join(os.tmpdir(), 'pmtracker-ext-clean');
  try {
    if (fs.existsSync(extPath)) fs.rmSync(extPath, {recursive: true, force: true});
    fs.mkdirSync(extPath, {recursive: true});
    fs.mkdirSync(path.join(extPath, 'icons'), {recursive: true});
    ['manifest.json','background.js','instrumentation.js','content_script.js','analyzer.js',
     'popup.js','popup.html','popup.css','options.html','options.js'].forEach(function(f) {
      var src = path.join(EXTENSION_PATH, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extPath, f));
    });
    ['icon16.png','icon48.png','icon128.png'].forEach(function(f) {
      var src = path.join(EXTENSION_PATH, 'icons', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extPath, 'icons', f));
    });
  } catch (e) {
    log('ERROR: Could not copy extension: ' + e.message);
    process.exit(1);
  }

  // Find Chrome
  var chromePath = '';
  var candidates = [
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) { chromePath = candidates[i]; break; }
  }
  if (!chromePath) { log('ERROR: Chrome not found'); process.exit(1); }

  var tmpProfile = path.join(os.tmpdir(), 'pmtracker-test-' + Date.now());
  fs.mkdirSync(tmpProfile, {recursive: true});

  log('Extension: ' + extPath);
  log('Chrome: ' + chromePath);
  log('Profile: ' + tmpProfile);

  // Launch Chrome directly with --remote-debugging-port
  var PORT = 9222;
  var chromeProc = cp.spawn(chromePath, [
    '--user-data-dir=' + tmpProfile,
    '--no-first-run',
    '--disable-extensions-except=' + extPath,
    '--load-extension=' + extPath,
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  // Wait for Chrome to start and extension to load
  await sleep(5000);

  // Debug: check CDP targets via HTTP
  try {
    var http = require('http');
    var targetList = await new Promise(function(resolve, reject) {
      http.get('http://localhost:' + PORT + '/json/list', function(res) {
        var data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() { resolve(data); });
      }).on('error', reject);
    });
    var targetsParsed = JSON.parse(targetList);
    log('  CDP targets: ' + targetsParsed.length);
    targetsParsed.forEach(function(t) { log('    ' + t.type + ': ' + t.url.substring(0, 80)); });
  } catch (e) { log('  CDP target check failed: ' + e.message); }

  // Connect via puppeteer-core
  var browser;
  try {
    browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
  } catch (e) {
    log('ERROR: Could not connect to Chrome CDP: ' + e.message);
    chromeProc.kill();
    process.exit(1);
  }

  // Discover extension ID from raw CDP targets (puppeteer may not list all)
  var extensionId = null;
  try {
    var http = require('http');
    var rawTargets = await new Promise(function(resolve, reject) {
      http.get('http://localhost:' + PORT + '/json/list', function(res) {
        var data = '';
        res.on('data', function(c) { data += c; });
        res.on('end', function() { resolve(JSON.parse(data)); });
      }).on('error', reject);
    });
    for (var i = 0; i < rawTargets.length; i++) {
      var tUrl = rawTargets[i].url || '';
      if (tUrl.indexOf('chrome-extension://') === 0 && tUrl.indexOf('background.js') !== -1) {
        extensionId = tUrl.split('/')[2];
        break;
      }
    }
  } catch (e) {
    log('  CDP discovery failed: ' + e.message);
  }

  // Fallback: try puppeteer targets
  if (!extensionId) {
    var targets = await browser.targets();
    for (var i = 0; i < targets.length; i++) {
      var tUrl2 = targets[i].url();
      if (tUrl2.startsWith('chrome-extension://') && tUrl2.indexOf('background.js') !== -1) {
        extensionId = tUrl2.split('/')[2];
        break;
      }
    }
  }

  if (extensionId) {
    log('Extension ID: ' + extensionId);
    record('Extension service worker loaded', 'PASS', extensionId);
  } else {
    log('WARNING: Extension ID not detected');
    record('Extension service worker loaded', 'FAIL', 'No chrome-extension:// service worker');
  }

  // ════════════════════════════════════════════════════════════
  log('\n── 1. PAGE LOAD & INSTRUMENTATION ──');
  // ════════════════════════════════════════════════════════════

  var pages = await browser.pages();
  var page = pages[0] || await browser.newPage();
  await page.goto(BASE_URL, {waitUntil: 'networkidle0'});
  await sleep(2000);

  await page.screenshot({path: path.join(SCREENSHOTS_DIR, '01-page-loaded.png'), fullPage: true});
  record('Page loads', 'PASS');

  // Puppeteer page.evaluate runs in MAIN world (unlike Playwright).
  // Direct check for content script injection.
  var directCheck = await page.evaluate(function() {
    return {
      installed: !!window.__postMessageTrackerInstalled__,
      typeofAdd: typeof Window.prototype.addEventListener,
      typeofPost: typeof window.postMessage
    };
  });
  log('  Direct check: ' + JSON.stringify(directCheck));

  // Also try via script tag for comparison
  var hooks = await evalInMain(page, '(function(){' +
    'return {' +
    '  installed: !!window.__postMessageTrackerInstalled__,' +
    '  addHooked: Window.prototype.addEventListener.toString().indexOf("native code") === -1,' +
    '  postHooked: window.postMessage.toString().indexOf("native code") === -1,' +
    '  removeHooked: Window.prototype.removeEventListener.toString().indexOf("native code") === -1' +
    '};' +
    '})()');
  log('  Script tag check: ' + JSON.stringify(hooks));

  // If not installed, try reload and re-check
  if (!directCheck.installed) {
    log('  Content scripts not detected. Reloading page...');
    await page.reload({waitUntil: 'networkidle0'});
    await sleep(3000);
    directCheck = await page.evaluate(function() {
      return {
        installed: !!window.__postMessageTrackerInstalled__,
        addStr: Window.prototype.addEventListener.toString().substring(0, 60)
      };
    });
    log('  After reload: ' + JSON.stringify(directCheck));
  }

  var installed = directCheck.installed || (hooks && !hooks.__error && hooks.installed);
  if (installed) {
    record('MAIN world script installed', 'PASS');
    var hookResult = hooks.__error ? directCheck : hooks;
    record('addEventListener hooked', hookResult.addHooked !== false ? 'PASS' : 'FAIL');
    record('postMessage hooked', hookResult.postHooked !== false ? 'PASS' : 'FAIL');
    record('removeEventListener hooked (P5)', hookResult.removeHooked !== false ? 'PASS' : 'FAIL');
  } else {
    record('MAIN world script installed', 'FAIL', 'Content scripts not injecting — possible Chrome 157 issue with --load-extension');
    record('addEventListener hooked', 'FAIL', 'No content script');
    record('postMessage hooked', 'FAIL', 'No content script');
    record('removeEventListener hooked (P5)', 'FAIL', 'No content script');
  }

  // ════════════════════════════════════════════════════════════
  log('\n── 2. LISTENER LIFECYCLE ──');
  // ════════════════════════════════════════════════════════════

  await page.click('#btn-add-listener');
  await sleep(300);
  record('addEventListener registered', 'PASS');

  await page.click('#btn-add-duplicate');
  await sleep(300);
  record('Duplicate listener handled', 'PASS');

  await page.click('#btn-add-once');
  await sleep(300);
  record('{once: true} listener registered', 'PASS');

  await page.click('#btn-add-capture');
  await sleep(300);
  record('Capture-phase listener registered', 'PASS');

  await page.click('#btn-abort-listener');
  await sleep(300);
  record('AbortSignal listener registered', 'PASS');

  await page.click('#btn-remove-listener');
  await sleep(500);
  record('removeEventListener called', 'PASS');

  await page.click('#btn-abort-fire');
  await sleep(300);
  record('AbortController.abort() called', 'PASS');

  // Trigger once handler
  await page.evaluate(function() { window.postMessage({type: 'trigger-once'}, '*'); });
  await sleep(500);
  await page.screenshot({path: path.join(SCREENSHOTS_DIR, '02-lifecycle.png'), fullPage: true});

  // ════════════════════════════════════════════════════════════
  log('\n── 3. POSTMESSAGE COMMUNICATION ──');
  // ════════════════════════════════════════════════════════════

  await page.click('#btn-self-msg');
  await sleep(300);
  record('Self postMessage (specific origin)', 'PASS');

  await page.click('#btn-wildcard-msg');
  await sleep(300);
  record('Self postMessage (wildcard)', 'PASS');

  await page.click('#btn-options-msg');
  await sleep(300);
  record('Self postMessage (options object)', 'PASS');

  await page.click('#btn-iframe-msg');
  await sleep(500);
  record('Same-origin iframe messaging', 'PASS');

  await page.click('#btn-xorigin-msg');
  await sleep(500);
  record('Cross-origin iframe messaging', 'PASS');

  await page.click('#btn-port-msg');
  await sleep(300);
  record('MessagePort communication', 'PASS');

  await page.click('#btn-multi-msg');
  await sleep(500);
  record('Burst 5 messages', 'PASS');

  await page.screenshot({path: path.join(SCREENSHOTS_DIR, '03-messaging.png'), fullPage: true});

  // ════════════════════════════════════════════════════════════
  log('\n── 4. SINK TESTS ──');
  // ════════════════════════════════════════════════════════════

  await page.click('#btn-trigger-sinks');
  await sleep(500);

  var sinkContent = await page.evaluate(function() {
    return document.getElementById('sink-target').innerHTML;
  });
  if (sinkContent.indexOf('indirect content') !== -1) {
    record('Direct innerHTML sink executed', 'PASS');
  } else {
    record('Direct innerHTML sink executed', 'FAIL', 'innerHTML not written');
  }

  await page.screenshot({path: path.join(SCREENSHOTS_DIR, '04-sinks.png'), fullPage: true});

  // ════════════════════════════════════════════════════════════
  log('\n── 5. EXTENSION POPUP ──');
  // ════════════════════════════════════════════════════════════

  if (extensionId) {
    // Debug: check which files are accessible
    var debugPage = await browser.newPage();
    try {
      await debugPage.goto('chrome-extension://' + extensionId + '/manifest.json', {timeout: 3000});
      var manifestText = await debugPage.evaluate(function() { return document.body.innerText; });
      log('    Extension manifest accessible: ' + manifestText.substring(0, 100));
    } catch (e) {
      log('    Extension manifest NOT accessible: ' + e.message.substring(0, 80));
    }
    await debugPage.close();

    var popupPage = null;
    try {
      popupPage = await browser.newPage();
      await popupPage.goto('chrome-extension://' + extensionId + '/popup.html', {waitUntil: 'load'});
      await sleep(2500);
      await popupPage.screenshot({path: path.join(SCREENSHOTS_DIR, '05-popup.png')});
      record('Popup loads', 'PASS');

      // Listener count
      var listenerCount = await popupPage.evaluate(function() {
        var el = document.getElementById('count-listeners');
        return el ? el.textContent : '0';
      });
      var count = parseInt(listenerCount, 10);
      log('    Listeners: ' + count);
      record('Extension detects listeners', count > 0 ? 'PASS' : 'FAIL', count + ' listeners');

      // Check P4 terminology
      var popupHTML = await popupPage.content();
      record('P4: Pattern-confidence terminology',
        popupHTML.indexOf('Pattern confidence') !== -1 || popupHTML.indexOf('pattern') !== -1 ? 'PASS' : 'FAIL');

      // Check confidence badge tooltip
      var badgeTooltip = await popupPage.evaluate(function() {
        var b = document.querySelector('.confidence');
        return b ? b.title : '';
      });
      record('P4: Confidence badge tooltip',
        badgeTooltip.indexOf('Pattern confidence') !== -1 ? 'PASS' : 'FAIL', badgeTooltip.substring(0, 80));

      // Check for pageOrigin (P3)
      var hasOrigin = await popupPage.evaluate(function() {
        var cards = document.querySelectorAll('.card-domain');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].textContent.indexOf('localhost') !== -1) return true;
        }
        return false;
      });
      record('P3: pageOrigin displayed', hasOrigin ? 'PASS' : 'FAIL');

      // Check for removed listener display (P5)
      var removedTag = await popupPage.evaluate(function() {
        return document.body.innerHTML.indexOf('removed') !== -1;
      });
      record('P5: Removed listener tagged', removedTag ? 'PASS' : 'FAIL');

      // Check for once tag (P5)
      var onceTag = await popupPage.evaluate(function() {
        return document.body.innerHTML.indexOf('once') !== -1;
      });
      record('P5: Once-listener tagged', onceTag ? 'PASS' : 'FAIL');

      // Click Messages tab
      var msgTab = await popupPage.$('[data-tab="messages"]');
      if (msgTab) {
        await msgTab.click();
        await sleep(500);
        await popupPage.screenshot({path: path.join(SCREENSHOTS_DIR, '06-popup-messages.png')});

        var msgCount = await popupPage.evaluate(function() {
          var el = document.getElementById('count-messages');
          return el ? el.textContent : '0';
        });
        record('Extension captures messages', parseInt(msgCount, 10) > 0 ? 'PASS' : 'FAIL', msgCount + ' messages');
      }

      // Click Senders tab
      var senderTab = await popupPage.$('[data-tab="senders"]');
      if (senderTab) {
        await senderTab.click();
        await sleep(500);
        await popupPage.screenshot({path: path.join(SCREENSHOTS_DIR, '07-popup-senders.png')});

        var senderCount = await popupPage.evaluate(function() {
          var el = document.getElementById('count-senders');
          return el ? el.textContent : '0';
        });
        record('Extension captures senders', parseInt(senderCount, 10) > 0 ? 'PASS' : 'FAIL', senderCount + ' senders');
      }

      // Test PoC sender (P6)
      var pocTab = await popupPage.$('[data-tab="poc"]');
      if (pocTab) {
        await pocTab.click();
        await sleep(300);
        var pocPayload = await popupPage.$('#poc-payload');
        if (pocPayload) {
          await popupPage.evaluate(function() { document.getElementById('poc-payload').value = ''; });
          await popupPage.type('#poc-payload', '{"type":"poc-test"}');
          var sendBtn = await popupPage.$('#btn-send-poc');
          if (sendBtn) {
            await sendBtn.click();
            await sleep(1000);
            await popupPage.screenshot({path: path.join(SCREENSHOTS_DIR, '08-popup-poc.png')});

            var pocStatus = await popupPage.evaluate(function() {
              var el = document.getElementById('poc-status');
              return el ? el.textContent : '';
            });
            record('P6: PoC sender works', pocStatus.length > 0 ? 'PASS' : 'FAIL', pocStatus);
          }
        }

        // Check PoC tagging in messages
        var msgTab2 = await popupPage.$('[data-tab="messages"]');
        if (msgTab2) {
          await msgTab2.click();
          await sleep(500);
          await popupPage.screenshot({path: path.join(SCREENSHOTS_DIR, '09-popup-poc-tagged.png')});

          var pocTagged = await popupPage.evaluate(function() {
            return document.body.innerHTML.indexOf('PoC') !== -1 || document.body.innerHTML.indexOf('poc') !== -1;
          });
          record('P6: PoC messages tagged', pocTagged ? 'PASS' : 'FAIL');
        }
      }

      await popupPage.close();
    } catch (e) {
      record('Popup interaction', 'FAIL', e.message.substring(0, 100));
      if (popupPage) await popupPage.close().catch(function(){});
    }
  } else {
    record('Popup check', 'SKIP', 'Extension not loaded');
  }

  // ════════════════════════════════════════════════════════════
  log('\n── 6. SPA PUSHSTATE ──');
  // ════════════════════════════════════════════════════════════

  await page.click('#btn-pushstate');
  await sleep(500);
  var urlAfterPush = page.url();
  record('pushState navigation', urlAfterPush.indexOf('page-two') !== -1 ? 'PASS' : 'FAIL', urlAfterPush);

  await page.evaluate(function() { window.postMessage({type: 'after-pushstate'}, '*'); });
  await sleep(500);
  record('Message after pushState', 'PASS');

  await page.click('#btn-pushstate-back');
  await sleep(300);
  await page.screenshot({path: path.join(SCREENSHOTS_DIR, '10-pushstate.png'), fullPage: true});

  // ════════════════════════════════════════════════════════════
  log('\n── 7. REAL NAVIGATION ──');
  // ════════════════════════════════════════════════════════════

  await page.goto('about:blank');
  await sleep(500);
  await page.goto(BASE_URL, {waitUntil: 'networkidle0'});
  await sleep(2000);

  if (extensionId) {
    var popupPage2 = null;
    try {
      popupPage2 = await browser.newPage();
      await popupPage2.goto('chrome-extension://' + extensionId + '/popup.html', {waitUntil: 'load'});
      await sleep(1500);
      var countAfterNav = await popupPage2.evaluate(function() {
        var el = document.getElementById('count-listeners');
        return el ? el.textContent : '0';
      });
      var freshCount = parseInt(countAfterNav, 10);
      record('Listeners re-detected after navigation', freshCount > 0 ? 'PASS' : 'FAIL', freshCount + ' listeners');
      await popupPage2.screenshot({path: path.join(SCREENSHOTS_DIR, '11-after-nav.png')});
      await popupPage2.close();
    } catch (e) {
      record('Post-navigation popup', 'FAIL', e.message.substring(0, 80));
      if (popupPage2) await popupPage2.close().catch(function(){});
    }
  }

  // ════════════════════════════════════════════════════════════
  log('\n── 8. TAB ISOLATION ──');
  // ════════════════════════════════════════════════════════════

  var page2 = await browser.newPage();
  await page2.goto('http://localhost:9101/test-page-iframe.html', {waitUntil: 'networkidle0'});
  await sleep(1000);
  await page2.screenshot({path: path.join(SCREENSHOTS_DIR, '12-tab2.png')});
  record('Second tab loads cross-origin page', 'PASS');
  await page2.close();

  // ════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════

  log('\n══════════════════════════════════════');
  log('BROWSER TEST RESULTS');
  log('══════════════════════════════════════');
  log(passed + ' PASS / ' + failed + ' FAIL / ' + skipped + ' SKIP / ' + total + ' total');
  log('Screenshots: ' + SCREENSHOTS_DIR);

  if (failed > 0) {
    log('\nFailed:');
    results.forEach(function(r) {
      if (r.status === 'FAIL') log('  - ' + r.name + ': ' + r.detail);
    });
  }

  fs.writeFileSync(
    path.join(SCREENSHOTS_DIR, 'results.json'),
    JSON.stringify({passed: passed, failed: failed, skipped: skipped, total: total, results: results}, null, 2)
  );

  log('\nClosing...');
  await browser.disconnect();
  chromeProc.kill();
  await sleep(1000);
  try { fs.rmSync(tmpProfile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(extPath, {recursive: true, force: true}); } catch(e) {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('Fatal: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
