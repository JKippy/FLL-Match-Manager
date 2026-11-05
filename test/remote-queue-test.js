// Remote read-only queue (#64). The queue server is a separate process bound to 127.0.0.1.
// It serves a public page and a JSON feed, and it never accepts a command for the main timer.
//   node test/remote-queue-test.js
'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const pw = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PIN = 'PinSECRET9182';
const HOST = 'queue.kippykiyay.com';
let failed = 0, passed = 0;
function check(name, ok, detail) {
  ok ? passed++ : failed++;
  let extra = '';
  if (detail !== undefined && !ok) {
    extra = '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400);
  }
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + extra);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

function httpReq(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function rawHttp(port, text, ms = 600) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    const done = () => { try { s.destroy(); } catch (e) {} resolve(buf); };
    s.on('connect', () => s.write(text));
    s.on('data', d => { buf += d.toString('utf8'); if (buf.length > 800) done(); });
    s.on('end', done);
    s.on('error', () => resolve(buf));
    setTimeout(done, ms);
  });
}

function onceLine(child, re, ms = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + re + ' got: ' + buf.slice(-300))), ms);
    const on = d => {
      buf += d.toString();
      if (re.test(buf)) { clearTimeout(t); child.stdout.off('data', on); child.stderr && child.stderr.off('data', on); resolve(buf); }
    };
    child.stdout.on('data', on);
    if (child.stderr) child.stderr.on('data', on);
  });
}

const FORBIDDEN_KEYS = ['pin', 'pinRequired', 'deviceId', 'displays', 'refs', 'keys', 'calls', 'nexus', 'sound', 'runId', 'abortId', 'abortAt', 'seq', 'lastAction', 'clients', 'ip', 'pref', 'cmd', 'authed', 'refKey', 'command', 'ready', 'used', 'confirm', 'callSeq', 'file', 'stored', 'event', 'source', 'config', 'key', 'breakFor', 'matchDuration', 'label', 'url', 'error', 'cues'];

function walkKeys(o, found) {
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) { found.push(k); walkKeys(o[k], found); }
}

function assertPublic(obj) {
  const keys = [];
  walkKeys(obj, keys);
  const bad = keys.filter(k => FORBIDDEN_KEYS.includes(k));
  const text = JSON.stringify(obj);
  assert.deepStrictEqual(bad, [], 'forbidden keys ' + bad.join(','));
  assert.ok(!/SECRET/i.test(text), text.slice(0, 240));
  assert.ok(!text.includes(PIN));
}

const sampleSchedule = () => ({
  teamNames: { '32778': 'Servo Stars', '27469': 'Gear Owls' },
  tableNames: { '1': 'Table 1', '2': 'Table 2', '3': 'Table 3', '4': 'Table 4' },
  matches: [
    { n: 1, time: Date.UTC(2026, 10, 14, 14, 30), teams: { '1': '32778', '2': '27469' }, practice: false, key: 'session-SECRET-KEY' },
    { n: 2, time: Date.UTC(2026, 10, 14, 14, 40), teams: { '3': '11111', '4': '22222' }, practice: false },
    { n: 3, time: Date.UTC(2026, 10, 14, 14, 50), teams: { '1': '33333', '2': '44444' }, practice: false },
    { n: 4, time: Date.UTC(2026, 10, 14, 15, 0), teams: { '5': '55555', '6': '66666' }, practice: false },
  ],
  event: { name: 'SECRET-EVENT', key: 'SECRET' },
  source: 'SECRET-SOURCE',
});

