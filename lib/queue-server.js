// Read-only queue HTTP server. It listens on 127.0.0.1 only and never forwards a
// request to the match timer. A background poll GETs one fixed loopback URL.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toPublicQueue } = require('./public-queue');

const PAGE = path.join(__dirname, '..', 'queue', 'index.html');
const VENDOR_JS = {
  '/vendor/qrcode.js': path.join(__dirname, '..', 'public', 'vendor', 'qrcode.js'),
  '/vendor/nexus-qr.js': path.join(__dirname, '..', 'public', 'vendor', 'nexus-qr.js'),
};

function loopbackUpstream(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('Bad queue upstream URL'); }
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'http:' || (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1')) {
    throw new Error('Queue upstream must be http://127.0.0.1 (the queue server cannot call out)');
  }
  return u.href;
}

function pageCSP(html) {
  const hashes = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!/\ssrc\s*=/i.test(m[1] || '') && m[2].length) hashes.push("'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'");
  }
  return [
    "default-src 'none'",
    "script-src 'self' " + (hashes.join(' ') || "'none'"),
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function createQueueServer(opts) {
  opts = opts || {};
  const port = opts.port || 0;
  const timeoutMs = Math.max(100, opts.timeoutMs || 1000);
  const pollMs = Math.max(200, opts.pollMs || 2000);
  const upstream = opts.upstream ? loopbackUpstream(opts.upstream) : '';
  const html = fs.readFileSync(PAGE);
  const vendor = {};
  for (const [urlPath, file] of Object.entries(VENDOR_JS)) vendor[urlPath] = fs.readFileSync(file);
  const csp = pageCSP(html.toString('utf8'));
  let snapshot = toPublicQueue({}, Date.now());
  snapshot.updatedAt = null;
  let pulling = false;
  let pulledOnce = false;
  let resolvePulled = () => {};
  const pulledPromise = new Promise(r => { resolvePulled = r; });
  let pollTimer = null;

  async function pull() {
    if (!upstream || pulling) return;
    pulling = true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(upstream, { signal: ac.signal, redirect: 'error', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 2000000) { try { if (res.body) res.body.cancel(); } catch (e) {} return; }
      const text = await res.text();
      if (text.length > 2000000) return;
      const body = JSON.parse(text);
      const pub = toPublicQueue(body, Date.now());
      pub.updatedAt = Date.now();
      snapshot = pub;
      if (!pulledOnce) { pulledOnce = true; resolvePulled(); }
    } catch (e) {
      // Keep the last good snapshot. A slow or dead timer must not blank the page.
    } finally {
      clearTimeout(timer);
      pulling = false;
    }
  }

  function send(res, code, headers, body, method) {
    res.writeHead(code, headers);
    res.end(method === 'HEAD' ? undefined : body);
  }

  const server = http.createServer((req, res) => {
    try { req.resume(); } catch (e) {}
    let u;
    try { u = new URL(req.url || '/', 'http://127.0.0.1'); }
    catch (e) { return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad request', req.method); }
    const known = u.pathname === '/' || u.pathname === '/queue.json' || Object.prototype.hasOwnProperty.call(vendor, u.pathname);
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      const code = known ? 405 : 404;
      return send(res, code, { 'Content-Type': 'text/plain', 'Allow': 'GET, HEAD', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, known ? 'Method not allowed' : 'Not found', method);
    }
    if (u.pathname === '/queue.json') {
      return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, JSON.stringify(snapshot), method);
    }
    if (vendor[u.pathname]) {
      return send(res, 200, {
        'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      }, vendor[u.pathname], method);
    }
    if (u.pathname === '/') {
      return send(res, 200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer',
      }, html, method);
    }
    send(res, 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, 'Not found', method);
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    try { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nNot found'); }
    catch (e) { try { socket.destroy(); } catch (e2) {} }
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) {} });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;

  function listen() {
    return new Promise((resolve, reject) => {
      const onErr = e => reject(e);
      server.once('error', onErr);
      // Always loopback. A QUEUE_HOST of 0.0.0.0 must not publish the timer's network.
      server.listen({ port, host: '127.0.0.1' }, () => {
        server.off('error', onErr);
        pull();
        pollTimer = setInterval(pull, pollMs);
        if (pollTimer.unref) pollTimer.unref();
        resolve(server.address());
      });
    });
  }

  return { server, listen, pull, pulled: () => pulledPromise };
}

module.exports = { createQueueServer, loopbackUpstream };
