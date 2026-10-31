// WebKit (Safari engine) real-mouse click reliability on the control page.
// Desktop and iOS Safari drop a click when the pressed element's contents are
// replaced between mousedown and mouseup. The control page used to rewrite the
// START/PAUSE label and the big time digits every animation frame; Chromium
// still delivers that click, so the headless-Chrome suite never caught it.
//   npm run test:webkit
//   PWBROWSER=chromium npm run test:webkit   # same clicks in Chrome (CHROME= path)
//   ROUNDS=30                                 # clicks per button group (default 30)
// Install WebKit once: npx --prefix test playwright-core install --with-deps webkit
const { webkit, chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const ROUNDS = +process.env.ROUNDS || 30;
const TAP_GUARD_MS = 700;
const BROWSER = process.env.PWBROWSER || 'webkit';
const PIN = '4321';
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hold = () => 50 + Math.random() * 100;
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(err => err ? rej(err) : res(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-webkit-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(port), '--pin', PIN, '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.errText = '';
  srv.stderr.on('data', d => { srv.errText += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout\n' + (srv.errText || ''))), 8000);
    srv.stdout.on('data', d => { if (/Control/.test(d)) { clearTimeout(t); res(); } });
    srv.once('exit', code => { clearTimeout(t); rej(new Error('server exited ' + code + '\n' + srv.errText)); });
  });
  return { srv, base: `http://127.0.0.1:${port}` };
}

function launchBrowser() {
  if (BROWSER === 'chromium') {
    return chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  }
  if (BROWSER !== 'webkit') throw new Error('PWBROWSER must be webkit or chromium');
  return webkit.launch();
}

(async () => {
  console.log(`== ${BROWSER} · ${ROUNDS} rounds`);
  let S, browser;
  const report = {};
  try {
    S = await startServer();
    try { browser = await launchBrowser(); }
    catch (e) {
      if (BROWSER === 'webkit' && /Executable doesn't exist|browserType\.launch/i.test(e.message))
        e.message += '\nInstall WebKit: npx --prefix test playwright-core install --with-deps webkit';
      throw e;
    }
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGEERROR', e.message));
    p.on('dialog', d => d.accept());   // abort confirm()
    await p.goto(S.base + '/control');
    await p.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await p.fill('#pinInput', PIN); await p.click('#pinBtn');
    await p.waitForSelector('#pinModal.hidden', { state: 'attached' });
    await p.evaluate(() => { window.__acks = []; const o = FLL.cmd.bind(FLL); FLL.cmd = (c, e) => o(c, e).then(r => { window.__acks.push({ cmd: c, ok: r.ok, error: r.error }); return r; }); });
    const cmd = (c, e) => p.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const st = () => p.evaluate(() => ({ status: FLL.state.status, kind: FLL.state.kind, duration: FLL.state.duration, current: FLL.state.match.current, seq: FLL.state.seq }));
    const acks = () => p.evaluate(() => window.__acks.length);
    const lastAck = () => p.evaluate(() => window.__acks[window.__acks.length - 1]);
    const waitFor = async (fn, ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(30); } return false; };
    // real mouse: move to element, hold 50-150 ms, release. Playwright's locator.click()
    // is a short tap and does not reproduce the Safari miss.
    const press = async sel => { await p.locator(sel).scrollIntoViewIfNeeded({ timeout: 3000 }); await sleep(50); const b = await p.locator(sel).boundingBox(); if (!b) throw new Error('no box ' + sel); await p.mouse.move(b.x + b.width / 2 + (Math.random() * 10 - 5), b.y + b.height / 2 + (Math.random() * 6 - 3)); await p.mouse.down(); await sleep(hold()); await p.mouse.up(); };
    // one click must (a) produce a new ack with ok:true and (b) change state as expected.
    // Confirm "No" is the exception: it only closes the dialog, so it has no server ack.
    async function clickExpect(group, sel, expectFn, wantCmd) {
      const r = report[group] = report[group] || { clicks: 0, missed: 0, badAck: 0, misses: [] };
      if (!r.clicks) console.log('  .. ' + group);
      const a0 = await acks(), s0 = await st();
      if (/^#(startBtn|time)$/.test(sel)) await sleep(TAP_GUARD_MS);   // the control page ignores START/PAUSE repeats for ~600 ms
      try { await press(sel); } catch (e) { r.clicks++; r.missed++; r.misses.push({ n: r.clicks, error: 'not clickable: ' + e.message.split('\n')[0], before: s0 }); return; }
      r.clicks++;
      const gotAck = await waitFor(async () => (await acks()) > a0);
      const la = gotAck ? await lastAck() : null;
      const okState = await waitFor(async () => expectFn(s0, await st()));
      if (!gotAck || !okState) { r.missed++; r.misses.push({ n: r.clicks, gotAck, ack: la, before: s0, after: await st() }); }
      else if (!la.ok || (wantCmd && la.cmd !== wantCmd)) { r.badAck++; r.misses.push({ n: r.clicks, ack: la }); }
    }
    await p.evaluate(async t => FLL.cmd('scheduleCSV', { text: t, name: 's' }), fs.readFileSync(SAMPLE, 'utf8'));
    await cmd('scheduleShift', { index: 0, time: Date.now() + 60000 });
    await cmd('set', { duration: 150000 }); await sleep(300);
    const toggled = (a, b) => a.status !== b.status && (b.status === 'running' || b.status === 'paused');

    // (1) START, then PAUSE/RESUME xROUNDS on the button, then xROUNDS on the big #time digits (while running)
    await clickExpect('START (first)', '#startBtn', (a, b) => b.status === 'running', 'start');
    for (let i = 0; i < ROUNDS; i++) { await clickExpect('#startBtn PAUSE/RESUME', '#startBtn', toggled); await sleep(80 + Math.random() * 200); }
    for (let i = 0; i < ROUNDS; i++) { await clickExpect('#time digits PAUSE/RESUME', '#time', toggled); await sleep(80 + Math.random() * 200); }
    // digits only change every second; force clicks right across a second boundary on #time
    for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
      if ((await st()).status !== 'running') await cmd('start');
      await p.evaluate(() => new Promise(res => { const t0 = performance.now(); const tick = () => { const r = FLL.remaining(); if (r % 1000 > 920 || performance.now() - t0 > 3000) return res(); requestAnimationFrame(tick); }; tick(); }));
      await clickExpect('#time click straddling a digit change', '#time', toggled); await sleep(100);
    }
    if ((await st()).status !== 'idle') await cmd('reset');
    await sleep(200);

    // (2a) RESET (abort, confirm() accepted) while running
    for (let i = 0; i < Math.ceil(ROUNDS / 3); i++) {
      await cmd('start', { force: true }); await sleep(300 + Math.random() * 400);
      await clickExpect('#resetBtn ABORT while running', '#resetBtn', (a, b) => b.status === 'idle', 'reset');
    }
    // (2b) #resetBtn as END BREAK, and #breakEndBtn, during a field break
    for (let i = 0; i < Math.ceil(ROUNDS / 3); i++) {
      await cmd('breakStart', { duration: 60000 }); await sleep(300 + Math.random() * 400);
      await clickExpect('#resetBtn END BREAK', '#resetBtn', (a, b) => b.kind === 'match', 'breakEnd');
      await cmd('breakStart', { duration: 60000 }); await sleep(300 + Math.random() * 400);
      await clickExpect('#breakEndBtn', '#breakEndBtn', (a, b) => b.kind === 'match', 'breakEnd');
    }
    // (2c) START MATCH during a break (startBtn label 'START MATCH')
    for (let i = 0; i < Math.ceil(ROUNDS / 3); i++) {
      await cmd('breakStart', { duration: 60000 }); await sleep(300 + Math.random() * 400);
      await clickExpect('#startBtn START MATCH during break', '#startBtn', (a, b) => b.kind === 'match' && b.status === 'running');
      await cmd('reset'); await sleep(150);
    }
    // (2d) prev / next while idle
    await cmd('goto', { index: 5 }); await sleep(200);
    for (let i = 0; i < Math.ceil(ROUNDS / 2); i++) {
      await clickExpect('#nextBtn', '#nextBtn', (a, b) => b.current === a.current + 1, 'goto');
      await clickExpect('#prevBtn', '#prevBtn', (a, b) => b.current === a.current - 1, 'goto');
    }
    // (2e) presets
    const presets = await p.$$eval('#presets button', bs => bs.map((b, i) => ({ i, ms: +b.dataset.ms })));
    for (let i = 0; i < ROUNDS; i++) {
      const pr = presets[i % presets.length];
      if ((await st()).duration === pr.ms) await cmd('set', { duration: 7000 });
      await sleep(80);
      await clickExpect('#presets buttons', `#presets button >> nth=${pr.i}`, (a, b) => b.duration === pr.ms, 'set');
    }
    // (2f) ahead-of-schedule confirm modal: No, then Yes
    await cmd('set', { duration: 150000 }); await cmd('goto', { index: 0 });
    await cmd('scheduleShift', { index: 0, time: Date.now() + 15 * 60000 }); await sleep(300);
    const modalOpen = () => p.evaluate(() => !document.getElementById('confirmModal').classList.contains('hidden'));
    const rm = report['confirm modal'] = { clicks: 0, missed: 0, badAck: 0, misses: [] };
    for (let i = 0; i < Math.ceil(ROUNDS / 3); i++) {
      for (const which of ['#confirmNo', '#confirmYes']) {
        if ((await st()).status !== 'idle') { await cmd('reset'); await sleep(150); }
        await sleep(TAP_GUARD_MS); await press('#startBtn');
        if (!(await waitFor(modalOpen))) { rm.clicks++; rm.missed++; rm.misses.push({ n: rm.clicks, step: 'START did not open modal' }); continue; }
        await sleep(100);
        const a0 = await acks(); await press(which); rm.clicks++;
        const closed = await waitFor(async () => !(await modalOpen()));
        const ok = which === '#confirmNo' ? closed && (await st()).status === 'idle' : closed && await waitFor(async () => (await acks()) > a0 && (await st()).status === 'running');
        if (!ok) { rm.missed++; rm.misses.push({ n: rm.clicks, which, closed, state: await st() }); }
      }
    }
    await cmd('reset');
  } catch (e) { console.error(e.message.split('\n')[0]); check('script error', false, e.message.split('\n')[0]); }
  finally {
    for (const [g, r] of Object.entries(report)) check(`${g}: ${r.clicks - r.missed - r.badAck}/${r.clicks} clicks registered`, r.missed === 0 && r.badAck === 0, r.missed || r.badAck ? { missed: r.missed, badAck: r.badAck, firstMisses: r.misses.slice(0, 2) } : undefined);
    if (failed) {
      try { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `webkit-clicks-${BROWSER}.json`), JSON.stringify(report, null, 1)); } catch (e) {}
    }
    try { if (browser) await browser.close(); } catch (e) {}
    if (S && S.srv && S.srv.exitCode == null) S.srv.kill('SIGKILL');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
