/*
 * test-bootstrap.js — Bootstrap Chrome profile with developer mode,
 * then relaunch with --load-extension
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var puppeteer = require('puppeteer-core');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var EXT_SRC = path.resolve(__dirname, '..', '..');
var SCREENSHOTS = path.join(__dirname, 'screenshots');

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  var ts = Date.now();
  var extDir = path.join(os.tmpdir(), 'pmtracker-boot-' + ts);
  fs.mkdirSync(extDir, {recursive: true});
  fs.mkdirSync(path.join(extDir, 'icons'), {recursive: true});
  ['manifest.json','background.js','instrumentation.js','content_script.js','analyzer.js',
   'popup.js','popup.html','popup.css','options.html','options.js'].forEach(function(f) {
    var src = path.join(EXT_SRC, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extDir, f));
  });
  ['icon16.png','icon48.png','icon128.png'].forEach(function(f) {
    var src = path.join(EXT_SRC, 'icons', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extDir, 'icons', f));
  });

  var profile = path.join(os.tmpdir(), 'pmtracker-bootp-' + ts);
  var PORT = 9800;

  // ═══ PHASE 1: Bootstrap profile with developer mode ═══
  console.log('Phase 1: Bootstrap profile with developer mode...');
  var proc1 = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--remote-debugging-port=' + PORT,
    'chrome://extensions'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(5000);

  var browser1 = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
  var pages1 = await browser1.pages();
  var extPage = pages1.find(function(p) { return p.url().indexOf('extensions') !== -1; });
  if (!extPage) extPage = await browser1.newPage();
  if (extPage.url().indexOf('extensions') === -1) {
    await extPage.goto('chrome://extensions');
    await sleep(2000);
  }

  // Toggle developer mode ON
  var toggled = await extPage.evaluate(function() {
    var mgr = document.querySelector('extensions-manager');
    if (!mgr || !mgr.shadowRoot) return 'no-mgr';
    var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
    if (!toolbar || !toolbar.shadowRoot) return 'no-toolbar';
    var toggle = toolbar.shadowRoot.querySelector('#devMode');
    if (!toggle) return 'no-toggle';
    if (!toggle.checked) {
      toggle.click();
      return 'toggled-ON';
    }
    return 'already-ON';
  });
  console.log('  Developer mode: ' + toggled);
  await sleep(2000);

  // Verify
  var devModeState = await extPage.evaluate(function() {
    var mgr = document.querySelector('extensions-manager');
    var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
    var toggle = toolbar.shadowRoot.querySelector('#devMode');
    return toggle ? toggle.checked : 'unknown';
  });
  console.log('  Verified: ' + devModeState);

  // Graceful close so Chrome flushes Preferences
  try { await browser1.close(); } catch(e) { proc1.kill(); }
  await sleep(5000);

  // Check Preferences file
  var prefsFile = path.join(profile, 'Default', 'Preferences');
  if (fs.existsSync(prefsFile)) {
    var prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    console.log('  Prefs extensions.ui: ' + JSON.stringify(prefs.extensions ? prefs.extensions.ui : 'missing'));
  }

  // ═══ PHASE 2: Relaunch with --load-extension ═══
  console.log('\nPhase 2: Relaunch with --load-extension...');
  PORT = 9801;
  var proc2 = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--load-extension=' + extDir,
    '--remote-debugging-port=' + PORT,
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(6000);

  var browser2 = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});

  // Check for our extension
  var ourId = null;
  for (var t of await browser2.targets()) {
    if (t.type() === 'service_worker') {
      try {
        var w = await t.worker();
        if (w) {
          var name = await w.evaluate(function() { return chrome.runtime.getManifest().name; });
          console.log('  SW: ' + name + ' (id=' + t.url().split('/')[2] + ')');
          if (name === 'postMessage Tracker') {
            ourId = t.url().split('/')[2];
          }
        }
      } catch(e) {}
    }
  }

  if (ourId) {
    console.log('\n  *** EXTENSION LOADED: ' + ourId + ' ***');

    // Test content scripts
    var pages = await browser2.pages();
    var page = pages[0] || await browser2.newPage();
    await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
    await sleep(3000);

    var check = await page.evaluate(function() {
      return {
        installed: !!window.__postMessageTrackerInstalled__,
        addHooked: Window.prototype.addEventListener.toString().indexOf('native code') === -1,
        postHooked: window.postMessage.toString().indexOf('native code') === -1,
        removeHooked: Window.prototype.removeEventListener.toString().indexOf('native code') === -1
      };
    });
    console.log('  Content scripts: ' + JSON.stringify(check));

    // Test popup
    try {
      var popPage = await browser2.newPage();
      await popPage.goto('chrome-extension://' + ourId + '/popup.html', {waitUntil: 'load', timeout: 5000});
      console.log('  Popup: OK (title=' + await popPage.title() + ')');
      await popPage.screenshot({path: path.join(SCREENSHOTS, 'bootstrap-popup.png')});
      await popPage.close();
    } catch(e) {
      console.log('  Popup: ' + e.message.substring(0, 80));
    }

    await page.screenshot({path: path.join(SCREENSHOTS, 'bootstrap-page.png'), fullPage: true});
  } else {
    console.log('  Extension still NOT loaded');

    // Check extensions page
    var ePage = await browser2.newPage();
    await ePage.goto('chrome://extensions');
    await sleep(2000);
    var eInfo = await ePage.evaluate(function() {
      var mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return {error: 'no-mgr'};
      var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
      if (!toolbar || !toolbar.shadowRoot) return {error: 'no-toolbar'};
      var toggle = toolbar.shadowRoot.querySelector('#devMode');
      var list = mgr.shadowRoot.querySelector('extensions-item-list');
      var items = list && list.shadowRoot ? list.shadowRoot.querySelectorAll('extensions-item') : [];
      return {
        devMode: toggle ? toggle.checked : 'unknown',
        extCount: items.length
      };
    });
    console.log('  Extensions page: ' + JSON.stringify(eInfo));
    await ePage.screenshot({path: path.join(SCREENSHOTS, 'bootstrap-extensions.png'), fullPage: true});
    await ePage.close();
  }

  await browser2.disconnect();
  proc2.kill();
  await sleep(1000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(extDir, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
