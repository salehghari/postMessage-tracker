/*
 * test-load-only.js — Test --load-extension without --disable-extensions-except
 * Also try different path formats
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

async function tryLaunch(label, args) {
  var PORT = 9600 + Math.floor(Math.random() * 100);
  var profile = path.join(os.tmpdir(), 'pmtracker-load-' + Date.now());

  var allArgs = [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--remote-debugging-port=' + PORT
  ].concat(args, ['about:blank']);

  console.log('\n' + label);
  console.log('  Args: ' + args.join(' ').substring(0, 200));

  var proc = cp.spawn(CHROME, allArgs, {stdio: ['ignore', 'pipe', 'pipe']});
  await sleep(5000);

  try {
    var targets = await new Promise(function(resolve, reject) {
      http.get('http://localhost:' + PORT + '/json/list', function(res) {
        var d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { resolve(JSON.parse(d)); });
      }).on('error', reject);
    });

    var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});

    // Check all SW targets for our extension
    var swTargets = targets.filter(function(t) { return t.type === 'service_worker'; });
    var ourExt = null;
    for (var t of await browser.targets()) {
      if (t.type() === 'service_worker') {
        try {
          var w = await t.worker();
          if (w) {
            var name = await w.evaluate(function() {
              return chrome.runtime.getManifest().name;
            });
            console.log('  SW: ' + name + ' (' + t.url().split('/')[2] + ')');
            if (name === 'postMessage Tracker') {
              ourExt = t.url().split('/')[2];
            }
          }
        } catch(e) {}
      }
    }

    if (ourExt) {
      console.log('  OUR EXTENSION FOUND: ' + ourExt);

      // Test content script
      var pages = await browser.pages();
      var page = pages[0] || await browser.newPage();
      await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
      await sleep(3000);

      var check = await page.evaluate(function() {
        return {
          installed: !!window.__postMessageTrackerInstalled__,
          addHooked: Window.prototype.addEventListener.toString().indexOf('native code') === -1
        };
      });
      console.log('  Content scripts: installed=' + check.installed + ' addHooked=' + check.addHooked);

      // Check popup
      try {
        var popPage = await browser.newPage();
        await popPage.goto('chrome-extension://' + ourExt + '/popup.html', {waitUntil: 'load', timeout: 5000});
        console.log('  Popup: OK');
        await popPage.close();
      } catch(e) {
        console.log('  Popup: ' + e.message.substring(0, 60));
      }
    } else {
      console.log('  OUR EXTENSION NOT FOUND');
      // Check chrome://extensions
      var page = await browser.newPage();
      await page.goto('chrome://extensions');
      await sleep(2000);
      var devMode = await page.evaluate(function() {
        var mgr = document.querySelector('extensions-manager');
        if (!mgr || !mgr.shadowRoot) return 'no-mgr';
        var toolbar = mgr.shadowRoot.querySelector('extensions-toolbar');
        if (!toolbar || !toolbar.shadowRoot) return 'no-toolbar';
        var toggle = toolbar.shadowRoot.querySelector('#devMode');
        return toggle ? (toggle.checked ? 'ON' : 'OFF') : 'no-toggle';
      });
      console.log('  Developer mode: ' + devMode);
    }

    await browser.disconnect();
  } catch (e) {
    console.log('  Error: ' + e.message.substring(0, 100));
  }

  proc.kill();
  await sleep(2000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
}

async function main() {
  var ts = Date.now();
  var extDir = path.join(os.tmpdir(), 'pmtracker-ld-' + ts);
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

  // Also try using source dir directly (has node_modules but let's see)
  var srcDirForward = EXT_SRC.replace(/\\/g, '/');
  var extDirForward = extDir.replace(/\\/g, '/');

  // Test 1: --load-extension only (no --disable-extensions-except)
  await tryLaunch('Test 1: --load-extension only', [
    '--load-extension=' + extDir
  ]);

  // Test 2: Both flags
  await tryLaunch('Test 2: both --disable-extensions-except + --load-extension', [
    '--disable-extensions-except=' + extDir,
    '--load-extension=' + extDir
  ]);

  // Test 3: Forward slashes
  await tryLaunch('Test 3: forward slashes', [
    '--load-extension=' + extDirForward
  ]);

  // Test 4: Original source dir (with node_modules)
  await tryLaunch('Test 4: original source dir', [
    '--load-extension=' + EXT_SRC
  ]);

  // Test 5: Enable developer mode flag
  await tryLaunch('Test 5: --enable-features=ExtensionsToolbarMenu', [
    '--load-extension=' + extDir,
    '--enable-features=ExtensionsToolbarMenu'
  ]);

  try { fs.rmSync(extDir, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
