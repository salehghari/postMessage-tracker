/*
 * test-clean.js — Clean-slate content script injection test
 * Uses unique port, fresh profile, fresh extension copy
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var puppeteer = require('puppeteer-core');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var EXT_SRC = path.resolve(__dirname, '..', '..');
var PORT = 9444 + Math.floor(Math.random() * 100);

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function main() {
  // Unique extension directory per run
  var ts = Date.now();
  var extDir = path.join(os.tmpdir(), 'pmtracker-clean-' + ts);
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

  var profile = path.join(os.tmpdir(), 'pmtracker-profile-' + ts);

  console.log('Extension dir: ' + extDir);
  console.log('Profile dir: ' + profile);
  console.log('CDP port: ' + PORT);
  console.log('Files in ext dir: ' + fs.readdirSync(extDir).join(', '));

  var chromeProc = cp.spawn(CHROME, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--disable-extensions-except=' + extDir,
    '--load-extension=' + extDir,
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  var stderr = '';
  chromeProc.stderr.on('data', function(d) { stderr += d; });

  await sleep(6000);

  // Check targets
  var targets;
  try {
    targets = await new Promise(function(resolve, reject) {
      http.get('http://localhost:' + PORT + '/json/list', function(res) {
        var d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { resolve(JSON.parse(d)); });
      }).on('error', reject);
    });
  } catch (e) {
    console.log('CDP connect failed: ' + e.message);
    console.log('Chrome stderr: ' + stderr.substring(0, 500));
    chromeProc.kill();
    return;
  }

  console.log('\nCDP targets (' + targets.length + '):');
  targets.forEach(function(t) { console.log('  ' + t.type + ': ' + t.url); });

  // Check extension ID
  var extTargets = targets.filter(function(t) { return t.url.indexOf('chrome-extension://') === 0; });
  console.log('\nExtension targets: ' + extTargets.length);
  extTargets.forEach(function(t) {
    var id = t.url.split('/')[2];
    console.log('  ID=' + id + ' url=' + t.url);
  });

  // Connect and navigate
  var browser = await puppeteer.connect({browserURL: 'http://localhost:' + PORT});
  var pages = await browser.pages();
  var page = pages[0] || await browser.newPage();

  // Listen for console messages
  page.on('console', function(msg) {
    console.log('  [page console] ' + msg.text());
  });

  await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
  await sleep(3000);

  // Check MAIN world
  var check = await page.evaluate(function() {
    return {
      installed: !!window.__postMessageTrackerInstalled__,
      addNative: Window.prototype.addEventListener.toString().indexOf('native code') !== -1,
      postNative: window.postMessage.toString().indexOf('native code') !== -1,
      allProps: Object.getOwnPropertyNames(window).filter(function(p) {
        return p.indexOf('__postMessage') === 0 || p.indexOf('__pm') === 0;
      })
    };
  });

  console.log('\nContent script check:');
  console.log('  installed: ' + check.installed);
  console.log('  addEventListener native: ' + check.addNative);
  console.log('  postMessage native: ' + check.postNative);
  console.log('  tracker props: ' + JSON.stringify(check.allProps));

  // Check if popup.html exists
  var extId = extTargets.length > 0 ? extTargets[0].url.split('/')[2] : null;
  if (extId) {
    try {
      var popPage = await browser.newPage();
      await popPage.goto('chrome-extension://' + extId + '/popup.html', {waitUntil: 'load', timeout: 5000});
      console.log('\nPopup loaded: ' + popPage.url());
      var popContent = await popPage.evaluate(function() { return document.title; });
      console.log('  Title: ' + popContent);
      await popPage.close();
    } catch (e) {
      console.log('\nPopup error: ' + e.message.substring(0, 80));
    }
  }

  // Check Chrome version
  var verPage = await browser.newPage();
  await verPage.goto('chrome://version');
  await sleep(1000);
  var chromeVer = await verPage.evaluate(function() {
    var rows = document.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].textContent.indexOf('Google Chrome') !== -1) {
        return rows[i].textContent.trim();
      }
    }
    var el = document.getElementById('version');
    return el ? el.textContent : 'unknown';
  });
  console.log('\nChrome: ' + chromeVer);

  var cmdLine = await verPage.evaluate(function() {
    var el = document.getElementById('command_line');
    return el ? el.textContent : '';
  });
  // Show extension-related args
  var args = cmdLine.split(' ').filter(function(a) {
    return a.indexOf('extension') !== -1 || a.indexOf('load') !== -1;
  });
  console.log('Extension args: ' + args.join(' '));
  await verPage.close();

  // Print relevant Chrome errors
  var extErrors = stderr.split('\n').filter(function(l) {
    return l.indexOf('extension') !== -1 || l.indexOf('Extension') !== -1 ||
           l.indexOf('content') !== -1 || l.indexOf('script') !== -1;
  });
  if (extErrors.length > 0) {
    console.log('\nChrome extension errors:');
    extErrors.forEach(function(l) { console.log('  ' + l.trim()); });
  }

  await browser.disconnect();
  chromeProc.kill();
  await sleep(1000);
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch(e) {}
  // Don't delete ext dir to inspect after
  console.log('\nExtension dir preserved: ' + extDir);
}

main().catch(function(e) { console.error(e); process.exit(1); });
