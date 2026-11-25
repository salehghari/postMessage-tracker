/*
 * server.js — Dual-port HTTP server for browser testing
 * Port 9100: main test page (same-origin)
 * Port 9101: cross-origin iframe page
 *
 * Usage: node tests/browser/server.js
 * Stop:  Ctrl+C
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var DIR = __dirname;

var MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json'
};

function serve(req, res) {
  var url = req.url === '/' ? '/test-page-main.html' : req.url;
  url = url.split('?')[0];

  var filePath = path.join(DIR, url);
  var ext = path.extname(filePath);
  var contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found: ' + url);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

var server1 = http.createServer(serve);
var server2 = http.createServer(serve);

server1.listen(9100, function() {
  console.log('Main page:         http://localhost:9100/');
  console.log('  (same-origin iframe also served from 9100)');
});

server2.listen(9101, function() {
  console.log('Cross-origin page: http://localhost:9101/');
  console.log('  (cross-origin iframe served from 9101)');
  console.log('\nReady. Load extension and navigate to http://localhost:9100/');
});
