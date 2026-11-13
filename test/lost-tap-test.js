// Lost taps (#46): a command whose connection drops before the reply shows a toast and is never resent; "No reply" tells you to
// check before tapping again; a repeated tap id is applied once (also across a reconnect); START while running / PAUSE while
// paused change nothing.   node test/lost-tap-test.js
//   PWBROWSER=webkit node test/lost-tap-test.js
const { chromium, webkit } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const PORT = 8094, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
// Every cmd frame a page sends is logged in window.__sent. window.__drop = 'lost' swallows the next cmd frame and drops the
// socket (sent, never applied); 'applied' sends it and drops the socket before the ack; 'silent' swallows it (no reply at all).
const HOOK = `(() => { const o = WebSocket.prototype.send; window.__sent = [];
  WebSocket.prototype.send = function (d) { let m = null; try { m = JSON.parse(d); } catch (e) {}
    if (m && m.t === 'cmd') { window.__sent.push(m); const how = window.__drop; window.__drop = null;
      if (how === 'lost' || how === 'applied') queueMicrotask(() => FLL._lost(false));   // after cmd() registers the pending tap, before any reply
      if (how === 'lost' || how === 'silent') return;
      const delay = window.__delayCmd || 0;
      if (delay) { const sock = this; setTimeout(() => { try { o.call(sock, d); } catch (e) {} }, delay); return; } }
    return o.call(this, d); }; })();`;
