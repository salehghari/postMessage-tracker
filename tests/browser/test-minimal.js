/*
 * test-minimal.js — Minimal extension content script injection test
 * Creates a tiny test extension and checks if content scripts inject
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var puppeteer = require('puppeteer-core');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var PORT = 9222;

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  // Create minimal test extension
  var minExtDir = path.join(os.tmpdir(), 'pmtracker-minimal-ext');
  if (fs.existsSync(minExtDir)) fs.rmSync(minExtDir, {recursive: true, force: true});
  fs.mkdirSync(minExtDir, {recursive: true});

  fs.writeFileSync(path.join(minExtDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: "Minimal Test",
    version: "1.0",
    content_scripts: [{
      matches: ["<all_urls>"],
      js: ["inject.js"],
      run_at: "document_start",
      all_frames: true,
      world: "MAIN"
    }],
    background: {service_worker: "bg.js"}
  }));

  fs.writeFileSync(path.join(minExtDir, 'inject.js'),
    'window.__minimalTestExtension__ = true;\nconsole.log("[MINIMAL-EXT] Content script injected in MAIN world");');

  fs.writeFileSync(path.join(minExtDir, 'bg.js'),
    'console.log("[MINIMAL-EXT] Service worker started");');

  // Also copy our real extension
  var realExtDir = path.join(os.tmpdir(), 'pmtracker-ext-clean');
  if (!fs.existsSync(realExtDir)) {
    var srcDir = path.resolve(__dirname, '..', '..');
    fs.mkdirSync(realExtDir, {recursive: true});
    fs.mkdirSync(path.join(realExtDir, 'icons'), {recursive: true});
    ['manifest.json','background.js','instrumentation.js','content_script.js','analyzer.js',
     'popup.js','popup.html','popup.css','options.html','options.js'].forEach(function(f) {
      var src = path.join(srcDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(realExtDir, f));
    });
    ['icon16.png','icon48.png','icon128.png'].forEach(function(f) {
      var src = path.join(srcDir, 'icons', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(realExtDir, 'icons', f));
    });
  }

  var tmpProfile = path.join(os.tmpdir(), 'pmtracker-mintest-' + Date.now());

  // Test 1: Load BOTH extensions
  console.log('Test 1: Loading both minimal + real extension...');
  var bothPaths = minExtDir + ',' + realExtDir;
  var chromeProc = cp.spawn(CHROME, [
    '--user-data-dir=' + tmpProfile,
    '--no-first-run',
    '--disable-extensions-except=' + bothPaths,
    '--load-extension=' + bothPaths,
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  await sleep(5000);

  // Check targets
  var targetData = await new Promise(function(resolve, reject) {
    http.get('http://localhost:' + PORT + '/json/list', function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(JSON.parse(data)); });
    }).on('error', reject);
  });
  console.log('CDP targets:');
  targetData.forEach(function(t) { console.log('  ' + t.type + ': ' + t.url.substring(0, 80)); });

  // Connect and navigate
  var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
  var pages = await browser.pages();
  var page = pages[0] || await browser.newPage();

  await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
  await sleep(3000);

  // Check both extensions
  var check = await page.evaluate(function() {
    return {
      minimal: !!window.__minimalTestExtension__,
      pmtracker: !!window.__postMessageTrackerInstalled__,
      addStr: Window.prototype.addEventListener.toString().substring(0, 60),
      postStr: window.postMessage.toString().substring(0, 60)
    };
  });
  console.log('Content script check: ' + JSON.stringify(check, null, 2));

  // Check service worker console logs
  var swTarget = targetData.find(function(t) {
    return t.url.indexOf('background.js') !== -1;
  });
  if (swTarget) {
    console.log('\nService worker URL: ' + swTarget.url);
    // Connect to SW via CDP
    try {
      var ws = require('ws');
      // Try using puppeteer's CDP session
      var swTargets = await browser.targets();
      for (var t of swTargets) {
        if (t.url().indexOf('background.js') !== -1) {
          console.log('Found SW target via puppeteer: ' + t.url());
          var worker = await t.worker();
          if (worker) {
            var swEval = await worker.evaluate(function() {
              return 'Service worker eval works';
            });
            console.log('SW eval: ' + swEval);
          }
        }
      }
    } catch (e) {
      console.log('SW access error: ' + e.message);
    }
  }

  await browser.disconnect();
  chromeProc.kill();
  await sleep(1000);
  try { fs.rmSync(tmpProfile, {recursive: true, force: true}); } catch(e) {}
  try { fs.rmSync(minExtDir, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
