// Lost taps (#46): a command whose connection drops before the reply shows a toast and is never resent; "No reply" tells you to
// check before tapping again; a repeated tap id is applied once (also across a reconnect); START while running / PAUSE while
// paused change nothing.   node test/lost-tap-test.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
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
      if (how === 'lost' || how === 'silent') return; }
    return o.call(this, d); }; })();`;

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-losttap-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
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
    await refTaps('#callBtn'); await sleep(900);
    check('ref: double tap Call Head Ref leaves the call open, no cancel sent', !!(await control.evaluate(() => FLL.calls && FLL.calls['1'])) && (await sentOf(ref, 'refCall')) === 1 && (await sentOf(ref, 'refCancel')) === 0, await ref.evaluate(() => window.__sent.map(m => m.cmd)));
    await ref.click('#callBtn'); await sleep(900);
    check('ref: a deliberate tap after the guard cancels the call', !(await control.evaluate(() => FLL.calls && FLL.calls['1'])) && (await sentOf(ref, 'refCancel')) === 1);
  } catch (e) { console.log('ERROR', e && e.stack || e); failed++; }
  await browser.close(); await new Promise(r => { srv.once('exit', r); srv.kill(); });
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