// TCP proxy that accepts bytes and holds them until release. New connections opened after stall() are not held,
// so a page can reconnect while an earlier START is still sitting in the old socket's buffer.
function stallProxy(targetPort) {
  const conns = new Set();
  const srv = net.createServer(client => {
    const up = net.connect(targetPort, '127.0.0.1');
    const entry = { client, up, q: [], down: [], hold: false, clientGone: false, upReady: false, early: [] };
    conns.add(entry);
    up.on('connect', () => { entry.upReady = true; for (const d of entry.early) { try { up.write(d); } catch (e) {} } entry.early = []; });
    client.on('data', d => {
      if (entry.hold) entry.q.push(d);
      else if (!entry.upReady) entry.early.push(d);
      else { try { up.write(d); } catch (e) {} }
    });
    // Hold both ways. Server pushes (the client list, pongs) would otherwise keep the phone's heartbeat alive.
    up.on('data', d => {
      if (entry.hold) entry.down.push(d);
      else { try { if (!client.destroyed) client.write(d); } catch (e) {} }
    });
    client.on('close', () => { entry.clientGone = true; if (!entry.hold && !entry.q.length) { try { up.end(); } catch (e) {} } });
    up.on('close', () => { try { client.destroy(); } catch (e) {} conns.delete(entry); });
    client.on('error', () => {}); up.on('error', () => {});
    try { client.setNoDelay(true); up.setNoDelay(true); } catch (e) {}
  });
  return {
    listen: () => new Promise((res, rej) => srv.listen(0, '127.0.0.1', () => res(srv.address().port))),
    stall() { for (const e of conns) e.hold = true; },
    release() {
      for (const e of conns) {
        e.hold = false;
        const q = e.q; e.q = [];
        const down = e.down; e.down = [];
        for (const d of down) { try { if (!e.client.destroyed) e.client.write(d); } catch (err) {} }
        for (const d of q) { try { e.up.write(d); } catch (err) {} }
        if (e.clientGone) { try { e.up.end(); } catch (err) {} }
      }
    },
    heldBytes() { let n = 0; for (const e of conns) for (const d of e.q) n += d.length; return n; },
    close() { return new Promise(res => { for (const e of conns) { try { e.client.destroy(); } catch (err) {} try { e.up.destroy(); } catch (err) {} } srv.close(() => res()); }); },
  };
}
function openRaw(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const pending = new Map();
    let seq = 0, n = 0;
    const box = { state: null };
    const fail = e => reject(e.error || e);
    ws.addEventListener('error', fail);
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'state') box.state = m;
      if (m.t === 'ack' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.t === 'welcome') box.welcome = m;
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'control', pin: PIN, name: 'late', deviceId: 'late88' }));
      const t0 = Date.now();
      (function wait() {
        if (box.state && box.welcome && box.welcome.authed) {
          ws.removeEventListener('error', fail);
          return resolve({
            box,
            serverNow() {
              return new Promise(res => {
                const c0 = Date.now();
                const on = ev => {
                  let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
                  if (m.t === 'pong' && m.c0 === c0) { ws.removeEventListener('message', on); res(m.s); }
                };
                ws.addEventListener('message', on);
                ws.send(JSON.stringify({ t: 'ping', c0 }));
              });
            },
            cmd(cmd, extra) {
              const id = ++seq;
              return new Promise((res, rej) => {
                const timer = setTimeout(() => rej(new Error('ack timeout ' + cmd)), 4000);
                pending.set(id, m => { clearTimeout(timer); res(m); });
                ws.send(JSON.stringify(Object.assign({ t: 'cmd', cmd, id, uid: 'late.' + (++n) + '.' + cmd }, extra || {})));
              });
            },
            close() { try { ws.close(); } catch (e) {} },
          });
        }
        if (Date.now() - t0 > 4000) return reject(new Error('no welcome'));
        setTimeout(wait, 20);
      })();
    });
  });
}

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-losttap-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  const BROWSER = process.env.PWBROWSER || 'chromium';
  if (BROWSER !== 'webkit' && BROWSER !== 'chromium') throw new Error('PWBROWSER must be webkit or chromium');
  const browser = BROWSER === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  async function mk(url, init, vp) {
    const ctx = await browser.newContext({ viewport: vp || { width: 1366, height: 1000 } }); await ctx.addInitScript(HOOK); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; }); p.on('dialog', d => d.accept());
    await p.goto(url); return p;
  }
  const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
  try {
    const control = await mk(`${BASE}/control`, 'window.__DEVICE_ID="ctl";');
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    const cmd = (c, e) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const st = () => control.evaluate(() => FLL.state);
    const connected = p => waitFor(() => p.evaluate(() => FLL.connected && !!FLL.state));
    const toast = p => p.evaluate(() => { const t = document.getElementById('toast'); return t.style.display === 'block' ? t.textContent : null; });
    const hideToast = p => p.evaluate(() => { document.getElementById('toast').style.display = 'none'; });
    const sentOf = (p, c) => p.evaluate(c => window.__sent.filter(m => m.cmd === c).length, c);

    // ---------- explicit intent: START while running / PAUSE while paused change nothing ----------
    await cmd('set', { duration: 60000, label: 'Match' }); await sleep(300);
    let r = await cmd('start', { force: true }); await sleep(400);
    const run1 = await st();
    r = await cmd('start'); await sleep(400);
    let s = await st();
    check('START on a running match: ok, still running, not restarted', r.ok && s.status === 'running' && s.startAt === run1.startAt, { r, status: s.status });
    r = await cmd('pause'); await sleep(300); const p1 = await st();
    r = await cmd('pause'); await sleep(300); s = await st();
    check('PAUSE on a paused match: ok, still paused, same time left', r.ok && s.status === 'paused' && s.remainingAtPause === p1.remainingAtPause, { r, status: s.status });
    await hideToast(control); await control.evaluate(() => { window.__drop = 'lost'; });
    r = await cmd('start');
    check('#88 a stalled RESUME says RESUME, not START', r.ok === false && /RESUME/.test(r.error) && !/“START”/.test(r.error), r.error);
    await connected(control); await sleep(300);
    await cmd('reset'); await sleep(300);
    r = await cmd('pause');
    check('PAUSE with nothing running is still refused', r.ok === false && /nothing to pause/i.test(r.error), r);

    // ---------- control page: drop after send, not applied ----------
    await hideToast(control); await control.evaluate(() => { window.__sent = []; window.__drop = 'lost'; });
    await control.click('#startBtn'); await sleep(300);
    let t = await toast(control);
    check('control: tap lost in a drop shows a toast (may not have gone through)', !!t && /may not have gone through/i.test(t) && /START/.test(t), t);
    check('control: reconnects after the drop', await connected(control));
    await sleep(1500);
    check('control: lost START is not resent', (await sentOf(control, 'start')) === 1, await control.evaluate(() => window.__sent));
    s = await st();
    check('control: server never started; button re-rendered from server state', s.status === 'idle' && /START/i.test(await control.evaluate(() => document.getElementById('startBtn').textContent)), s.status);

    // ---------- control page: drop after send, applied ----------
    await hideToast(control); await control.evaluate(() => { window.__sent = []; window.__drop = 'applied'; });
    await cmd('start', { force: true }).then(() => {});
    t = await toast(control);
    check('control: drop before the ack also shows the toast', !!t && /may not have gone through/i.test(t), t);
    await connected(control); await sleep(800);
    s = await st();
    check('control: after reconnect the page shows the server state (running once, PAUSE button)', s.status === 'running' && /PAUSE/i.test(await control.evaluate(() => document.getElementById('startBtn').textContent)) && (await sentOf(control, 'start')) === 1, s.status);
    await cmd('reset'); await sleep(300);

    // ---------- no reply at all ----------
    await hideToast(control); await control.evaluate(() => { window.__drop = 'silent'; });
    await control.click('#startBtn'); await sleep(4400);
    t = await toast(control);
    check('control: "No reply" toast says to check before tapping again', !!t && /no reply/i.test(t) && /check the screen before tapping again/i.test(t), t);

    // ---------- control page: START/PAUSE follows the painted button; repeat taps are ignored ----------
    // Taps go through the page's own handlers (button, big digits, Space) a few ms apart, like a quick double tap.
    const tapsJS = ([seq, gap]) => new Promise(res => {
      const fire = w => w === 'space' ? document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))
        : document.getElementById(w === 'time' ? 'time' : 'startBtn').click();
      seq.forEach((w, i) => setTimeout(() => { fire(w); if (i === seq.length - 1) res(); }, i * gap));
    });
    const taps = (seq, gap = 40) => control.evaluate(tapsJS, [seq, gap]);
    const btn = () => control.evaluate(() => document.getElementById('startBtn').textContent);
    await hideToast(control); await cmd('reset'); await sleep(900);
    await control.evaluate(() => { window.__sent = []; });
    await taps(['btn', 'btn']); await sleep(1200);
    s = await st();
    check('double tap START (40 ms apart): match runs, one START sent, no PAUSE', s.status === 'running' && (await sentOf(control, 'start')) === 1 && (await sentOf(control, 'pause')) === 0, { status: s.status, sent: await control.evaluate(() => window.__sent.map(m => m.cmd)) });
    await taps(['time', 'space', 'btn'], 25); await sleep(1200);
    s = await st();
    check('deliberate PAUSE after the guard: one tap pauses, the repeats (digits, Space) are ignored', s.status === 'paused' && (await sentOf(control, 'pause')) === 1 && /RESUME/.test(await btn()), s.status);
    await taps(['space', 'time']); await sleep(1200);
    s = await st();
    check('RESUME double tap (Space + digits): running again, still only one PAUSE ever sent', s.status === 'running' && (await sentOf(control, 'start')) === 2 && (await sentOf(control, 'pause')) === 1, s.status);
    await cmd('reset'); await sleep(900);

    // lost reply: START applied, socket dropped before the ack; retaps before the page re-renders must not pause it
    await hideToast(control); await control.evaluate(() => { window.__sent = []; window.__drop = 'applied'; });
    await taps(['btn', 'btn', 'space'], 30);
    check('control: reconnects after the lost reply', await connected(control)); await sleep(1000);
    s = await st();
    check('lost reply + quick retaps: match running, START sent once, no PAUSE', s.status === 'running' && (await sentOf(control, 'start')) === 1 && (await sentOf(control, 'pause')) === 0 && /PAUSE/.test(await btn()), { status: s.status, sent: await control.evaluate(() => window.__sent.map(m => m.cmd)) });

    // delayed reply: PAUSE swallowed (no ack for 4 s); retaps while it is pending send nothing
    await hideToast(control); await control.evaluate(() => { window.__sent = []; window.__drop = 'silent'; });
    await taps(['btn']); await sleep(150); await taps(['btn', 'time', 'space'], 300); await sleep(4500);
    s = await st();
    check('no reply yet: retaps while waiting send nothing, match still running', s.status === 'running' && (await control.evaluate(() => window.__sent.length)) === 1, await control.evaluate(() => window.__sent.map(m => m.cmd)));
    await sleep(1800); await taps(['btn']); await sleep(800);
    s = await st();
    check('after the timeout and the guard, a deliberate PAUSE tap pauses', s.status === 'paused' && (await sentOf(control, 'pause')) === 2, s.status);
    await cmd('reset'); await sleep(300); await hideToast(control);

    // ---------- control checkboxes: a double click acts on the box as painted, and box and server agree afterwards ----------
    for (const [id, srv] of [['autoAdv', 'FLL.state.match.autoAdvance !== false'], ['brkAuto', '!!(FLL.config.breaks || {}).auto']]) {
      const before = await control.evaluate(new Function('return ' + srv));
      await control.evaluate(id => new Promise(res => { const b = document.getElementById(id); b.click(); setTimeout(() => { b.click(); res(); }, 40); }), id);
      await sleep(900);
      const after = await control.evaluate(new Function('id', `return { box: document.getElementById(id).checked, server: ${srv} }`), id);
      check(`#${id} double click: back where it started, box matches the server`, after.box === before && after.server === before, { before, after });
    }

    // ---------- duplicate tap id: applied once, also across a reconnect ----------
    await control.click('#csvBox summary'); await control.setInputFiles('#csvFile', SAMPLE);
    await waitFor(() => control.evaluate(() => FLL.schedule && FLL.schedule.matches.length === 24));
    await cmd('goto', { index: 0 }); await sleep(300);
    const acks = await control.evaluate(() => new Promise(res => {
      const got = []; const on = ev => { const m = JSON.parse(ev.data); if (m.t === 'ack' && m.id >= 90001) { got.push(m); if (got.length === 2) { FLL.ws.removeEventListener('message', on); res(got); } } };
      FLL.ws.addEventListener('message', on);
      FLL.send({ t: 'cmd', cmd: 'goto', delta: 1, id: 90001, uid: 'ctl.test.dup1' }); FLL.send({ t: 'cmd', cmd: 'goto', delta: 1, id: 90002, uid: 'ctl.test.dup1' });
    }));
    await sleep(300);
    check('same tap id twice: both acked ok, applied once', acks.every(a => a.ok) && (await st()).match.current === 1, { acks, current: (await st()).match.current });
    await control.evaluate(() => FLL._lost(false)); await connected(control);
    await control.evaluate(() => FLL.send({ t: 'cmd', cmd: 'goto', delta: 1, id: 90003, uid: 'ctl.test.dup1' })); await sleep(500);
    check('same tap id after a reconnect is not applied again', (await st()).match.current === 1, (await st()).match.current);
    await control.evaluate(() => FLL.send({ t: 'cmd', cmd: 'goto', delta: 1, id: 90004, uid: 'ctl.test.dup2' })); await sleep(500);
    check('a new tap id is applied', (await st()).match.current === 2);
    await cmd('goto', { index: 0 }); await sleep(300);

    // ---------- referee page: Call Head Ref and READY lost in a drop ----------
    await waitFor(() => control.evaluate(() => !!document.querySelector('#refGrid .rc[data-table="1"] a[href*="k="]')));
    const ref = await mk(await control.evaluate(() => document.querySelector('#refGrid .rc[data-table="1"] a').href), 'window.__DEVICE_ID="r1";', { width: 390, height: 844 });
    await connected(ref); await sleep(800);
    await ref.evaluate(() => { window.__sent = []; window.__drop = 'lost'; });
    await ref.click('#callBtn'); await sleep(300);
    t = await toast(ref);
    check('ref: lost Call Head Ref shows a toast', !!t && /Call Head Ref/.test(t) && /may not have gone through/i.test(t), t);
    await connected(ref); await sleep(1500);
    check('ref: lost Call is not resent and no call reached the server', (await sentOf(ref, 'refCall')) === 1 && !(await control.evaluate(() => FLL.calls && FLL.calls['1'])));
    await hideToast(ref); await waitFor(() => ref.evaluate(() => !document.getElementById('readyBtn').disabled));
    await ref.evaluate(() => { window.__sent = []; window.__drop = 'lost'; });
    await ref.click('#readyBtn'); await sleep(300);
    t = await toast(ref);
    check('ref: lost READY shows a toast', !!t && /READY/.test(t) && /may not have gone through/i.test(t), t);
    await connected(ref); await sleep(1500);
    check('ref: lost READY is not resent and the table is not marked ready', (await sentOf(ref, 'refReady')) === 1 && !(await control.evaluate(() => FLL.isReady(0, '1'))));
    check('ref: READY button re-rendered from server state (not on)', !(await ref.evaluate(() => document.getElementById('readyBtn').classList.contains('on'))));

    // ---------- referee page: READY and Call Head Ref double taps ----------
    const refTaps = (sel, gap = 40) => ref.evaluate(([sel, gap]) => new Promise(res => { const b = document.querySelector(sel); b.click(); setTimeout(() => { b.click(); res(); }, gap); }), [sel, gap]);
    await hideToast(ref); await sleep(800); await ref.evaluate(() => { window.__sent = []; });
    await refTaps('#readyBtn'); await sleep(900);
    check('ref: double tap READY (40 ms apart) leaves the table ready, one READY sent', await control.evaluate(() => FLL.isReady(0, '1')) && (await ref.evaluate(() => window.__sent.filter(m => m.cmd === 'refReady').map(m => m.on).join(','))) === 'true', await ref.evaluate(() => window.__sent));
    await ref.click('#readyBtn'); await sleep(900);
    check('ref: a deliberate tap after the guard undoes READY', !(await control.evaluate(() => FLL.isReady(0, '1'))) && !(await ref.evaluate(() => document.getElementById('readyBtn').classList.contains('on'))));
    // The READY taps above leave refReady, refReady in the log. Clear before the Call taps so this check
    // only sees the call commands. The call reaches the control page when the server broadcasts it, which
    // can be after a fixed sleep (#68); wait for that instead. The broadcast is sent before the ack, and the
    // ref page then ignores taps for quietMs (600) after the ack. Once the button shows the call, wait past
    // that quiet period so the next tap is the deliberate cancel.
    await ref.evaluate(() => { window.__sent = []; });
    await refTaps('#callBtn');
    const callOpen = await waitFor(() => control.evaluate(() => !!(FLL.calls && FLL.calls['1'])));
    check('ref: double tap Call Head Ref leaves the call open, no cancel sent', callOpen && (await sentOf(ref, 'refCall')) === 1 && (await sentOf(ref, 'refCancel')) === 0, await ref.evaluate(() => window.__sent.map(m => m.cmd)));
    await waitFor(() => ref.evaluate(() => /Head Ref called/.test(document.getElementById('callBtn').textContent)));
    await sleep(700);
    await ref.click('#callBtn');
    const callCleared = await waitFor(() => control.evaluate(() => !(FLL.calls && FLL.calls['1'])));
    check('ref: a deliberate tap after the guard cancels the call', callCleared && (await sentOf(ref, 'refCancel')) === 1, await ref.evaluate(() => window.__sent.map(m => m.cmd)));

    // ---------- #88: a START the phone has given up on must not start the match later ----------
    // No schedule, so START is not held for "ahead" or "not ready". Long duration so the run cannot end mid-check.
    await cmd('scheduleClear'); await cmd('reset'); await cmd('set', { duration: 120000, label: 'Match' }); await sleep(200);
    const raw = await openRaw(PORT);
    const snap = () => ({ status: raw.box.state.status, startAt: raw.box.state.startAt, runId: raw.box.state.runId || 0, kind: raw.box.state.kind });
    const after = async (p) => { const ack = await p; await sleep(150); return Object.assign({ ack }, snap()); };
    let sNow = await raw.serverNow();
    let got = await after(raw.cmd('start', { force: true, sentAt: sNow - 2200 }));
    check('#88 START aged 2.2s (inside the 2.5s limit) starts once', got.ack.ok && got.status === 'running' && got.runId >= 1, { ok: got.ack.ok, err: got.ack.error, status: got.status, runId: got.runId });
    const insideRun = snap();
    got = await after(raw.cmd('start', { force: true, sentAt: await raw.serverNow() }));
    check('#88 a second fresh START does not restart the match', got.status === 'running' && got.startAt === insideRun.startAt && got.runId === insideRun.runId, { before: insideRun, after: snap() });
    await raw.cmd('reset'); await sleep(150);
    sNow = await raw.serverNow();
    got = await after(raw.cmd('start', { force: true, sentAt: sNow - 4000 }));
    check('#88 START aged 4s (past the limit) does not start', got.ack.ok === false && got.ack.code === 'late' && /not started/i.test(got.ack.error || '') && /press START again/i.test(got.ack.error || '') && got.status !== 'running', { ack: got.ack, status: got.status });
    const beforeRetry = snap().runId;
    const retry = await after(raw.cmd('start', { force: true, sentAt: await raw.serverNow() }));
    check('#88 retry after a rejected stale START starts exactly once', retry.ack.ok && retry.status === 'running' && retry.runId === beforeRetry + 1, { ack: retry.ack.ok, status: retry.status, runId: retry.runId, beforeRetry });
    const retryAt = snap();
    got = await after(raw.cmd('start', { force: true, sentAt: (await raw.serverNow()) - 10000 }));
    check('#88 stale START arriving after the retry does not move startAt', got.status === 'running' && got.startAt === retryAt.startAt && got.runId === retryAt.runId, { before: retryAt, after: snap(), ack: got.ack });
    await raw.cmd('reset'); await sleep(150);
    // The other order: the stalled original is processed first (rejected), then the fresh retry.
    sNow = await raw.serverNow();
    const staleFirst = await after(raw.cmd('start', { force: true, sentAt: sNow - 10000 }));
    const freshSecond = await after(raw.cmd('start', { force: true, sentAt: await raw.serverNow() }));
    check('#88 stale START then a fresh retry: exactly one start', staleFirst.ack.ok === false && staleFirst.status !== 'running' && freshSecond.ack.ok && freshSecond.status === 'running' && freshSecond.runId === staleFirst.runId + 1, { stale: staleFirst.ack, fresh: { ok: freshSecond.ack.ok, status: freshSecond.status, runId: freshSecond.runId } });
    const one = snap();
    got = await after(raw.cmd('start', { force: true, sentAt: await raw.serverNow() }));
    check('#88 another START after that retry still does not move startAt', got.startAt === one.startAt && got.runId === one.runId, { before: one, after: snap() });
    // pause / abort / end share the timer path. A late one must not change the field.
    const running = snap();
    got = await after(raw.cmd('pause', { sentAt: (await raw.serverNow()) - 10000 }));
    check('#88 a late PAUSE does not pause', got.ack.ok === false && got.ack.code === 'late' && snap().status === 'running' && snap().startAt === running.startAt, { ack: got.ack, status: snap().status });
    got = await after(raw.cmd('reset', { sentAt: (await raw.serverNow()) - 10000 }));
    check('#88 a late RESET / ABORT does not abort', got.ack.ok === false && got.ack.code === 'late' && snap().status === 'running' && snap().startAt === running.startAt && snap().runId === running.runId, { ack: got.ack, status: snap().status });
    await raw.cmd('pause', { sentAt: await raw.serverNow() }); await sleep(150);
    check('#88 a fresh PAUSE still pauses', snap().status === 'paused');
    await raw.cmd('reset'); await sleep(100);
    got = await after(raw.cmd('breakStart', { duration: 120000, sentAt: await raw.serverNow() }));
    check('#88 setup: a break is running', got.ack.ok && snap().kind === 'break' && snap().status === 'running', { ack: got.ack, snap: snap() });
    const brk = snap();
    got = await after(raw.cmd('breakEnd', { sentAt: (await raw.serverNow()) - 10000 }));
    check('#88 a late END BREAK does not end the break', got.ack.ok === false && got.ack.code === 'late' && snap().kind === 'break' && snap().status === 'running' && snap().startAt === brk.startAt, { ack: got.ack, snap: snap() });
    got = await after(raw.cmd('endSession', { sentAt: (await raw.serverNow()) - 10000 }));
    check('#88 a late End match session does not change the break', got.ack.ok === false && got.ack.code === 'late' && snap().kind === 'break' && snap().startAt === brk.startAt, { ack: got.ack, snap: snap() });
    await raw.cmd('reset'); await sleep(150);
    check('#88 a START with no timestamp still starts (older pages)', (await after(raw.cmd('start', { force: true }))).status === 'running', snap().status);
    await raw.cmd('reset'); await sleep(200);
    raw.close();

    // Phone: LAN, a slowed send still inside the window, and a tunnel-sized delay.
    await hideToast(control);
    await waitFor(() => control.evaluate(() => FLL.haveClock && FLL.state && FLL.state.status === 'idle'));
    await control.evaluate(() => { window.__sent = []; window.__delayCmd = 0; });
    await control.click('#startBtn');
    check('#88 LAN START starts once', await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 4000) && (await sentOf(control, 'start')) === 1, await control.evaluate(() => ({ status: FLL.state && FLL.state.status, sent: window.__sent })));
    const lanSent = await control.evaluate(() => window.__sent.find(m => m.cmd === 'start'));
    check('#88 LAN START is stamped with the synced server clock, not an unstamped tap', !!lanSent && typeof lanSent.sentAt === 'number' && Math.abs(lanSent.sentAt - Date.now()) < 5000, lanSent && lanSent.sentAt);
    const lanAt = (await st()).startAt;
    await sleep(800);
    check('#88 LAN START startAt stays put', (await st()).startAt === lanAt && (await st()).status === 'running');
    await cmd('reset'); await sleep(400);
    await control.evaluate(() => { window.__sent = []; window.__delayCmd = 1200; });
    await control.click('#startBtn');
    check('#88 START delivered about 1.2s later (inside the window) starts once', await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 5000) && (await sentOf(control, 'start')) === 1, await control.evaluate(() => ({ status: FLL.state && FLL.state.status, n: window.__sent.length })));
    await control.evaluate(() => { window.__delayCmd = 0; });
    await cmd('reset'); await sleep(300);
    const tunnel = await mk(`${BASE}/control`, 'window.__SIM_DELAY=500;window.__DEVICE_ID="tun88";');
    await tunnel.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await tunnel.fill('#pinInput', PIN); await tunnel.click('#pinBtn');
    await tunnel.waitForSelector('#pinModal.hidden', { state: 'attached' });
    await waitFor(() => tunnel.evaluate(() => FLL.haveClock && FLL.connected));
    await tunnel.evaluate(() => { window.__sent = []; });
    await tunnel.click('#startBtn');
    check('#88 tunnel-sized delay (up to 500 ms each way) starts once', await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 5000) && (await sentOf(tunnel, 'start')) === 1, await tunnel.evaluate(() => window.__sent.map(m => m.cmd)));
    await cmd('reset'); await sleep(300);

    // Open socket, command held past the limit: the ack itself tells the phone it did not start.
    await hideToast(control);
    await control.evaluate(() => { window.__sent = []; window.__delayCmd = 3200; });
    await control.click('#startBtn');
    const lateToast = await waitFor(async () => { const x = await toast(control); return !!x && /not started/i.test(x) && /press START again/i.test(x); }, 6000);
    t = await toast(control);
    check('#88 START delivered after the limit is rejected and the phone says it was not started', lateToast && (await st()).status !== 'running' && /START/i.test(await control.evaluate(() => document.getElementById('startBtn').textContent)), { toast: t, status: (await st()).status });
    await control.evaluate(() => { window.__delayCmd = 0; });
    await sleep(800);   // tap guard after the refusal
    await hideToast(control);
    await control.evaluate(() => { window.__sent = []; });
    await control.click('#startBtn');
    check('#88 pressing START again after that rejection starts exactly once', await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 4000) && (await sentOf(control, 'start')) === 1, await control.evaluate(() => ({ status: FLL.state && FLL.state.status, sent: window.__sent.map(m => m.cmd) })));
    const againAt = (await st()).startAt, againRun = (await st()).runId;
    await sleep(500);
    check('#88 that retry did not start twice', (await st()).startAt === againAt && (await st()).runId === againRun && (await sentOf(control, 'start')) === 1);
    await cmd('reset'); await sleep(300);

    // Stalling proxy: bytes are accepted and delivered only after the phone has given up (heartbeat).
    const proxy = stallProxy(PORT);
    const pport = await proxy.listen();
    const phone = await mk(`http://127.0.0.1:${pport}/control`, 'window.__DEVICE_ID="stall88";', { width: 390, height: 844 });
    await phone.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await phone.fill('#pinInput', PIN); await phone.click('#pinBtn');
    await phone.waitForSelector('#pinModal.hidden', { state: 'attached' });
    check('#88 phone through the proxy syncs', await waitFor(() => phone.evaluate(() => FLL.haveClock && FLL.connected && FLL.state && FLL.state.status === 'idle')));
    await hideToast(phone);
    await phone.evaluate(() => { window.__sent = []; });
    const runBefore = (await st()).runId || 0;
    proxy.stall();
    const tTap = Date.now();
    await phone.click('#startBtn');
    await sleep(200);
    const heldStart = await phone.evaluate(() => { const m = (window.__sent || []).find(x => x.cmd === 'start'); return m ? { n: window.__sent.length, sentAt: m.sentAt } : null; });
    check('#88 stalled START left the phone and is stamped', !!heldStart && heldStart.n === 1 && typeof heldStart.sentAt === 'number' && proxy.heldBytes() > 0, { heldStart, bytes: proxy.heldBytes() });
    const gaveUp = await waitFor(async () => { const x = await toast(phone); return !!x && (/may not have gone through/i.test(x) || /did not start|not started/i.test(x)) && /START/.test(x); }, 7000);
    check('#88 stalled link: phone gives up on START', gaveUp, await toast(phone));
    const remain = 6500 - (Date.now() - tTap);
    if (remain > 0) await sleep(remain);
    proxy.release();
    const cleared = await waitFor(async () => { const x = await toast(phone); return !!x && /not started|did not start/i.test(x) && /press START again/i.test(x); }, 8000);
    s = await st();
    t = await toast(phone);
    const phoneIdle = await phone.evaluate(() => ({ status: FLL.state && FLL.state.status, btn: document.getElementById('startBtn').textContent, conn: FLL.connected }));
    check('#88 stalled START delivered after give-up does not start the match', s.status !== 'running' && (s.runId || 0) === runBefore && /START/i.test(phoneIdle.btn) && phoneIdle.status !== 'running', { server: s.status, run: s.runId, phone: phoneIdle });
    check('#88 phone shows the match was not started and to press START again', cleared && !!t && /not started|did not start/i.test(t) && /press START again/i.test(t), t);
    await waitFor(() => phone.evaluate(() => FLL.connected && FLL.state && FLL.state.status !== 'running'), 8000);
    await sleep(1800);   // past the tap guard that follows give-up
    await hideToast(phone);
    await phone.evaluate(() => { window.__sent = []; });
    await phone.click('#startBtn');
    const restarted = await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 5000);
    s = await st();
    check('#88 one more START after the stalled one was rejected starts exactly once', restarted && s.status === 'running' && (s.runId || 0) === runBefore + 1 && (await sentOf(phone, 'start')) === 1, { status: s.status, runId: s.runId, sent: await phone.evaluate(() => window.__sent.map(m => m.cmd)) });
    // Other order, on a new stall: the retry is delivered first, then the original. startAt must stay.
    await cmd('reset'); await sleep(400);
    await waitFor(() => phone.evaluate(() => FLL.connected && FLL.state && FLL.state.status === 'idle' && /START/i.test(document.getElementById('startBtn').textContent)));
    await sleep(1200);   // the phone's tap guard (600 ms after the previous START) must be clear before this stall
    await hideToast(phone);
    await phone.evaluate(() => { window.__sent = []; });
    const run0 = (await st()).runId || 0;
    proxy.stall();
    await phone.click('#startBtn');
    await sleep(300);
    check('#88 second stall held a START', proxy.heldBytes() > 0 && (await sentOf(phone, 'start')) === 1, proxy.heldBytes());
    check('#88 second stall: phone gives up', await waitFor(async () => /may not have gone through/i.test((await toast(phone)) || ''), 7000), await toast(phone));
    check('#88 phone reconnects while the first START is still held', await waitFor(() => phone.evaluate(() => FLL.connected && FLL.state && FLL.state.status !== 'running'), 8000));
    await sleep(1800);
    await phone.evaluate(() => { window.__sent = []; });
    await phone.click('#startBtn');
    const retryFirst = await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 5000);
    s = await st();
    const midAt = s.startAt, midRun = s.runId;
    proxy.release();
    await sleep(800);
    s = await st();
    check('#88 retry arrives first, then the stalled START: one start and startAt unchanged', retryFirst && s.status === 'running' && s.startAt === midAt && s.runId === midRun && s.runId === run0 + 1, { midAt, midRun, end: { status: s.status, startAt: s.startAt, runId: s.runId }, run0 });

    // The stall is already underway when the ref taps. The heartbeat is counting from the unanswered ping, so it used to
    // report failure while sentAt was still inside the server's 2.5 s window, and the released START then started the match.
    await cmd('reset'); await sleep(400);
    await waitFor(() => phone.evaluate(() => FLL.connected && FLL.state && FLL.state.status === 'idle' && /START/i.test(document.getElementById('startBtn').textContent)));
    await sleep(1200);
    await hideToast(phone);
    await phone.evaluate(() => { window.__sent = []; });
    const preRun = (await st()).runId || 0;
    proxy.stall();
    await sleep(1600);
    const preTap = Date.now();
    await phone.click('#startBtn');
    await sleep(1000);
    const earlyToast = await toast(phone);
    check('#88 pre-stalled: no failure toast while the START is still inside the server window', !(earlyToast && /may not have gone through|did not start|not started/i.test(earlyToast)), earlyToast);
    const untilRelease = 2300 - (Date.now() - preTap);
    if (untilRelease > 0) await sleep(untilRelease);
    proxy.release();
    const preStarted = await waitFor(() => control.evaluate(() => FLL.state && FLL.state.status === 'running'), 5000);
    s = await st();
    t = await toast(phone);
    const preBtn = await phone.evaluate(() => document.getElementById('startBtn').textContent);
    check('#88 pre-stalled START released inside the window starts once and the phone agrees', preStarted && s.status === 'running' && (s.runId || 0) === preRun + 1 && /PAUSE/i.test(preBtn) && !(t && /may not have gone through|did not start|not started/i.test(t)), { status: s.status, runId: s.runId, btn: preBtn, toast: t });
    await proxy.close();
  } catch (e) { console.log('ERROR', e && e.stack || e); failed++; }
  await browser.close(); await new Promise(r => { srv.once('exit', r); srv.kill(); });
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
