/*
 * test-loadunpacked.js — Load extension via chrome.developerPrivate API
 * Phase 1: Enable dev mode + load extension via chrome://extensions APIs
 * Phase 2: Navigate to test page and verify content scripts
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
  var extDir = path.join(os.tmpdir(), 'pmtracker-unp-' + ts);
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

  var profile = path.join(os.tmpdir(), 'pmtracker-unpp-' + ts);
  var PORT = 9850;

  console.log('Extension: ' + extDir);

  var proc = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--remote-debugging-port=' + PORT,
    'chrome://extensions'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(5000);

  var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
  var pages = await browser.pages();
  var extPage = pages.find(function(p) { return p.url().indexOf('extensions') !== -1; }) || pages[0];

  if (extPage.url().indexOf('extensions') === -1) {
    await extPage.goto('chrome://extensions');
    await sleep(2000);
  }

  // 1. Enable developer mode
  await extPage.evaluate(function() {
    var mgr = document.querySelector('extensions-manager');
    var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
    var toggle = toolbar.shadowRoot.querySelector('#devMode');
    if (!toggle.checked) toggle.click();
  });
  await sleep(1000);
  console.log('Developer mode enabled');

  // 2. Try chrome.developerPrivate.loadUnpacked
  // Need to convert path to forward slashes for Chrome
  var extPathForChrome = extDir.replace(/\\/g, '/');

  var loadResult = await extPage.evaluate(function(extPath) {
    return new Promise(function(resolve) {
      if (typeof chrome !== 'undefined' && chrome.developerPrivate) {
        // Use loadUnpacked API
        chrome.developerPrivate.loadUnpacked(extPath, function(result) {
          if (chrome.runtime.lastError) {
            resolve({error: chrome.runtime.lastError.message});
          } else {
            resolve({success: true, result: result});
          }
        });
      } else {
        resolve({error: 'chrome.developerPrivate not available'});
      }
    });
  }, extPathForChrome);

  console.log('loadUnpacked result: ' + JSON.stringify(loadResult));

  if (loadResult.error) {
    // Try alternate approach: use choosePath first then load
    console.log('Trying alternate approach with choosePath...');

    // Try to call loadUnpacked with options object
    var loadResult2 = await extPage.evaluate(function(extPath) {
      return new Promise(function(resolve) {
        if (!chrome.developerPrivate) {
          resolve({error: 'no developerPrivate'});
          return;
        }
        // List available methods
        var methods = Object.keys(chrome.developerPrivate).filter(function(k) {
          return typeof chrome.developerPrivate[k] === 'function';
        });
        resolve({methods: methods});
      });
    }, extPathForChrome);
    console.log('developerPrivate methods: ' + JSON.stringify(loadResult2));

    // Try loadUnpacked with just the path
    if (loadResult2.methods && loadResult2.methods.indexOf('loadUnpacked') !== -1) {
      var loadResult3 = await extPage.evaluate(function(extPath) {
        return new Promise(function(resolve) {
          try {
            // Chrome 120+ uses promises
            var result = chrome.developerPrivate.loadUnpacked({
              failQuietly: true,
              populateError: true,
              useDraggedPath: false,
              retryGuid: ''
            });
            if (result && result.then) {
              result.then(function(r) { resolve({success: true, result: r}); })
                    .catch(function(e) { resolve({error: e.message}); });
            } else {
              resolve({noPromise: true});
            }
          } catch(e) {
            resolve({error: e.message});
          }
        });
      }, extPathForChrome);
      console.log('loadUnpacked v2: ' + JSON.stringify(loadResult3));
    }
  }

  await sleep(2000);

  // Check if extension appeared
  var extInfo = await extPage.evaluate(function() {
    var mgr = document.querySelector('extensions-manager');
    var list = mgr.shadowRoot.querySelector('extensions-item-list');
    var items = list && list.shadowRoot ? list.shadowRoot.querySelectorAll('extensions-item') : [];
    var result = [];
    items.forEach(function(item) {
      var nameEl = item.shadowRoot ? item.shadowRoot.querySelector('#name') : null;
      result.push({
        id: item.id,
        name: nameEl ? nameEl.textContent.trim() : 'unknown'
      });
    });
    return result;
  });
  console.log('Extensions on page: ' + JSON.stringify(extInfo, null, 2));

  await extPage.screenshot({path: path.join(SCREENSHOTS, 'loadunpacked.png'), fullPage: true});

  // If loaded, test content scripts
  var ourExt = extInfo.find(function(e) { return e.name === 'postMessage Tracker'; });
  if (ourExt) {
    console.log('\n*** EXTENSION LOADED: ' + ourExt.id + ' ***');

    var testPage = await browser.newPage();
    await testPage.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
    await sleep(3000);

    var check = await testPage.evaluate(function() {
      return {
        installed: !!window.__postMessageTrackerInstalled__,
        addHooked: Window.prototype.addEventListener.toString().indexOf('native code') === -1,
        postHooked: window.postMessage.toString().indexOf('native code') === -1
      };
    });
    console.log('Content scripts: ' + JSON.stringify(check));
    await testPage.screenshot({path: path.join(SCREENSHOTS, 'loadunpacked-page.png'), fullPage: true});
  }

  await browser.disconnect();
  proc.kill();
  await sleep(1000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(extDir, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
