// Offline badge (FLL-004): a display that loses the timer server shows a small "OFFLINE – time may be off" badge in a
// corner (not over the clock) while it is disconnected, and hides it again on reconnect.   node test/offline-badge-test.js
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
  } catch (e) { console.log('ERROR', e && e.stack || e); failed++; }
  await browser.close(); if (srv && srv.exitCode == null) await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
