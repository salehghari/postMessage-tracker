/*
 * test-puppeteer.js — Quick extension load test using puppeteer-core
 */
var path = require('path');
var fs = require('fs');
var os = require('os');
var puppeteer = require('puppeteer-core');

var EXT_PATH = path.join(os.tmpdir(), 'pmtracker-ext-clean');
var CHROME = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
var SCREENSHOTS = path.join(__dirname, 'screenshots');

if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, {recursive: true});

async function main() {
  console.log('Extension: ' + EXT_PATH);
  console.log('Chrome: ' + CHROME);

  var tmpProfile = path.join(os.tmpdir(), 'pmtracker-pup-' + Date.now());

  var browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME,
    userDataDir: tmpProfile,
    args: [
      '--disable-extensions-except=' + EXT_PATH,
      '--load-extension=' + EXT_PATH,
      '--no-first-run',
      '--disable-default-apps'
    ],
    ignoreDefaultArgs: ['--disable-extensions']
  });

  var pages = await browser.pages();
  var page = pages[0] || await browser.newPage();

  // Check chrome://version for args
  await page.goto('chrome://version');
  await new Promise(function(r) { setTimeout(r, 1000); });
  var cmdLine = await page.evaluate(function() {
    var el = document.getElementById('command_line');
    return el ? el.textContent : 'not found';
  });
  console.log('CMD: ' + cmdLine.substring(cmdLine.indexOf('--load-extension'), cmdLine.indexOf('--load-extension') + 100));

  // Check chrome://extensions
  await page.goto('chrome://extensions');
  await new Promise(function(r) { setTimeout(r, 2000); });
  await page.screenshot({path: path.join(SCREENSHOTS, 'pup-00-extensions.png'), fullPage: true});

  // Navigate to test page
  await page.goto('http://localhost:9100/', {waitUntil: 'networkidle0'});
  await new Promise(function(r) { setTimeout(r, 2000); });

  // Check hooks from MAIN world via script tag
  var hookCheck = await page.evaluate(function() {
    return new Promise(function(resolve) {
      var id = '__pup_' + Date.now();
      window.addEventListener('message', function handler(ev) {
        if (ev.data && ev.data.__id === id) {
          window.removeEventListener('message', handler);
          resolve(ev.data.result);
        }
      });
      var s = document.createElement('script');
      s.textContent = '(function(){' +
        'var r={};' +
        'r.installed = !!window.__postMessageTrackerInstalled__;' +
        'r.addHooked = Window.prototype.addEventListener.toString().indexOf("native code") === -1;' +
        'r.postHooked = window.postMessage.toString().indexOf("native code") === -1;' +
        'r.removeHooked = Window.prototype.removeEventListener.toString().indexOf("native code") === -1;' +
        'window.postMessage({__id:"' + id + '",result:r},"*");' +
        '})()';
      document.documentElement.appendChild(s);
      s.remove();
      setTimeout(function() { resolve({timeout: true}); }, 3000);
    });
  });
  console.log('Hook check:', JSON.stringify(hookCheck));

  await page.screenshot({path: path.join(SCREENSHOTS, 'pup-01-test-page.png'), fullPage: true});

  // Try opening popup if extension is loaded
  var targets = browser.targets();
  var extTarget = targets.find(function(t) {
    return t.url().startsWith('chrome-extension://');
  });
  if (extTarget) {
    console.log('Extension target found: ' + extTarget.url());
    var extId = extTarget.url().split('/')[2];
    console.log('Extension ID: ' + extId);

    var popupPage = await browser.newPage();
    await popupPage.goto('chrome-extension://' + extId + '/popup.html');
    await new Promise(function(r) { setTimeout(r, 2000); });
    await popupPage.screenshot({path: path.join(SCREENSHOTS, 'pup-02-popup.png')});
    await popupPage.close();
  } else {
    console.log('No extension target found. Targets:');
    targets.forEach(function(t) { console.log('  ' + t.type() + ': ' + t.url()); });
  }

  await browser.close();
  try { fs.rmSync(tmpProfile, {recursive: true, force: true}); } catch(e) {}
}

main().catch(function(e) { console.error(e); process.exit(1); });
