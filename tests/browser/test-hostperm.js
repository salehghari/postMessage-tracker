/*
 * test-hostperm.js — Test if adding host_permissions fixes content script injection
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var puppeteer = require('puppeteer-core');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var PORT = 9222;
var EXT_SRC = path.resolve(__dirname, '..', '..');

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function testWithManifest(label, manifestPatch) {
  var extDir = path.join(os.tmpdir(), 'pmtracker-hostperm-test');
  if (fs.existsSync(extDir)) fs.rmSync(extDir, {recursive: true, force: true});
  fs.mkdirSync(extDir, {recursive: true});
  fs.mkdirSync(path.join(extDir, 'icons'), {recursive: true});

  ['background.js','instrumentation.js','content_script.js','analyzer.js',
   'popup.js','popup.html','popup.css','options.html','options.js'].forEach(function(f) {
    var src = path.join(EXT_SRC, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extDir, f));
  });
  ['icon16.png','icon48.png','icon128.png'].forEach(function(f) {
    var src = path.join(EXT_SRC, 'icons', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extDir, 'icons', f));
  });

  // Read original manifest and patch it
  var manifest = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
  Object.assign(manifest, manifestPatch);
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  var profile = path.join(os.tmpdir(), 'pmtracker-hp-' + Date.now());

  var chromeProc = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-extensions-except=' + extDir,
    '--load-extension=' + extDir,
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(5000);

  var browser;
  try {
    browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
  } catch (e) {
    console.log(label + ': FAILED to connect');
    chromeProc.kill();
    return;
  }

  var pages = await browser.pages();
  var page = pages[0] || await browser.newPage();
  await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
  await sleep(3000);

  var check = await page.evaluate(function() {
    return {
      installed: !!window.__postMessageTrackerInstalled__,
      addHooked: Window.prototype.addEventListener.toString().indexOf('native code') === -1,
      postHooked: window.postMessage.toString().indexOf('native code') === -1
    };
  });

  console.log(label + ': installed=' + check.installed + ' addHooked=' + check.addHooked + ' postHooked=' + check.postHooked);

  await browser.disconnect();
  chromeProc.kill();
  await sleep(2000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(extDir, {recursive: true, force: true}); } catch(e) {}
}

async function main() {
  // Test 1: Original manifest (no host_permissions)
  await testWithManifest('Test 1 (original)', {});

  // Test 2: Add host_permissions
  await testWithManifest('Test 2 (host_permissions)', {
    host_permissions: ['<all_urls>']
  });

  // Test 3: Add both host_permissions and permissions with scripting
  await testWithManifest('Test 3 (scripting+host)', {
    host_permissions: ['<all_urls>'],
    permissions: ['storage', 'tabs', 'activeTab', 'scripting']
  });
}

main().catch(function(e) { console.error(e); process.exit(1); });
