/*
 * test-cdp-raw.js — Raw CDP test without puppeteer
 * Tests content script injection by talking CDP directly via WebSocket
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var cp = require('child_process');
var http = require('http');
var WebSocket = require('ws');

var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var PORT = 9222;
var EXT_PATH = path.resolve(__dirname, '..', '..');

async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function cdpGet(urlPath) {
  return new Promise(function(resolve, reject) {
    http.get('http://localhost:' + PORT + urlPath, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(JSON.parse(data)); });
    }).on('error', reject);
  });
}

function cdpConnect(wsUrl) {
  return new Promise(function(resolve) {
    var ws = new WebSocket(wsUrl);
    var id = 1;
    var pending = {};
    var events = [];

    ws.on('message', function(msg) {
      var data = JSON.parse(msg);
      if (data.id && pending[data.id]) {
        pending[data.id](data);
        delete pending[data.id];
      }
      if (data.method) {
        events.push(data);
      }
    });

    ws.on('open', function() {
      resolve({
        send: function(method, params) {
          return new Promise(function(resolve) {
            var myId = id++;
            pending[myId] = resolve;
            ws.send(JSON.stringify({id: myId, method: method, params: params || {}}));
          });
        },
        events: events,
        close: function() { ws.close(); }
      });
    });
  });
}

async function main() {
  // Prepare clean extension copy
  var extPath = path.join(os.tmpdir(), 'pmtracker-ext-clean');
  if (fs.existsSync(extPath)) fs.rmSync(extPath, {recursive: true, force: true});
  fs.mkdirSync(extPath, {recursive: true});
  fs.mkdirSync(path.join(extPath, 'icons'), {recursive: true});
  ['manifest.json','background.js','instrumentation.js','content_script.js','analyzer.js',
   'popup.js','popup.html','popup.css','options.html','options.js'].forEach(function(f) {
    var src = path.join(EXT_PATH, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extPath, f));
  });
  ['icon16.png','icon48.png','icon128.png'].forEach(function(f) {
    var src = path.join(EXT_PATH, 'icons', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(extPath, 'icons', f));
  });

  var tmpProfile = path.join(os.tmpdir(), 'pmtracker-cdptest-' + Date.now());

  console.log('Extension: ' + extPath);
  console.log('Launching Chrome...');

  var chromeProc = cp.spawn(CHROME, [
    '--user-data-dir=' + tmpProfile,
    '--no-first-run',
    '--disable-extensions-except=' + extPath,
    '--load-extension=' + extPath,
    '--remote-debugging-port=' + PORT,
    '--headless=new',
    'about:blank'
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  // Capture stderr for Chrome errors
  var chromeErrors = '';
  chromeProc.stderr.on('data', function(d) { chromeErrors += d.toString(); });

  await sleep(5000);

  // Get targets
  var targets = await cdpGet('/json/list');
  console.log('\nTargets:');
  targets.forEach(function(t) { console.log('  ' + t.type + ': ' + t.url); });

  // Find page target
  var pageTarget = targets.find(function(t) { return t.type === 'page'; });
  if (!pageTarget) { console.log('No page target!'); process.exit(1); }

  // Connect via WebSocket
  var cdp = await cdpConnect(pageTarget.webSocketDebuggerUrl);

  // Enable domains
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // Collect console messages
  var consoleMessages = [];
  var logEntries = [];

  // Navigate to test page
  console.log('\nNavigating to http://localhost:9100/...');
  await cdp.send('Page.navigate', {url: 'http://localhost:9100/'});
  await sleep(5000);

  // Check all events for console/log messages
  cdp.events.forEach(function(ev) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      var args = ev.params.args.map(function(a) { return a.value || a.description || ''; }).join(' ');
      consoleMessages.push(args);
    }
    if (ev.method === 'Log.entryAdded') {
      logEntries.push(ev.params.entry.text || ev.params.entry.url || '');
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      console.log('  EXCEPTION: ' + JSON.stringify(ev.params.exceptionDetails.text));
    }
  });

  console.log('\nConsole messages (' + consoleMessages.length + '):');
  consoleMessages.forEach(function(m) { console.log('  > ' + m); });

  console.log('\nLog entries (' + logEntries.length + '):');
  logEntries.forEach(function(m) { console.log('  > ' + m); });

  // Evaluate in page context (should be MAIN world)
  var evalResult = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({installed: !!window.__postMessageTrackerInstalled__, addStr: Window.prototype.addEventListener.toString().substring(0,60), postStr: window.postMessage.toString().substring(0,60)})',
    returnByValue: true
  });
  console.log('\nRuntime.evaluate result: ' + (evalResult.result ? evalResult.result.value : JSON.stringify(evalResult)));

  // List all execution contexts (there should be MAIN + ISOLATED)
  var contexts = cdp.events.filter(function(e) { return e.method === 'Runtime.executionContextCreated'; });
  console.log('\nExecution contexts (' + contexts.length + '):');
  contexts.forEach(function(c) {
    var ctx = c.params.context;
    console.log('  id=' + ctx.id + ' name="' + ctx.name + '" origin=' + ctx.origin + ' auxData=' + JSON.stringify(ctx.auxData));
  });

  // Check extension errors via chrome://extensions
  // Try accessing the service worker
  var swTarget = targets.find(function(t) {
    return t.url.indexOf('admccjkmockfdflocgggjfgdacdodkdf') !== -1;
  });
  if (swTarget) {
    console.log('\nService worker target: ' + swTarget.url);
    var swCdp = await cdpConnect(swTarget.webSocketDebuggerUrl);
    await swCdp.send('Runtime.enable');
    await sleep(1000);

    // Check SW console
    var swConsole = swCdp.events.filter(function(e) { return e.method === 'Runtime.consoleAPICalled'; });
    console.log('SW console (' + swConsole.length + '):');
    swConsole.forEach(function(ev) {
      var args = ev.params.args.map(function(a) { return a.value || a.description || ''; }).join(' ');
      console.log('  > ' + args);
    });

    var swExceptions = swCdp.events.filter(function(e) { return e.method === 'Runtime.exceptionThrown'; });
    console.log('SW exceptions (' + swExceptions.length + '):');
    swExceptions.forEach(function(ev) {
      console.log('  > ' + JSON.stringify(ev.params.exceptionDetails));
    });

    swCdp.close();
  }

  // Print Chrome stderr errors
  if (chromeErrors.length > 0) {
    var relevantErrors = chromeErrors.split('\n').filter(function(l) {
      return l.indexOf('extension') !== -1 || l.indexOf('Extension') !== -1 ||
             l.indexOf('content_script') !== -1 || l.indexOf('ERROR') !== -1;
    });
    if (relevantErrors.length > 0) {
      console.log('\nChrome errors (extension-related):');
      relevantErrors.forEach(function(l) { console.log('  ' + l.trim()); });
    }
  }

  cdp.close();
  chromeProc.kill();
  await sleep(1000);
  try { fs.rmSync(tmpProfile, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
