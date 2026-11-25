/*
 * test-devmode.js — Enable developer mode in profile before loading extension
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var puppeteer = require('puppeteer-core');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var EXT_SRC = path.resolve(__dirname, '..', '..');

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  var ts = Date.now();
  var extDir = path.join(os.tmpdir(), 'pmtracker-dev-' + ts);
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

  var profile = path.join(os.tmpdir(), 'pmtracker-devp-' + ts);
  fs.mkdirSync(profile, {recursive: true});
  fs.mkdirSync(path.join(profile, 'Default'), {recursive: true});

  // Pre-configure profile with developer mode enabled
  var prefs = {
    extensions: {
      ui: {
        developer_mode: true
      }
    },
    profile: {
      extensions_in_developer_mode: true
    }
  };
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify(prefs));

  // Also create a Local State file
  var localState = {
    browser: {
      enabled_labs_experiments: []
    }
  };
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify(localState));

  var PORT = 9700 + Math.floor(Math.random() * 100);
  console.log('Extension: ' + extDir);
  console.log('Profile: ' + profile);
  console.log('Port: ' + PORT);

  // Test A: With developer mode in prefs
  console.log('\n--- Test A: Pre-configured developer mode ---');
  var proc = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--load-extension=' + extDir,
    '--disable-extensions-except=' + extDir,
    '--remote-debugging-port=' + PORT,
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(6000);

  var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});

  // Check SW targets
  var found = false;
  for (var t of await browser.targets()) {
    if (t.type() === 'service_worker') {
      try {
        var w = await t.worker();
        if (w) {
          var name = await w.evaluate(function() { return chrome.runtime.getManifest().name; });
          console.log('  SW: ' + name);
          if (name === 'postMessage Tracker') found = true;
        }
      } catch(e) {}
    }
  }
  console.log('  Extension loaded: ' + found);

  if (!found) {
    // Check developer mode status
    var page = await browser.newPage();
    await page.goto('chrome://extensions');
    await sleep(2000);
    var devInfo = await page.evaluate(function() {
      var mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return {error: 'no-mgr'};
      var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
      if (!toolbar || !toolbar.shadowRoot) return {error: 'no-toolbar'};
      var toggle = toolbar.shadowRoot.querySelector('#devMode');
      if (!toggle) return {error: 'no-toggle'};
      return {devMode: toggle.checked || false, ariaChecked: toggle.getAttribute('aria-checked')};
    });
    console.log('  Dev mode: ' + JSON.stringify(devInfo));

    // Try enabling developer mode via click
    var toggled = await page.evaluate(function() {
      var mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return false;
      var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
      if (!toolbar || !toolbar.shadowRoot) return false;
      var toggle = toolbar.shadowRoot.querySelector('#devMode');
      if (!toggle) return false;
      toggle.click();
      return true;
    });
    console.log('  Toggled dev mode: ' + toggled);
    await sleep(2000);

    // Try "Load unpacked" button
    var loadBtn = await page.evaluate(function() {
      var mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return 'no-mgr';
      var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
      if (!toolbar || !toolbar.shadowRoot) return 'no-toolbar';
      // Check all buttons
      var buttons = toolbar.shadowRoot.querySelectorAll('cr-button, button');
      var texts = [];
      buttons.forEach(function(b) { texts.push(b.textContent.trim()); });
      return texts;
    });
    console.log('  Buttons: ' + JSON.stringify(loadBtn));

    await page.close();
  }

  if (found) {
    // Full test!
    var page = (await browser.pages())[0] || await browser.newPage();
    await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
    await sleep(3000);
    var check = await page.evaluate(function() {
      return {
        installed: !!window.__postMessageTrackerInstalled__,
        addHooked: Window.prototype.addEventListener.toString().indexOf('native code') === -1,
        postHooked: window.postMessage.toString().indexOf('native code') === -1
      };
    });
    console.log('  Content scripts: ' + JSON.stringify(check));
  }

  await browser.disconnect();
  proc.kill();
  await sleep(2000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(extDir, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
