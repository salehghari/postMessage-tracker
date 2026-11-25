/*
 * test-programmatic.js — Test programmatic content script registration
 * Modifies background.js in a test copy to use chrome.scripting API
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

async function main() {
  var extDir = path.join(os.tmpdir(), 'pmtracker-programmatic-test');
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

  // Modify manifest: remove declarative content_scripts, add scripting + host_permissions
  var manifest = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
  delete manifest.content_scripts;
  manifest.permissions = ['storage', 'tabs', 'activeTab', 'scripting'];
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Prepend programmatic registration to background.js
  var bgOrig = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  var bgPrefix = `
// Programmatic content script registration (test override)
chrome.scripting.registerContentScripts([
  {
    id: "instrumentation",
    matches: ["<all_urls>"],
    js: ["instrumentation.js"],
    runAt: "document_start",
    allFrames: true,
    world: "MAIN"
  },
  {
    id: "content_script",
    matches: ["<all_urls>"],
    js: ["content_script.js"],
    runAt: "document_start",
    allFrames: true,
    world: "ISOLATED"
  }
]).then(function() {
  console.log("[PM-TRACKER] Content scripts registered programmatically");
}).catch(function(e) {
  console.log("[PM-TRACKER] Registration error: " + e.message);
});
`;
  fs.writeFileSync(path.join(extDir, 'background.js'), bgPrefix + '\n' + bgOrig);

  var profile = path.join(os.tmpdir(), 'pmtracker-prog-' + Date.now());

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

  // Check targets
  var targets = await new Promise(function(resolve, reject) {
    http.get('http://localhost:' + PORT + '/json/list', function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(JSON.parse(d)); });
    }).on('error', reject);
  });
  console.log('Targets:');
  targets.forEach(function(t) { console.log('  ' + t.type + ': ' + t.url.substring(0, 80)); });

  // Connect to service worker to check registration
  var swTarget = targets.find(function(t) { return t.url.indexOf('background.js') !== -1; });
  if (swTarget) {
    try {
      var browser2 = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
      var swTargets = await browser2.targets();
      for (var t of swTargets) {
        if (t.url().indexOf('background.js') !== -1) {
          var worker = await t.worker();
          if (worker) {
            var regResult = await worker.evaluate(function() {
              return chrome.scripting.getRegisteredContentScripts().then(function(scripts) {
                return scripts.map(function(s) { return s.id + ': ' + s.world; });
              });
            });
            console.log('Registered scripts: ' + JSON.stringify(regResult));
          }
        }
      }
      await browser2.disconnect();
    } catch (e) {
      console.log('SW check error: ' + e.message);
    }
  }

  // Connect and test
  var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
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
  console.log('\nProgrammatic registration result:');
  console.log('  installed=' + check.installed + ' addHooked=' + check.addHooked + ' postHooked=' + check.postHooked);

  if (!check.installed) {
    // Try reload
    console.log('Not installed. Reloading...');
    await page.reload({waitUntil: 'networkidle0'});
    await sleep(3000);
    var check2 = await page.evaluate(function() {
      return {
        installed: !!window.__postMessageTrackerInstalled__,
        addHooked: Window.prototype.addEventListener.toString().indexOf('native code') === -1
      };
    });
    console.log('  After reload: installed=' + check2.installed + ' addHooked=' + check2.addHooked);
  }

  await browser.disconnect();
  chromeProc.kill();
  await sleep(1000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