function poisonedState() {
  return {
    timer: {
      status: 'idle', kind: 'match', duration: 150000, startAt: null, remainingAtPause: null, breakUntil: null, lunch: false,
      label: 'SECRET-LABEL', lastAction: 'cmd-SECRET-ACTION', runId: 4, abortId: 9, abortAt: 1, seq: 3, breakFor: 1, matchDuration: 150000, ready: false,
    },
    match: { current: 0, live: null, actualStarts: { '1': 1700000000000 }, autoAdvance: true, endedAt: null },
    schedule: sampleSchedule(),
    display: { theme: 'nature', queueCount: 2, deviceId: 'DEVICE-SECRET' },
    displays: { 'DEVICE-SECRET': { vol: 0.2, name: 'Projector SECRET', view: 'main' } },
    layout: { pairs: [{ id: 'A', tables: ['1', '2'], note: 'SECRET-PAIR' }, { id: 'B', tables: ['3', '4'] }] },
    refs: { ready: { '0': { '1': 1 } }, calls: { '1': { at: 1, note: 'CALL-SECRET' } }, callSeq: 7, used: true, confirm: true, keys: { '1': 'REFKEY-SECRET' } },
    nexus: { url: 'https://example.invalid/NEXUS-SECRET', auto: false, error: 'SECRET-ERR' },
    sound: { master: 0.9, pack: 'nature', cues: { start: { vol: 1, file: { name: 'SOUND-SECRET.wav', stored: 'start-SOUND-SECRET.wav', type: 'audio/wav' } } } },
    pin: PIN,
  };
}

