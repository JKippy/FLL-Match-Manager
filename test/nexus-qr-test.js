// Nexus QR on the audience screens (#92).
// The rankings URL and the corner link are display settings (not the Nexus schedule fetch).
//   node test/nexus-qr-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const pw = require('playwright-core');
const jsQR = require('jsqr');
const PQ = require('../lib/public-queue');

const ROOT = path.join(__dirname, '..');
const PIN = '4321';
const SAMPLE = path.join(ROOT, 'public', 'sample-schedule-6tables.csv');
const QR = PQ.DEFAULT_QR_URL;
const CORNER = PQ.DEFAULT_CORNER_LINK;
const LABEL = 'Scan for rankings and score breakdowns';
const SHOTS = process.env.QR_SHOTS || path.join(os.tmpdir(), 'fll-qr-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
let failed = 0, passed = 0;
function check(name, ok, detail) {
  ok ? passed++ : failed++;
  let extra = '';
  if (detail !== undefined && !ok) extra = '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + extra);
}
function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('timeout')));
  });
}

function emojiHits(file) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const hits = [];
  s.split('\n').forEach((line, i) => {
    if (/[\p{Extended_Pictographic}\uFE0F]/u.test(line)) hits.push((i + 1) + ': ' + line.trim().slice(0, 100));
  });
  return hits;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of ['public/display.html', 'queue/index.html']) {
    const hits = emojiHits(f);
    check('no emoji in ' + f, hits.length === 0, hits);
  }

  const poisoned = {
    timer: { status: 'idle', kind: 'match', duration: 150000, label: 'SECRET-LABEL', runId: 1 },
    match: { current: 0, live: null, actualStarts: {} },
    schedule: null,
    display: { theme: 'nature', queueCount: 2, deviceId: 'DEVICE-SECRET', secret: 'SECRET', qrUrl: 'https://example.test/rank?q="a"<b>', cornerLink: 'corner "x" <y>' },
    nexus: { url: 'https://example.invalid/NEXUS-SECRET', auto: false, error: 'SECRET-ERR' },
    pin: PIN,
  };
  const pub = PQ.toPublicQueue(poisoned, 1700000000000);
  check('public feed display keys are exactly queueCount, theme, qrUrl, cornerLink', Object.keys(pub.display).sort().join() === 'cornerLink,qrUrl,queueCount,theme', Object.keys(pub.display));
  check('public feed keeps the two new strings and drops every other display field', pub.display.qrUrl === poisoned.display.qrUrl && pub.display.cornerLink === poisoned.display.cornerLink && pub.display.queueCount === 2 && !JSON.stringify(pub).includes('SECRET') && !JSON.stringify(pub).includes('DEVICE'));
  check('public feed top-level keys are unchanged', Object.keys(pub).sort().join() === 'display,layout,match,schedule,serverNow,timer');
  const missing = PQ.toPublicQueue({ display: { theme: 'plain', queueCount: 4 }, nexus: { url: 'https://example.invalid/NEXUS-SECRET' } }, 1);
  check('a feed with no QR fields gets the defaults and still hides nexus', missing.display.qrUrl === QR && missing.display.cornerLink === CORNER && missing.display.theme === 'plain' && missing.display.queueCount === 4 && !JSON.stringify(missing).includes('NEXUS-SECRET'));
  const blank = PQ.toPublicQueue({ display: { qrUrl: '', cornerLink: '' } }, 1);
  check('a blank QR URL and corner link stay blank in the feed', blank.display.qrUrl === '' && blank.display.cornerLink === '');

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-qr-'));
  const STATE = path.join(DATA, 'state.json');
  fs.writeFileSync(STATE, JSON.stringify({
    timer: { status: 'idle', kind: 'match', duration: 150000, startAt: null, remainingAtPause: null },
    display: { theme: 'plain', queueCount: 3 },
    nexus: { url: 'https://fll.nexus/fll/mm26', auto: false, lastFetch: null, error: null },
  }));
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  function start() {
    const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
    srv.err = '';
    srv.stderr.on('data', d => { srv.err += d; });
    srv.out = '';
    srv.stdout.on('data', d => { srv.out += d; });
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('server start timeout ' + srv.err.slice(-200))), 8000);
      srv.stdout.on('data', d => { if (/Control/.test(d.toString())) { clearTimeout(t); res(srv); } });
    });
  }
  let srv = await start();
  const stop = async () => {
    if (!srv || srv.exitCode != null) return;
    const done = new Promise(r => srv.once('exit', r));
    srv.kill('SIGTERM');
    await done;
  };

  const QS = require(path.join(ROOT, 'lib', 'queue-server'));
  const q = QS.createQueueServer({ port: 0, upstream: `http://127.0.0.1:${PORT}/internal/queue-snapshot`, pollMs: 200, timeoutMs: 400 });
  const qAddr = await q.listen();
  await q.pulled();

  const chrome = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  let firefox = null;
  const pages = [];
  function track(page) {
    const errors = [];
    const urls = [];
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); failed++; });
    page.on('request', r => urls.push(r.url()));
    page.on('dialog', d => d.accept());
    pages.push({ page, errors, urls });
    return { errors, urls };
  }
  const externalOf = urls => urls.filter(u => { try { const h = new URL(u).hostname; return h !== '127.0.0.1' && h !== 'localhost'; } catch (e) { return true; } });
  const waitFor = async (fn, ms = 8000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await Promise.resolve().then(fn).catch(() => false)) return true; await sleep(80); }
    return false;
  };

  try {
    const snap = JSON.parse((await httpGet(PORT, '/internal/queue-snapshot')).body);
    const saved0 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    check('old state.json has no QR fields and keeps the Nexus fetch URL', saved0.display.qrUrl === undefined && saved0.display.cornerLink === undefined && saved0.display.theme === 'plain' && saved0.nexus.url === 'https://fll.nexus/fll/mm26');
    check('that file still loads: the server fills the QR defaults and does not publish nexus', snap.display.qrUrl === QR && snap.display.cornerLink === CORNER && snap.display.theme === 'plain' && snap.display.queueCount === 3 && Object.keys(snap.display).sort().join() === 'cornerLink,qrUrl,queueCount,theme' && !Object.prototype.hasOwnProperty.call(snap, 'nexus'));

    async function open(browser, url, viewport) {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      const bag = track(page);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return { page, ctx, ...bag };
    }
    const VP = { width: 1366, height: 768 };
    const control = await open(chrome, BASE + '/control', { width: 1366, height: 900 });
    await control.page.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.page.fill('#pinInput', PIN);
    await control.page.click('#pinBtn');
    await control.page.waitForSelector('#pinModal.hidden', { state: 'attached' });
    const timer = await open(chrome, BASE + '/display?role=timer&autostart=1&fs=0&name=Pit%20timer', VP);
    const queue = await open(chrome, BASE + '/display?role=queue&autostart=1&fs=0&name=Gym%20queue', VP);
    const main = await open(chrome, BASE + '/display?role=main&autostart=1&fs=0&name=Projector', VP);
    const pair = await open(chrome, BASE + '/display?pair=A&autostart=1&fs=0&name=Field%20A', VP);
    const hall = await open(chrome, `http://127.0.0.1:${qAddr.port}/?poll=200`, VP);
    check('timer connected', await waitFor(() => timer.page.evaluate(() => !!(FLL.state && FLL.config && FLL.config.display))));
    check('queue connected', await waitFor(() => queue.page.evaluate(() => !!(FLL.state && FLL.config))));
    check('hallway queue loaded', await waitFor(() => hall.page.evaluate(() => !!document.querySelector('#nxqr canvas') && document.getElementById('nxqrLabel').textContent.length > 0)));

    async function decode(page) {
      const raw = await page.evaluate(() => {
        const box = document.getElementById('nxqr');
        const c = document.getElementById('nxqrCanvas');
        if (!box || !c || box.classList.contains('hidden')) return null;
        const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        const r = c.getBoundingClientRect();
        return { w: c.width, h: c.height, buf: Array.from(img.data), cssW: r.width, cssH: r.height, label: document.getElementById('nxqrLabel').textContent };
      });
      if (!raw) return null;
      const code = jsQR(Uint8ClampedArray.from(raw.buf), raw.w, raw.h);
      let left = -1, top = -1, run = 0;
      for (let y = 0; y < raw.h && top < 0; y++) {
        for (let x = 0; x < raw.w; x++) if (raw.buf[(y * raw.w + x) * 4] < 128) { top = y; left = x; break; }
      }
      for (let x = left; x < raw.w && raw.buf[(top * raw.w + x) * 4] < 128; x++) run++;
      const module = run / 7;
      return { text: code && code.data, cssW: raw.cssW, cssH: raw.cssH, quiet: module ? left / module : 0, label: raw.label };
    }
    async function fit(page) {
      return page.evaluate(() => {
        const qrEl = document.getElementById('nxqr');
        const on = qrEl && !qrEl.classList.contains('hidden') && getComputedStyle(qrEl).display !== 'none';
        const qr = on ? qrEl.getBoundingClientRect() : null;
        const sel = '.qbreak-on, .qtime, .qbreak .time, #time, .banner, .qhead, .qnow, .qrow, .brksub, .qback-match';
        const overlap = [];
        const clipped = [];
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) clipped.push((el.className || el.id || '').toString().slice(0, 40));
          if (qr && !(qr.right <= r.left + 1 || qr.left >= r.right - 1 || qr.bottom <= r.top + 1 || qr.top >= r.bottom - 1)) overlap.push((el.className || el.id || '').toString().slice(0, 40));
        }
        const qrInside = !qr || (qr.left >= -1 && qr.top >= -1 && qr.right <= innerWidth + 1 && qr.bottom <= innerHeight + 1);
        return {
          scrollX: document.documentElement.scrollWidth <= innerWidth + 1,
          scrollY: document.documentElement.scrollHeight <= innerHeight + 1,
          overY: document.documentElement.scrollHeight - innerHeight,
          overlap, clipped, qrInside,
          qrW: qr ? qr.width : 0,
        };
      });
    }
    function fitOk(info) { return info.scrollX && info.scrollY && info.qrInside && info.overlap.length === 0 && info.clipped.length === 0; }

    const idle = await decode(timer.page);
    check('idle field timer QR decodes to the default rankings URL', idle && idle.text === QR && idle.label === LABEL, idle && { text: idle.text, label: idle.label });
    check('idle field timer quiet zone is at least 4 modules', idle && idle.quiet >= 3.9, idle && idle.quiet);
    check('idle field timer QR is large at 1366x768', idle && idle.cssW >= 270 && idle.cssH >= 270, idle && { w: idle.cssW, h: idle.cssH });
    let info = await fit(timer.page);
    check('idle field timer fits at 1366x768', fitOk(info), info);
    const qDec = await decode(queue.page);
    check('gym queue QR decodes to the same URL', qDec && qDec.text === QR && qDec.label === LABEL, qDec && qDec.text);
    info = await fit(queue.page);
    check('gym queue fits at 1366x768', fitOk(info) && info.qrW >= 270, info);
    const hDec = await decode(hall.page);
    check('hallway queue QR decodes to the same URL', hDec && hDec.text === QR && hDec.label === LABEL, hDec && hDec.text);
    info = await fit(hall.page);
    check('hallway queue fits at 1366x768', fitOk(info) && info.qrW >= 270, info);
    check('projector and pair show the corner link and no QR', await main.page.evaluate(c => document.getElementById('name').textContent === c && document.getElementById('nxqr').classList.contains('hidden'), CORNER)
      && await pair.page.evaluate(c => document.getElementById('name').textContent === c && document.getElementById('nxqr').classList.contains('hidden'), CORNER));
    check('corner link is not the station name; Head Ref still lists that name', await waitFor(() => control.page.evaluate(() => /Pit timer/.test(document.getElementById('clients').innerText)))
      && await timer.page.evaluate(() => document.getElementById('name').textContent === 'https://fll.nexus/fll/mm26' && !/Pit timer/.test(document.getElementById('name').textContent)));
    check('Head Ref rankings field is prefilled and editable', await control.page.evaluate(v => document.getElementById('qrUrl').value === v.q && document.getElementById('cornerLink').value === v.c, { q: QR, c: CORNER }));

    await timer.page.setViewportSize({ width: 1920, height: 1080 });
    await queue.page.setViewportSize({ width: 1920, height: 1080 });
    await hall.page.setViewportSize({ width: 1920, height: 1080 });
    await sleep(200);
    const big = await decode(timer.page);
    check('field timer QR is large at 1920x1080', big && big.cssW >= 360 && big.cssH >= 360, big && { w: big.cssW, h: big.cssH });
    info = await fit(timer.page);
    check('field timer fits at 1920x1080', fitOk(info), info);
    info = await fit(queue.page);
    check('gym queue fits at 1920x1080', fitOk(info) && info.qrW >= 360, info);
    info = await fit(hall.page);
    check('hallway queue fits at 1920x1080', fitOk(info) && info.qrW >= 360, info);
    await timer.page.setViewportSize(VP);
    await queue.page.setViewportSize(VP);
    await hall.page.setViewportSize(VP);
    await sleep(150);

    await control.page.evaluate(t => FLL.cmd('scheduleCSV', { text: t, name: 'Sample' }), fs.readFileSync(SAMPLE, 'utf8'));
    check('schedule loaded', await waitFor(() => queue.page.evaluate(() => /match 1/i.test(document.body.innerText) && /next/i.test(document.body.innerText))));
    check('hallway shows the queue', await waitFor(() => hall.page.evaluate(() => /Match 1/.test(document.body.innerText))));
    info = await fit(queue.page);
    check('gym queue with matches fits at 1366x768', fitOk(info), info);
    info = await fit(hall.page);
    check('hallway queue with matches fits at 1366x768', fitOk(info), info);
    await queue.page.screenshot({ path: path.join(SHOTS, 'gym_queue_1366.png') });
    await hall.page.screenshot({ path: path.join(SHOTS, 'hallway_queue_1366.png') });
    await timer.page.screenshot({ path: path.join(SHOTS, 'field_timer_idle_1366.png') });

    const phone = await open(chrome, `http://127.0.0.1:${qAddr.port}/?poll=200`, { width: 390, height: 844 });
    check('phone hallway shows the QR', await waitFor(() => phone.page.evaluate(() => !document.getElementById('nxqr').classList.contains('hidden') && /Match 1/.test(document.body.innerText))));
    info = await fit(phone.page);
    check('phone hallway fits with no scrollbar', fitOk(info), info);

    await timer.page.evaluate(() => {
      window.__qrTicks = [];
      FLL.on('state', ev => {
        const st = ev.state;
        window.__qrTicks.push({ status: st.status, kind: st.kind, hidden: document.getElementById('nxqr').classList.contains('hidden') });
      });
    });
    await queue.page.evaluate(() => {
      window.__qrTicks = [];
      FLL.on('state', ev => {
        window.__qrTicks.push({ status: ev.state.status, kind: ev.state.kind, hidden: document.getElementById('nxqr').classList.contains('hidden') });
      });
    });
    await control.page.evaluate(() => FLL.cmd('start', { force: true }));
    check('START state reached the field timer', await waitFor(() => timer.page.evaluate(() => (window.__qrTicks || []).some(s => s.status === 'running' && s.kind !== 'break'))));
    const started = await timer.page.evaluate(() => window.__qrTicks.find(s => s.status === 'running' && s.kind !== 'break'));
    check('field timer hides the QR in the same state update as START', started && started.hidden === true, started);
    const qRun = await queue.page.evaluate(() => window.__qrTicks.find(s => s.status === 'running' && s.kind !== 'break'));
    check('gym queue keeps the QR in that same update', qRun && qRun.hidden === false, qRun);
    check('hallway queue keeps the QR while a match runs', await waitFor(() => hall.page.evaluate(() => /Now playing|Field ready|Match/.test(document.body.innerText) && !document.getElementById('nxqr').classList.contains('hidden'))));
    await timer.page.screenshot({ path: path.join(SHOTS, 'field_timer_running_1366.png') });
    info = await fit(timer.page);
    check('running field timer fits with the QR gone', fitOk(info) && info.qrW === 0, info);
    check('running field timer does not show the scan label', await timer.page.evaluate(l => !document.body.innerText.includes(l), LABEL));

    await control.page.evaluate(() => FLL.cmd('pause'));
    check('paused state arrived', await waitFor(() => timer.page.evaluate(() => FLL.state && FLL.state.status === 'paused')));
    check('paused field timer keeps the QR hidden', await timer.page.evaluate(() => document.getElementById('nxqr').classList.contains('hidden') && FLL.state.status === 'paused'));
    check('gym queue still shows the QR while paused', await queue.page.evaluate(() => !document.getElementById('nxqr').classList.contains('hidden')));

    await control.page.evaluate(() => FLL.cmd('reset'));
    check('reset returns the field timer to idle with the QR', await waitFor(() => timer.page.evaluate(() => FLL.state && FLL.state.status === 'idle' && !document.getElementById('nxqr').classList.contains('hidden'))));

    await control.page.evaluate(() => FLL.cmd('set', { duration: 1200, label: 'Match' }));
    await sleep(200);
    await control.page.evaluate(() => FLL.cmd('start', { force: true }));
    check('done brings the QR back', await waitFor(() => timer.page.evaluate(() => FLL.state && FLL.state.status === 'done' && !document.getElementById('nxqr').classList.contains('hidden')), 6000));
    check('gym queue still shows it when the match is done', await queue.page.evaluate(() => !document.getElementById('nxqr').classList.contains('hidden')));

    await control.page.evaluate(() => FLL.cmd('endSession'));
    check('End match session brings the field timer back to a QR', await waitFor(() => timer.page.evaluate(() => {
      const s = FLL.state;
      return s && !document.getElementById('nxqr').classList.contains('hidden') && (s.kind === 'break' || s.status === 'idle' || s.status === 'done');
    })));
    const afterEnd = await timer.page.evaluate(() => ({ kind: FLL.state.kind, status: FLL.state.status, hidden: document.getElementById('nxqr').classList.contains('hidden') }));
    check('QR is showing after End match session', afterEnd.hidden === false, afterEnd);

    if (!(await timer.page.evaluate(() => FLL.state.kind === 'break'))) {
      await control.page.evaluate(() => FLL.cmd('breakStart', { duration: 180000 }));
      check('break started', await waitFor(() => timer.page.evaluate(() => FLL.state && FLL.state.kind === 'break')));
    }
    check('field timer shows the QR during a break', await timer.page.evaluate(() => FLL.state.kind === 'break' && FLL.state.status === 'running' && !document.getElementById('nxqr').classList.contains('hidden')));
    check('both queues show the QR during a break', await queue.page.evaluate(() => !document.getElementById('nxqr').classList.contains('hidden'))
      && await waitFor(() => hall.page.evaluate(() => !document.getElementById('nxqr').classList.contains('hidden') && /break/i.test(document.body.innerText))));
    await control.page.evaluate(() => FLL.cmd('breakLabel', { lunch: true }));
    check('lunch label reached the gym queue', await waitFor(() => queue.page.evaluate(() => /on a break/i.test(document.body.innerText) && /when we're back/i.test(document.body.innerText))));
    check('hallway lunch shows the QR', await waitFor(() => hall.page.evaluate(() => /on a break/i.test(document.body.innerText) && !document.getElementById('nxqr').classList.contains('hidden'))));
    const lunchGap = await queue.page.evaluate(() => {
      const kids = [...document.querySelectorAll('.qbreak-top > *')].map(el => ({ t: el.textContent, w: el.getBoundingClientRect().width }));
      return { kids, empty: kids.some(k => !k.t.trim() || k.w < 2) };
    });
    check('lunch sign has no empty gap where an emoji used to be', lunchGap.kids.length >= 2 && lunchGap.empty === false && lunchGap.kids.some(k => /on a break/i.test(k.t)), lunchGap);
    info = await fit(queue.page);
    check('gym lunch fits at 1366x768 with the QR', fitOk(info), info);
    info = await fit(hall.page);
    check('hallway lunch fits at 1366x768 with the QR', fitOk(info), info);
    await queue.page.setViewportSize({ width: 1920, height: 1080 });
    await hall.page.setViewportSize({ width: 1920, height: 1080 });
    await sleep(150);
    info = await fit(queue.page);
    check('gym lunch fits at 1920x1080', fitOk(info), info);
    info = await fit(hall.page);
    check('hallway lunch fits at 1920x1080', fitOk(info), info);
    await queue.page.setViewportSize(VP);
    await hall.page.setViewportSize(VP);
    info = await fit(phone.page);
    check('phone hallway lunch fits', await waitFor(() => phone.page.evaluate(() => /on a break/i.test(document.body.innerText))) && fitOk(await fit(phone.page)), await fit(phone.page));

    const nastyUrl = 'https://fll.nexus/region/fll/event/mm26/leaderboard?q="a"<b>';
    const nastyCorner = 'https://fll.nexus/fll/mm26?x="y"<z>';
    await control.page.fill('#cornerLink', nastyCorner);
    await control.page.dispatchEvent('#cornerLink', 'change');
    await control.page.fill('#qrUrl', nastyUrl);
    await control.page.dispatchEvent('#qrUrl', 'change');
    check('nasty URL reached the field timer', await waitFor(() => timer.page.evaluate(u => (FLL.config.display || {}).qrUrl === u, nastyUrl)));
    const nasty = await decode(timer.page);
    check('QR with quotes and < decodes to that exact URL', nasty && nasty.text === nastyUrl, nasty && nasty.text);
    const cornerDom = await timer.page.evaluate(() => {
      const n = document.getElementById('name');
      return { text: n.textContent, nodes: n.childNodes.length, type: n.childNodes[0] && n.childNodes[0].nodeType, htmlHasRaw: n.innerHTML.includes('<z>') };
    });
    check('corner link is set with textContent and is not parsed as HTML', cornerDom.text === nastyCorner && cornerDom.nodes === 1 && cornerDom.type === 3 && cornerDom.htmlHasRaw === false, cornerDom);
    info = await fit(timer.page);
    check('nasty URL does not break the field timer layout', fitOk(info), info);
    info = await fit(queue.page);
    check('nasty URL does not break the gym queue layout', fitOk(info), info);

    const longUrl = 'https://fll.nexus/region/fll/event/mm26/leaderboard?' + 'a'.repeat(440);
    const longCorner = 'https://fll.nexus/fll/mm26/' + 'c'.repeat(470);
    await control.page.fill('#qrUrl', longUrl);
    await control.page.dispatchEvent('#qrUrl', 'change');
    await control.page.fill('#cornerLink', longCorner);
    await control.page.dispatchEvent('#cornerLink', 'change');
    check('500-character URL is shown', await waitFor(() => timer.page.evaluate(u => (FLL.config.display || {}).qrUrl === u && !document.getElementById('nxqr').classList.contains('hidden'), longUrl)));
    check('500-character corner text is the full string', await timer.page.evaluate(c => document.getElementById('name').textContent === c, longCorner));
    info = await fit(timer.page);
    check('500-character values do not break the field timer layout', fitOk(info), info);
    info = await fit(queue.page);
    check('500-character values do not break the gym queue layout', fitOk(info), info);
    info = await fit(hall.page);
    check('500-character values do not break the hallway queue', await waitFor(() => hall.page.evaluate(u => (document.getElementById('nxqrLabel').textContent || '').length > 0 && document.getElementById('name').textContent.length > 400, longUrl)) && fitOk(await fit(hall.page)), await fit(hall.page));

    const tooLong = 'https://x.test/' + 'b'.repeat(3200);
    const warns = [];
    timer.page.on('console', m => { if (/QR code could not be drawn/.test(m.text())) warns.push(m.text()); });
    const errorsBefore = timer.errors.length;
    await control.page.fill('#qrUrl', tooLong);
    await control.page.dispatchEvent('#qrUrl', 'change');
    check('too-long URL hides the QR', await waitFor(() => timer.page.evaluate(() => document.getElementById('nxqr').classList.contains('hidden') && document.getElementById('nxqrLabel').textContent === '')));
    check('too-long URL is logged and does not throw', await waitFor(() => warns.length > 0) && timer.errors.length === errorsBefore, { warns, errors: timer.errors.slice(errorsBefore) });
    check('gym queue also hides a too-long URL with no throw', await waitFor(() => queue.page.evaluate(() => document.getElementById('nxqr').classList.contains('hidden'))) && queue.errors.length === 0);

    await control.page.fill('#qrUrl', '');
    await control.page.dispatchEvent('#qrUrl', 'change');
    check('blank URL hides the QR and the label on the field timer', await waitFor(() => timer.page.evaluate(l => document.getElementById('nxqr').classList.contains('hidden') && !document.body.innerText.includes(l), LABEL)));
    check('blank URL hides them on the gym queue', await waitFor(() => queue.page.evaluate(l => document.getElementById('nxqr').classList.contains('hidden') && !document.body.innerText.includes(l), LABEL)));
    check('blank URL hides them on the hallway queue', await waitFor(() => hall.page.evaluate(l => document.getElementById('nxqr').classList.contains('hidden') && !document.body.innerText.includes(l), LABEL)));

    const customQr = 'https://fll.nexus/region/fll/event/mm26/leaderboard';
    const customCorner = 'https://fll.nexus/fll/mm26';
    await control.page.fill('#qrUrl', customQr);
    await control.page.dispatchEvent('#qrUrl', 'change');
    await control.page.fill('#cornerLink', customCorner);
    await control.page.dispatchEvent('#cornerLink', 'change');
    check('custom values saved', await waitFor(() => {
      try {
        const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
        return s.display && s.display.qrUrl === customQr && s.display.cornerLink === customCorner && s.nexus && s.nexus.url === 'https://fll.nexus/fll/mm26';
      } catch (e) { return false; }
    }));

    await stop();
    srv = await start();
    check('values survive a restart', await waitFor(() => timer.page.evaluate(v => FLL.connected && FLL.config && FLL.config.display && FLL.config.display.qrUrl === v.q && FLL.config.display.cornerLink === v.c, { q: customQr, c: customCorner })));
    const afterRestart = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    check('state.json still has both values and the Nexus fetch URL after restart', afterRestart.display.qrUrl === customQr && afterRestart.display.cornerLink === customCorner && afterRestart.nexus.url === 'https://fll.nexus/fll/mm26');

    await stop();
    fs.copyFileSync(STATE, STATE + '.bak');
    fs.writeFileSync(STATE, '{');
    srv = await start();
    check('startup says the backup was used', /backup/i.test(srv.err));
    check('values survive a .bak recovery', await waitFor(() => timer.page.evaluate(v => FLL.connected && FLL.config && FLL.config.display && FLL.config.display.qrUrl === v.q && FLL.config.display.cornerLink === v.c, { q: customQr, c: customCorner })));

    const hosts = [...control.urls, ...timer.urls, ...queue.urls, ...hall.urls, ...main.urls, ...pair.urls, ...phone.urls];
    check('Chromium audience pages make no external request', externalOf(hosts).length === 0, externalOf(hosts).slice(0, 5));

    firefox = await pw.firefox.launch();
    const fxTimer = await open(firefox, BASE + '/display?role=timer&autostart=1&fs=0', VP);
    const fxQueue = await open(firefox, BASE + '/display?role=queue&autostart=1&fs=0', VP);
    const fxHall = await open(firefox, `http://127.0.0.1:${qAddr.port}/?poll=200`, VP);
    check('Firefox field timer connected', await waitFor(() => fxTimer.page.evaluate(() => !!(FLL.state && FLL.config))));
    const fxDec = await decode(fxTimer.page);
    check('Firefox draws a QR that decodes to the rankings URL', fxDec && fxDec.text === customQr && fxDec.quiet >= 3.9, fxDec && { text: fxDec.text, quiet: fxDec.quiet });
    check('Firefox gym queue draws the QR', await waitFor(async () => { const d = await decode(fxQueue.page); return d && d.text === customQr; }));
    check('Firefox hallway queue draws the QR', await waitFor(async () => { const d = await decode(fxHall.page); return d && d.text === customQr; }));
    check('Firefox pages make no external request', externalOf([...fxTimer.urls, ...fxQueue.urls, ...fxHall.urls]).length === 0, externalOf([...fxTimer.urls, ...fxQueue.urls, ...fxHall.urls]).slice(0, 5));
    check('no page errors in Firefox', fxTimer.errors.length + fxQueue.errors.length + fxHall.errors.length === 0, [...fxTimer.errors, ...fxQueue.errors, ...fxHall.errors]);
  } catch (e) {
    console.error(e);
    failed++;
  }
  await chrome.close().catch(() => {});
  if (firefox) await firefox.close().catch(() => {});
  await stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'FAIL' : 'PASS');
  console.log('screenshots: ' + SHOTS);
  process.exit(failed ? 1 : 0);
})();
