// Regression for the Mustang Madness checks that the v0.5.1 suite did not lock down:
//   #6 a truncated state.json must not be copied over state.json.bak on the next save
//      (including the save a restart does when the match ended while the server was down)
//   #7 a double-click on NEXT (second tap ~150 ms later, after the screen has updated) moves one match
// The simultaneous-NEXT and "ack is on disk" cases already live in robust-test.js.
'use strict';
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');

const PIN = '4321';
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0, cmdUid = 0;
function check(name, ok, detail) {
  ok ? passed++ : failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(err => err ? rej(err) : res(p)); });
  });
}

async function startServer(data) {
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(port), '--pin', PIN, '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.err = ''; srv.port = port;
  srv.stderr.on('data', d => { srv.err += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout\n' + srv.err)), 8000);
    srv.stdout.on('data', d => { if (/Control/.test(String(d))) { clearTimeout(t); res(); } });
    srv.once('exit', code => { clearTimeout(t); rej(new Error('server exited ' + code + '\n' + srv.err)); });
  });
  return srv;
}
function stopServer(srv, sig) {
  if (!srv || srv.exitCode != null) return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
    srv.once('exit', () => { clearTimeout(t); res(); });
    srv.kill(sig || 'SIGTERM');
  });
}
function connect(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const pending = new Map();
    let seq = 0;
    const box = { state: null, schedule: null };
    const fail = e => rej(e.error || e);
    ws.addEventListener('error', fail);
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'state') box.state = m;
      if (m.t === 'schedule') box.schedule = m.schedule;
      if (m.t === 'ack' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.t === 'welcome') box.welcome = m;
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'control', pin: PIN, name: 'repro', deviceId: 'rel1' }));
      const t0 = Date.now();
      (function wait() {
        if (box.state && box.welcome && box.welcome.authed) {
          ws.removeEventListener('error', fail);
          return res({
            box,
            cmd(cmd, extra) {
              const id = ++seq;
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('ack timeout ' + cmd)), 4000);
                pending.set(id, m => { clearTimeout(timer); resolve(m); });
                ws.send(JSON.stringify(Object.assign({ t: 'cmd', cmd, id, uid: 'rel.' + (++cmdUid) }, extra || {})));
              });
            },
            close() { try { ws.close(); } catch (e) {} },
          });
        }
        if (Date.now() - t0 > 4000) return rej(new Error('no welcome'));
        setTimeout(wait, 20);
      })();
    });
  });
}
function getJson(port, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, x => {
      let b = ''; x.on('data', d => b += d); x.on('end', () => { try { res({ status: x.statusCode, body: JSON.parse(b) }); } catch (e) { rej(e); } });
    });
    r.on('error', rej); r.end();
  });
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { error: e.message, head: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 60) : null }; }
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-rel-'));
  const stateFile = path.join(data, 'state.json');
  const bakFile = stateFile + '.bak';
  let srv;
  try {
    // ---------- #6: backup must survive the save that follows a truncated state.json ----------
    srv = await startServer(data);
    let c = await connect(srv.port);
    const csv = fs.readFileSync(SAMPLE, 'utf8');
    let ack = await c.cmd('scheduleCSV', { text: csv, name: 'reliability' });
    ack = await c.cmd('set', { duration: 8888, label: 'Match' });
    check('#6 setup: schedule loaded and duration saved', ack.ok && c.box.schedule && c.box.schedule.matches.length === 24, { ok: ack.ok, n: c.box.schedule && c.box.schedule.matches.length });
    c.close();
    await stopServer(srv, 'SIGTERM');
    fs.copyFileSync(stateFile, bakFile);
    const goodBak = readJson(bakFile);
    check('#6 setup: backup has the schedule', goodBak.schedule && goodBak.schedule.matches.length === 24 && !goodBak.error, goodBak.error);
    fs.writeFileSync(stateFile, '{"timer":{"dur');
    srv = await startServer(data);
    check('#6 truncated file: loud warning and the damaged file is kept', /!!!/.test(srv.err) && /backup/i.test(srv.err) && fs.readdirSync(data).some(f => /corrupt/.test(f)), srv.err.slice(0, 220));
    c = await connect(srv.port);
    check('#6 truncated file: schedule restored from backup', c.box.schedule && c.box.schedule.matches.length === 24, { n: c.box.schedule && c.box.schedule.matches.length, dur: c.box.state && c.box.state.duration });
    ack = await c.cmd('set', { duration: 9999, label: 'Match' });
    const bakAfter = readJson(bakFile);
    check('#6 first save after recovery does not replace the backup with the truncated file', ack.ok && bakAfter.schedule && bakAfter.schedule.matches.length === 24, bakAfter.error ? { error: bakAfter.error, head: bakAfter.head } : { n: bakAfter.schedule.matches.length, dur: bakAfter.timer && bakAfter.timer.duration });
    c.close();
    await stopServer(srv, 'SIGKILL');
    fs.writeFileSync(stateFile, '{"timer":{"dur');
    srv = await startServer(data);
    c = await connect(srv.port);
    check('#6 a second truncation still restores the schedule', c.box.schedule && c.box.schedule.matches.length === 24 && /!!!/.test(srv.err), { n: c.box.schedule && c.box.schedule.matches.length });
    c.close();
    await stopServer(srv, 'SIGTERM');

    // The restart that finishes a match also saves. That save must not copy a truncated state.json over the backup.
    srv = await startServer(data);
    c = await connect(srv.port);
    await c.cmd('scheduleCSV', { text: csv, name: 'reliability' });
    await c.cmd('set', { duration: 5000, label: 'Match' });
    ack = await c.cmd('start', { force: true });
    check('#6 setup: match is running', ack.ok && c.box.state.status === 'running', { ok: ack.ok, status: c.box.state.status });
    c.close();
    await stopServer(srv, 'SIGTERM');
    const running = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    running.timer.startAt = Date.now() - running.timer.duration - 3000;
    fs.writeFileSync(bakFile, JSON.stringify(running, null, 1));
    fs.writeFileSync(stateFile, '{"timer":{"dur');
    srv = await startServer(data);
    await sleep(200);
    const bakCross = readJson(bakFile);
    c = await connect(srv.port);
    check('#6 restart across a match end does not destroy the backup', bakCross.schedule && bakCross.schedule.matches.length === 24, bakCross.error ? { error: bakCross.error, head: bakCross.head } : { n: bakCross.schedule.matches.length });
    check('#6 that restart still finishes the match and keeps the schedule', c.box.schedule && c.box.schedule.matches.length === 24 && c.box.state.status === 'done' && c.box.state.match.current === 1, { status: c.box.state.status, current: c.box.state.match && c.box.state.match.current, n: c.box.schedule && c.box.schedule.matches.length });
    c.close();
    await stopServer(srv, 'SIGTERM');

    // ---------- #7: double-click NEXT after the screen has updated ----------
    srv = await startServer(data);
    const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failed++; });
    page.on('dialog', d => d.accept());
    try {
      await page.goto('http://127.0.0.1:' + srv.port + '/control');
      await page.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
      await page.fill('#pinInput', PIN); await page.click('#pinBtn');
      await page.waitForSelector('#pinModal.hidden', { state: 'attached' });
      await page.evaluate(t => FLL.cmd('scheduleCSV', { text: t, name: 'reliability' }), csv);
      await page.waitForFunction(() => FLL.schedule && FLL.schedule.matches.length === 24);
      const cur = () => page.evaluate(() => FLL.state.match.current);
      const c0 = await cur();
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await sleep(150);
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await sleep(400);
      const c1 = await cur();
      check('#7 double-click NEXT (150 ms apart, screen already updated) advances exactly one match', c1 === c0 + 1, { c0, c1 });
      await sleep(500);
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await sleep(400);
      const c2 = await cur();
      check('#7 NEXT works again once the double-click window has passed', c2 === c1 + 1, { c1, c2 });
      await page.evaluate(() => document.getElementById('prevBtn').click());
      await sleep(400);
      const c3 = await cur();
      check('#7 PREV immediately after NEXT still moves back one', c3 === c2 - 1, { c2, c3 });
    } finally {
      await browser.close().catch(() => {});
    }

    // Lunch gap in the Mustang export (11:55 AM then 1:00 PM). Shift that afternoon
    // match to 65 minutes from now and end the session onto it with Lunch ticked.
    // The break covers the gap; the queue snapshot is the Lunch card from #77.
    const mustang = fs.readFileSync(path.join(__dirname, 'fixtures', 'mustang-madness-example-schedule.csv'), 'utf8');
    c = await connect(srv.port);
    ack = await c.cmd('scheduleCSV', { text: mustang, name: 'Mustang Madness', date: '2026-11-14' });
    const mm = c.box.schedule && c.box.schedule.matches || [];
    const lunchAt = mm.findIndex((m, i) => i && m.time - mm[i - 1].time === 65 * 60 * 1000);
    check('Mustang import on the server: 6 matches, practice on the first two, no TRUE/FALSE teams', ack.ok && mm.length === 6 && mm[0].practice === true && mm[1].practice === true && mm[4].practice === false && mm[1].teams['5'] === '9205' && !mm[1].teams['1'] && lunchAt === 4, { ok: ack.ok, n: mm.length, lunchAt, teams: mm[1] && mm[1].teams });
    const when = Date.now() + 65 * 60 * 1000;
    ack = await c.cmd('scheduleShift', { index: lunchAt, time: when });
    await c.cmd('goto', { index: lunchAt });
    await c.cmd('breakLabel', { lunch: true });
    const ended = await c.cmd('endSession');
    const br = c.box.state;
    const afternoon = c.box.schedule.matches[lunchAt];
    check('lunch gap becomes a Lunch break until the 1:00 PM match (2 min early)', ended.ok && br.kind === 'break' && br.status === 'running' && br.lunch === true && Math.abs(br.breakUntil - (afternoon.time - 2 * 60 * 1000)) < 2000 && br.duration > 60 * 60 * 1000 && br.duration < 65 * 60 * 1000, { ok: ended.ok, err: ended.error, kind: br.kind, status: br.status, lunch: br.lunch, duration: br.duration, breakUntil: br.breakUntil, matchTime: afternoon && afternoon.time });
    const snap = await getJson(srv.port, '/internal/queue-snapshot');
    const q = snap.body;
    check('queue snapshot for that break is Lunch, and the afternoon match is tables 1-4 only', snap.status === 200 && q.timer.lunch === true && q.timer.kind === 'break' && q.timer.status === 'running' && q.schedule.matches[lunchAt].practice === false && q.schedule.matches[lunchAt].teams['1'] === '9501' && q.schedule.matches[lunchAt].teams['5'] == null, { status: snap.status, lunch: q.timer && q.timer.lunch, kind: q.timer && q.timer.kind, teams: q.schedule && q.schedule.matches[lunchAt] && q.schedule.matches[lunchAt].teams });
    c.close();
  } catch (e) {
    console.log('ERROR', e.stack || e);
    failed++;
  } finally {
    if (srv) await stopServer(srv, 'SIGTERM');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