(async () => {
  const Q = require(path.join(ROOT, 'lib', 'queue-config'));
  const PQ = require(path.join(ROOT, 'lib', 'public-queue'));
  const QS = require(path.join(ROOT, 'lib', 'queue-server'));

  // ----- pure allowlist + hostname -----
  const pub = PQ.toPublicQueue(poisonedState(), 1700000000000);
  check('toPublicQueue drops every secret field', (() => { try { assertPublic(pub); return true; } catch (e) { return false; } })(), JSON.stringify(pub).slice(0, 300));
  check('toPublicQueue keeps the queue the screens show', pub.schedule.matches.length === 4 && pub.schedule.teamNames['32778'] === 'Servo Stars' && pub.display.queueCount === 2 && pub.layout.pairs[0].id === 'A' && pub.timer.status === 'idle' && pub.match.current === 0);
  check('toPublicQueue match objects are only n/time/teams/practice', Object.keys(pub.schedule.matches[0]).sort().join() === 'n,practice,teams,time');
  check('documented default hostname is queue.kippykiyay.com', Q.DEFAULT_QUEUE_HOSTNAME === HOST);
  check('QUEUE_HOSTNAME overrides the default', Q.displayedQueueUrl({ env: { QUEUE_HOSTNAME: 'queue.example.test' }, namedConfigText: 'hostname: ' + HOST, status: null }) === 'https://queue.example.test');
  check('named tunnel with no env uses the hostname from config, else the documented default', Q.displayedQueueUrl({ env: {}, namedConfigText: 'ingress:\n  - hostname: ' + HOST + '\n', status: null }) === 'https://' + HOST
    && Q.displayedQueueUrl({ env: {}, namedConfigText: 'tunnel: abc\ningress:\n  - service: http://127.0.0.1:8081\n', status: null }) === 'https://' + HOST);
  check('no named tunnel and no env means no public URL yet', Q.displayedQueueUrl({ env: {}, namedConfigText: '', status: null }) === '');
  check('quick tunnel URL is used only when no named hostname is configured', Q.displayedQueueUrl({ env: {}, namedConfigText: '', status: { mode: 'quick', url: 'https://random-words.trycloudflare.com' } }) === 'https://random-words.trycloudflare.com');
  check('quick-tunnel log line is picked up', Q.parseQuickTunnelUrl('INF |  https://random-words.trycloudflare.com  |') === 'https://random-words.trycloudflare.com');
  const hardcoded = ['server.js', 'queue-server.js', 'tunnel.js', 'public/control.html', 'queue/index.html'].filter(f => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('kippykiyay'));
  check('hostname is not hardcoded outside the documented default, sample config and README', hardcoded.length === 0, hardcoded);

  const sample = fs.readFileSync(path.join(ROOT, 'cloudflared', 'config.sample.yml'), 'utf8');
  check('sample cloudflared config routes only the example hostname to loopback and 404s the rest', /hostname:\s*queue\.kippykiyay\.com/.test(sample) && /service:\s*http:\/\/127\.0\.0\.1:8081/.test(sample) && /service:\s*http_status:404/.test(sample) && !/0\.0\.0\.0/.test(sample) && (sample.match(/hostname:/g) || []).length === 1);

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  check('README covers the one-time tunnel setup and the quick-tunnel fallback', ['cloudflared tunnel login', 'cloudflared tunnel create', 'tunnel route dns', 'QUEUE_HOSTNAME', 'queue.kippykiyay.com', 'trycloudflare', '127.0.0.1'].every(s => readme.includes(s)));

  // ----- queue server bind, feed, methods -----
  const requests = [];
  let upstreamMode = 'ok';
  let payloadMode = 'idle';
  function breakPayload(lunch) {
    const s = poisonedState();
    const until = Date.now() + 20 * 60000;
    Object.assign(s.timer, { status: 'running', kind: 'break', lunch: !!lunch, startAt: Date.now(), duration: 20 * 60000, breakUntil: until });
    return s;
  }
  const upstreamPayload = () => payloadMode === 'lunch' ? breakPayload(true) : payloadMode === 'break' ? breakPayload(false) : poisonedState();
  const upstream = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (upstreamMode === 'hang') return;
    const body = JSON.stringify(upstreamPayload());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  check('upstream test double listens on 127.0.0.1', upstream.address().address === '127.0.0.1');

  const q = QS.createQueueServer({
    port: 0,
    upstream: `http://127.0.0.1:${upPort}/internal/queue-snapshot`,
    pollMs: 200,
    timeoutMs: 300,
    host: '0.0.0.0',
  });
  const addr = await q.listen();
  check('queue server binds only to 127.0.0.1 (a request for 0.0.0.0 is ignored)', addr.address === '127.0.0.1', addr);
  await q.pulled();
  upstreamMode = 'hang';
  await sleep(450);
  const feedRes = await httpReq(addr.port, 'GET', '/queue.json');
  const feed = JSON.parse(feedRes.body);
  check('JSON feed is allowlisted even when upstream state contains PIN, device ids and control fields', (() => { try { assertPublic(feed); return feedRes.status === 200; } catch (e) { return false; } })(), feedRes.body.slice(0, 300));
  check('JSON feed still has the public schedule', feed.schedule.matches[0].teams['1'] === '32778' && feed.schedule.teamNames['32778'] === 'Servo Stars' && feed.display.queueCount === 2);
  check('feed top-level keys are exactly the allowlist', Object.keys(feed).sort().join() === 'display,layout,match,schedule,serverNow,timer,updatedAt', Object.keys(feed));

  const before = requests.length;
  const attacks = [];
  for (const method of ['POST', 'PUT', 'DELETE']) {
    attacks.push(await httpReq(addr.port, method, '/queue.json', JSON.stringify({ t: 'cmd', cmd: 'start', pin: PIN })));
    attacks.push(await httpReq(addr.port, method, '/control', JSON.stringify({ t: 'cmd', cmd: 'reset', pin: PIN })));
  }
  const gets = [];
  for (const p of ['/control', '/api', '/api/info', '/ws']) gets.push(await httpReq(addr.port, 'GET', p));
  gets.push(await httpReq(addr.port, 'GET', '/no-such-page'));
  const upgrade = await rawHttp(addr.port, 'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  check('POST/PUT/DELETE fail (404 or 405) and GET /control /api /ws and unknown paths are 404', attacks.every(r => r.status === 404 || r.status === 405) && gets.every(r => r.status === 404), { attacks: attacks.map(r => r.status), gets: gets.map(r => r.status) });
  check('websocket upgrade is rejected (not 101)', /^HTTP\/1\.[01] (404|405|400)/.test(upgrade) && !/^HTTP\/1\.[01] 101/.test(upgrade), upgrade.slice(0, 80));
  const forwarded = requests.slice(before).filter(r => r.method !== 'GET' || !r.url.startsWith('/internal/queue-snapshot'));
  check('none of those requests are relayed to the upstream', forwarded.length === 0, forwarded);

  const page = await httpReq(addr.port, 'GET', '/');
  check('GET / is the public queue page', page.status === 200 && /Last updated/.test(page.body) && !/\/control/.test(page.body) && !/cdn/.test(page.body));

  const updatedAt = feed.updatedAt;
  const tHang = Date.now();
  const staleFeed = JSON.parse((await httpReq(addr.port, 'GET', '/queue.json')).body);
  check('a hung upstream does not block the feed, which keeps the last snapshot', Date.now() - tHang < 800 && staleFeed.updatedAt === updatedAt && staleFeed.schedule.teamNames['32778'] === 'Servo Stars', { ms: Date.now() - tHang, updatedAt: staleFeed.updatedAt });

  // ----- browser: stale page + Head Ref URL / QR -----
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const remote = await phone.newPage();
  remote.on('pageerror', e => { console.log('PAGE ERROR', e.message); failed++; });
  await remote.goto(`http://127.0.0.1:${addr.port}/?poll=400`, { waitUntil: 'domcontentloaded' });
  await remote.waitForFunction(() => /Servo Stars/.test(document.body.innerText) && /Last updated \d{2}:\d{2}/.test(document.body.innerText), { timeout: 8000 });
  const beforeDrop = await remote.evaluate(() => ({
    text: document.body.innerText,
    updated: (document.getElementById('updated').textContent || '').trim(),
    at: document.getElementById('updated').getAttribute('data-at'),
    scroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
  }));
  const hm = ms => { const d = new Date(Number(ms)); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  check('remote page shows the queue and Last updated hh:mm on a phone', /next/i.test(beforeDrop.text) && /Match 1/.test(beforeDrop.text) && /Servo Stars/.test(beforeDrop.text) && beforeDrop.updated === 'Last updated ' + hm(beforeDrop.at) && beforeDrop.at === String(updatedAt) && beforeDrop.scroll, beforeDrop);

  upstreamMode = 'ok';
  payloadMode = 'break';
  await remote.waitForFunction(() => /field break/i.test(document.body.innerText) && /should be queued/i.test(document.body.innerText) && /Servo Stars/.test(document.body.innerText), { timeout: 8000 });
  payloadMode = 'lunch';
  await remote.waitForFunction(() => /on a break/i.test(document.body.innerText) && /do not need to queue/i.test(document.body.innerText), { timeout: 8000 });
  const onBreak = await remote.evaluate(() => document.body.innerText);
  check('remote queue during Lunch says on a break and does not call teams', /lunch/i.test(onBreak) && /on a break/i.test(onBreak) && /do not need to queue/i.test(onBreak) && !/should be queued/i.test(onBreak) && !/\bNext\b/.test(onBreak) && !/Servo Stars/.test(onBreak) && !/32778/.test(onBreak), onBreak.slice(0, 280));
  payloadMode = 'idle';
  await remote.waitForFunction(() => /Servo Stars/.test(document.body.innerText) && /should be queued|next/i.test(document.body.innerText) && !/on a break/i.test(document.body.innerText), { timeout: 8000 });
  const restored = await remote.evaluate(() => ({
    updated: (document.getElementById('updated').textContent || '').trim(),
    at: document.getElementById('updated').getAttribute('data-at'),
  }));
  beforeDrop.updated = restored.updated;
  beforeDrop.at = restored.at;

  upstreamMode = 'hang';
  await sleep(900);
  const whileStale = await remote.evaluate(() => ({
    updated: (document.getElementById('updated').textContent || '').trim(),
    at: document.getElementById('updated').getAttribute('data-at'),
    text: document.body.innerText,
  }));
  check('while the upstream is stale the page keeps the last queue and the same Last updated time', whileStale.updated === beforeDrop.updated && whileStale.at === beforeDrop.at && /Servo Stars/.test(whileStale.text) && /Match 1/.test(whileStale.text));

  await new Promise(r => q.server.close(r));
  await sleep(1000);
  const afterDrop = await remote.evaluate(() => ({
    updated: (document.getElementById('updated').textContent || '').trim(),
    at: document.getElementById('updated').getAttribute('data-at'),
    text: document.body.innerText,
  }));
  check('when the connection drops the page keeps the last queue and Last updated hh:mm', afterDrop.updated === beforeDrop.updated && afterDrop.at === beforeDrop.at && /Servo Stars/.test(afterDrop.text) && /Match 1/.test(afterDrop.text) && /^Last updated \d{2}:\d{2}$/.test(afterDrop.updated));
  await phone.close();

  // ----- real main server: snapshot, isolation, Head Ref QR, tunnel drop -----
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-queue-'));
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(poisonedState()));
  const mainPort = await freePort();
  const urlFile = path.join(DATA, 'queue-public.json');
  const main = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(mainPort), '--pin', PIN, '--data', DATA], {
    env: Object.assign({}, process.env, { QUEUE_URL_FILE: urlFile, QUEUE_URL_POLL_MS: '200', QUEUE_HOSTNAME: '', CLOUDFLARED_CONFIG: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await onceLine(main, /FLL Synced|Head Ref/);
  const snap = JSON.parse((await httpReq(mainPort, 'GET', '/internal/queue-snapshot')).body);
  check('main snapshot is loopback-only public data (no PIN, device id or control fields)', (() => { try { assertPublic(snap); return snap.schedule.teamNames['32778'] === 'Servo Stars'; } catch (e) { return false; } })(), JSON.stringify(snap).slice(0, 240));

  const qPort = await freePort();
  const queueProc = spawn(process.execPath, [path.join(ROOT, 'queue-server.js')], {
    env: Object.assign({}, process.env, {
      QUEUE_PORT: String(qPort), QUEUE_MAIN_PORT: String(mainPort), QUEUE_POLL_MS: '200', QUEUE_TIMEOUT_MS: '400', QUEUE_HOST: '0.0.0.0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await onceLine(queueProc, /Public queue \(loopback only\)/);
  let live = null;
  for (let i = 0; i < 25; i++) {
    live = JSON.parse((await httpReq(qPort, 'GET', '/queue.json')).body);
    if (live.schedule && live.schedule.matches && live.schedule.matches.length === 4) break;
    await sleep(80);
  }
  check('live queue feed from the main server has no secrets', (() => { try { assertPublic(live); return live.schedule.matches.length === 4; } catch (e) { return false; } })(), JSON.stringify(live).slice(0, 240));

  // Field timing keeps running while the queue server is stopped and then killed.
  const ws = new WebSocket(`ws://127.0.0.1:${mainPort}/ws`);
  const frames = [];
  ws.addEventListener('message', ev => { try { frames.push(JSON.parse(ev.data)); } catch (e) {} });
  await new Promise((res, rej) => { ws.addEventListener('open', res); setTimeout(() => rej(new Error('ws')), 3000); });
  const send = obj => ws.send(JSON.stringify(obj));
  const waitAck = async id => {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const hit = frames.find(m => m.t === 'ack' && m.id === id);
      if (hit) return hit;
      await sleep(30);
    }
    throw new Error('no ack ' + id);
  };
  send({ t: 'hello', role: 'control', pin: PIN, name: 'test' });
  await sleep(200);
  send({ t: 'cmd', cmd: 'set', duration: 8000, id: 'set1', force: true });
  const setAck = await waitAck('set1');
  send({ t: 'cmd', cmd: 'start', id: 'go1', force: true });
  const goAck = await waitAck('go1');
  check('main timer started', setAck.ok && goAck.ok, { setAck, goAck });
  const running = JSON.parse((await httpReq(mainPort, 'GET', '/api/time')).body);
  check('timer is running', running.status === 'running' && running.startAt > 0, running.status);

  const attackBody = JSON.stringify({ t: 'cmd', cmd: 'reset', pin: PIN });
  await httpReq(qPort, 'POST', '/api/cmd', attackBody);
  await httpReq(qPort, 'POST', '/control', attackBody);
  await rawHttp(qPort, 'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  process.kill(queueProc.pid, 'SIGSTOP');
  const t0 = Date.now();
  const duringHang = JSON.parse((await httpReq(mainPort, 'GET', '/api/time')).body);
  const hangMs = Date.now() - t0;
  check('hanging the queue server leaves the main timer running and responsive', hangMs < 1000 && duringHang.status === 'running' && duringHang.startAt === running.startAt, { hangMs, status: duringHang.status, startAt: duringHang.startAt });
  process.kill(queueProc.pid, 'SIGKILL');
  await sleep(300);
  const t1 = Date.now();
  const afterKill = JSON.parse((await httpReq(mainPort, 'GET', '/api/time')).body);
  check('killing the queue server leaves field timing unaffected', Date.now() - t1 < 1000 && afterKill.status === 'running' && afterKill.startAt === running.startAt, afterKill.status);

  // Quick tunnel URL is picked up from cloudflared's log. Dropping that process does not touch the timer.
  const fakeBin = path.join(DATA, 'fake-cloudflared.js');
  fs.writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("Your quick Tunnel has been created! Visit it at");\nconsole.log("https://practice-queue.trycloudflare.com");\nsetInterval(() => {}, 1000);\n');
  fs.chmodSync(fakeBin, 0o755);
  const tun = spawn(process.execPath, [path.join(ROOT, 'tunnel.js')], {
    env: Object.assign({}, process.env, {
      CLOUDFLARED_BIN: fakeBin,
      QUEUE_URL_FILE: urlFile,
      QUEUE_PORT: '8099',
      CLOUDFLARED_CONFIG: '',
      QUEUE_HOSTNAME: '',
    }),
    cwd: DATA,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tunUrl = '';
  for (let i = 0; i < 40 && !tunUrl; i++) {
    await sleep(50);
    try { tunUrl = JSON.parse(fs.readFileSync(urlFile, 'utf8')).url || ''; } catch (e) {}
  }
  check('quick tunnel fallback picks up the trycloudflare URL', tunUrl === 'https://practice-queue.trycloudflare.com', tunUrl);

  const lap = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const control = await lap.newPage();
  control.on('pageerror', e => { console.log('PAGE ERROR', e.message); failed++; });
  await control.addInitScript(pin => { try { localStorage.setItem('fll.pin', pin); } catch (e) {} }, PIN);
  await control.goto(`http://127.0.0.1:${mainPort}/control`);
  await control.waitForFunction(() => window.FLL && FLL.authed && FLL.config, { timeout: 8000 });
  await control.waitForFunction(() => /practice-queue\.trycloudflare\.com/.test(document.body.innerText), { timeout: 8000 });
  const qrOk = await control.evaluate(() => {
    const svg = document.querySelector('#queueQr svg');
    const link = document.querySelector('#queueUrl a');
    const href = link ? link.href.replace(/\/$/, '') : '';
    return !!(svg && href === 'https://practice-queue.trycloudflare.com' && svg.querySelector('path, rect'));
  });
  check('Head Ref page shows the public queue URL and a local QR code', qrOk);
  const narrow = await control.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('Head Ref queue link does not widen the page', narrow);
  tun.kill('SIGTERM');
  await sleep(200);

  const still = JSON.parse((await httpReq(mainPort, 'GET', '/api/time')).body);
  check('a dropped tunnel does not change the running field timer', still.status === 'running' && still.startAt === running.startAt, still.status);

  // Named hostname from QUEUE_HOSTNAME, not the quick URL, once it is configured.
  main.kill('SIGTERM');
  await sleep(200);
  const main2Port = await freePort();
  const main2 = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(main2Port), '--pin', PIN, '--data', DATA, '--queue-hostname', 'queue.example.test'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await onceLine(main2, /FLL Synced|Head Ref/);
  const info = JSON.parse((await httpReq(main2Port, 'GET', '/api/info')).body);
  check('/api/info exposes the configured public queue URL and not the main control URLs as that URL', info.queueUrl === 'https://queue.example.test');

  ws.close();
  await browser.close();
  upstream.close();
  main2.kill('SIGTERM');
  try { queueProc.kill('SIGKILL'); } catch (e) {}
  try { tun.kill('SIGKILL'); } catch (e) {}

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
