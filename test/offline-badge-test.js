// Offline badge (FLL-004): a display that loses the timer server shows a small "OFFLINE – time may be off" badge in a
// corner (not over the clock) while it is disconnected, and hides it again on reconnect.   node test/offline-badge-test.js
// #54: a display whose device is offline (no network) plays no local-clock cue (no 30 s warning, holds at 0:00 without END);
// on reconnect the server state wins and nothing plays late or twice.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 8095, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-offline-'));
  let srv = null;
  async function startServer() {
    srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  }
  const stopServer = () => new Promise(r => { srv.once('exit', r); srv.kill(); });
  await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
  try {
    const pages = {};
    for (const role of ['main', 'timer']) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', role, e.message); failed++; });
      await p.goto(`${BASE}/display?role=${role}&autostart=1&fs=0`); pages[role] = p;
    }
    const shown = p => p.evaluate(() => { const el = document.getElementById('offline'); return !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0; });
    for (const [role, p] of Object.entries(pages)) {
      check(`${role}: connects`, await waitFor(() => p.evaluate(() => FLL.connected && !!FLL.state)));
      check(`${role}: no offline badge while connected`, !(await shown(p)));
    }
    // Run a match so the clock is on screen during the outage.
    const control = await (await browser.newContext()).newPage();
    await control.goto(`${BASE}/control`);
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    await control.evaluate(() => FLL.cmd('set', { duration: 150000, label: 'Match' })); await sleep(300);
    await control.evaluate(() => FLL.cmd('start', { force: true })); await sleep(1500);

    await stopServer();
    for (const [role, p] of Object.entries(pages)) {
      check(`${role}: badge shows while the socket is down`, await waitFor(() => shown(p), 5000));
      const info = await p.evaluate(() => {
        const b = document.getElementById('offline').getBoundingClientRect(), t = document.getElementById('time');
        const c = t && t.getBoundingClientRect();
        const overlap = c ? !(b.right <= c.left || b.left >= c.right || b.bottom <= c.top || b.top >= c.bottom) : null;
        return { text: document.getElementById('offline').textContent, overlap, corner: b.right > innerWidth - 60 && b.bottom > innerHeight - 120, px: parseFloat(getComputedStyle(document.getElementById('offline')).fontSize) };
      });
      check(`${role}: badge says OFFLINE and time may be off`, /OFFLINE/.test(info.text) && /time may be off/i.test(info.text), info.text);
      check(`${role}: badge sits in the bottom-right corner, not over the clock, readable size`, info.corner && info.overlap === false && info.px >= 14, info);
      check(`${role}: clock keeps counting while offline`, await p.evaluate(() => new Promise(res => { const a = document.getElementById('time').textContent; setTimeout(() => res(a !== document.getElementById('time').textContent), 1500); })));
    }
    await startServer();
    for (const [role, p] of Object.entries(pages)) {
      check(`${role}: reconnects`, await waitFor(() => p.evaluate(() => FLL.connected), 15000));
      check(`${role}: badge hides on reconnect`, await waitFor(async () => !(await shown(p)), 3000));
    }

    // ---------- #54: device offline (no network) while the match is paused: no END from the local clock ----------
    const dctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await dctx.addInitScript(() => { window.__HB_MS = 1200; window.__DEVICE_ID = 'off54'; });
    const d = await dctx.newPage(); d.on('pageerror', e => { console.log('PAGE ERROR off54', e.message); failed++; });
    await d.goto(`${BASE}/display?role=timer&autostart=1&fs=0`);
    await waitFor(() => control.evaluate(() => FLL.connected && FLL.authed));
    check('#54 display connects and syncs', await waitFor(() => d.evaluate(() => FLL.connected && FLL.synced)));
    const view = () => d.evaluate(() => {
      const t = document.getElementById('time'), b = document.querySelector('.banner');
      return { text: t && t.textContent, done: !!t && t.classList.contains('done'), banner: b ? b.textContent : '', ends: window.__cues.filter(c => c.name === 'end').length,
        connected: FLL.connected, offline: FLL.offline, status: FLL.state && FLL.state.status, flash: document.body.classList.contains('flash-end') };
    });
    const cmd = (c, x) => control.evaluate(([c, x]) => FLL.cmd(c, x), [c, x]);
    await cmd('reset'); await cmd('set', { duration: 8000, label: 'Match' }); await sleep(300);
    await d.evaluate(() => { window.__cues = []; document.body.classList.remove('flash-end'); });
    await cmd('start', { force: true }); await sleep(800);
    await dctx.setOffline(true);
    check('#54 display goes offline (badge, offline flag)', await waitFor(() => d.evaluate(() => !FLL.connected && FLL.offline && !document.getElementById('offline').classList.contains('hidden')), 6000));
    const pz = await cmd('pause');
    const paused = await control.evaluate(() => FLL.state.remainingAtPause);
    check('#54 match paused on the server while the display is offline', pz.ok && paused > 0, { pz, paused });
    check('#54 offline display counts down locally to 0:00', await waitFor(async () => (await view()).text === '0:00', 8000), await view());
    await sleep(800);
    let v = await view();
    check('#54 at 0:00 offline: no END sound, no "Time!", no ended style', v.ends === 0 && !v.done && !/time/i.test(v.banner) && !v.flash && v.status === 'running', v);
    await dctx.setOffline(false);
    check('#54 reconnects after the network comes back', await waitFor(() => d.evaluate(() => FLL.connected && !FLL.offline && FLL.state.status === 'paused'), 10000));
    await sleep(500);
    v = await view();
    const want = await d.evaluate(() => FLL.fmt(FLL.state.remainingAtPause));
    check('#54 after reconnect the server wins: paused time shown, still no END', v.status === 'paused' && v.text === want && /paused/i.test(v.banner) && v.ends === 0, { v, want });

    // The match really ends while the display is offline: END plays exactly once, after the server confirms.
    await d.evaluate(() => { window.__cues = []; });
    await cmd('start', { force: true }); await sleep(500);
    await dctx.setOffline(true);
    await waitFor(() => d.evaluate(() => !FLL.connected && FLL.offline), 6000);
    await waitFor(async () => (await view()).text === '0:00', 8000); await sleep(1000);
    v = await view();
    check('#54 match ends while offline: display holds at 0:00 silently', v.text === '0:00' && v.ends === 0 && !v.done, v);
    await dctx.setOffline(false);
    check('#54 reconnects and gets the ended state', await waitFor(() => d.evaluate(() => FLL.connected && FLL.state.status === 'done'), 10000));
    await sleep(1500);
    v = await view();
    check('#54 server says ended: END plays exactly once', v.ends === 1, v);

    // Offline past the 30 s mark while paused: no warning from the local clock, and no late warning on reconnect.
    const warns = () => d.evaluate(() => window.__cues.filter(c => c.name === 'warn').length);
    await cmd('reset'); await cmd('set', { duration: 36000, label: 'Match' }); await sleep(300);
    await d.evaluate(() => { window.__cues = []; });
    await cmd('start', { force: true }); await sleep(500);
    await dctx.setOffline(true);
    check('#54 warn: display goes offline above 0:30', await waitFor(() => d.evaluate(() => !FLL.connected && FLL.offline), 6000) && (await d.evaluate(() => FLL.remaining())) > 31000, await view());
    const pz2 = await cmd('pause');
    check('#54 warn: match paused on the server above 0:30', pz2.ok && (await control.evaluate(() => FLL.state.remainingAtPause)) > 30000, pz2);
    check('#54 warn: offline display counts past 0:30 locally', await waitFor(() => d.evaluate(() => FLL.remaining() < 29000), 8000), await view());
    await sleep(500);
    check('#54 warn: no 30 s warning sound while offline', (await warns()) === 0, await d.evaluate(() => window.__cues.map(c => c.name)));
    await d.evaluate(() => { window.__cues = []; });   // START played live (online) before the drop; count only what plays from here on
    await dctx.setOffline(false);
    check('#54 warn: reconnects to the paused state', await waitFor(() => d.evaluate(() => FLL.connected && !FLL.offline && FLL.state.status === 'paused'), 10000));
    await sleep(1500);
    v = await view();
    check('#54 warn: no late warning (or any cue) on reconnect, paused time shown', (await warns()) === 0 && v.status === 'paused' && /paused/i.test(v.banner) &&
      (await d.evaluate(() => window.__cues.length)) === 0, { v, cues: await d.evaluate(() => window.__cues.map(c => c.name)) });
    await dctx.close();
  } catch (e) { console.log('ERROR', e && e.stack || e); failed++; }
  await browser.close(); if (srv && srv.exitCode == null) await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
