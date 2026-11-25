/*
 * test-verify-sw.js — Verify our service worker identity and check chrome://extensions
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var puppeteer = require('puppeteer-core');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var EXT_SRC = path.resolve(__dirname, '..', '..');
var PORT = 9555;

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  var ts = Date.now();
  var extDir = path.join(os.tmpdir(), 'pmtracker-verify-' + ts);
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

  var profile = path.join(os.tmpdir(), 'pmtracker-verify-p-' + ts);

  var chromeProc = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-extensions-except=' + extDir,
    '--load-extension=' + extDir,
    '--remote-debugging-port=' + PORT,
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(6000);

  var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});

  // 1. Check chrome://extensions
  var page = await browser.newPage();
  await page.goto('chrome://extensions');
  await sleep(2000);

  // Enable developer mode via CDP
  var client = await page.createCDPSession();

  // Try to get extension info from the page
  var extInfo = await page.evaluate(function() {
    var mgr = document.querySelector('extensions-manager');
    if (!mgr || !mgr.shadowRoot) return {error: 'no extensions-manager'};
    var itemList = mgr.shadowRoot.querySelector('extensions-item-list');
    if (!itemList || !itemList.shadowRoot) return {error: 'no item-list'};
    var items = itemList.shadowRoot.querySelectorAll('extensions-item');
    var result = [];
    items.forEach(function(item) {
      var name = item.shadowRoot ? item.shadowRoot.querySelector('#name') : null;
      var id = item.id;
      result.push({
        id: id,
        name: name ? name.textContent.trim() : 'unknown'
      });
    });
    return {count: result.length, items: result};
  });
  console.log('chrome://extensions: ' + JSON.stringify(extInfo, null, 2));

  await page.screenshot({path: path.join(__dirname, 'screenshots', 'verify-extensions.png'), fullPage: true});

  // 2. Connect to our SW and verify identity
  var allTargets = await browser.targets();
  for (var t of allTargets) {
    if (t.url() === 'chrome-extension://admccjkmockfdflocgggjfgdacdodkdf/background.js') {
      console.log('\nFound our SW target');
      var worker = await t.worker();
      if (worker) {
        // Check if our extension's APIs are available
        var swCheck = await worker.evaluate(function() {
          return {
            extName: chrome.runtime.getManifest().name,
            extVersion: chrome.runtime.getManifest().version,
            extId: chrome.runtime.id,
            hasContentScripts: chrome.runtime.getManifest().content_scripts ? chrome.runtime.getManifest().content_scripts.length : 0,
            permissions: chrome.runtime.getManifest().permissions
          };
        });
        console.log('SW identity: ' + JSON.stringify(swCheck, null, 2));
      }
    }
  }

  // 3. Navigate to test page and check with longer wait
  var testPage = await browser.newPage();

  // Set up console listener BEFORE navigation
  testPage.on('console', function(msg) {
    if (msg.text().indexOf('postMessage') !== -1 || msg.text().indexOf('PM-Tracker') !== -1 ||
        msg.text().indexOf('content_script') !== -1 || msg.text().indexOf('injected') !== -1) {
      console.log('[PAGE] ' + msg.text());
    }
  });

  await testPage.goto('http://localhost:9100/', {waitUntil: 'load'});
  console.log('\nPage loaded. Waiting 5s for content scripts...');
  await sleep(5000);

  var check = await testPage.evaluate(function() {
    return {
      installed: !!window.__postMessageTrackerInstalled__,
      addNative: Window.prototype.addEventListener.toString().indexOf('native code') !== -1,
      documentScripts: document.querySelectorAll('script').length,
      bodyInnerHTML: document.body.innerHTML.substring(0, 200)
    };
  });
  console.log('Content script check: ' + JSON.stringify(check));

  // 4. Try opening popup with correct extension ID
  try {
    var popPage = await browser.newPage();
    await popPage.goto('chrome-extension://admccjkmockfdflocgggjfgdacdodkdf/popup.html', {waitUntil: 'load', timeout: 5000});
    console.log('\nPopup loaded! Title: ' + await popPage.title());
    await popPage.screenshot({path: path.join(__dirname, 'screenshots', 'verify-popup.png')});
    await popPage.close();
  } catch (e) {
    console.log('\nPopup: ' + e.message.substring(0, 100));
  }

  await browser.disconnect();
  chromeProc.kill();
  await sleep(1000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(extDir, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
