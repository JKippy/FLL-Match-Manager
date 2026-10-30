// End-to-end sync test: 1 control + 3 displays (with fake clock skew and random network delay) + a late joiner.
// Usage: (cd test && npm install) && node test/sync-test.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8099, PIN = '2468', BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

(async () => {
  const DATA = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'fll-sync-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; srv.stdout.on('data', d => out += d);
  await sleep(700);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
  const results = {};
  try {
    const mk = async (opts, url, init) => {
      const ctx = await browser.newContext(opts);
      if (init) await ctx.addInitScript(init);
      const p = await ctx.newPage(); await p.goto(url); return p;
    };
    // --- control (desktop) ---
    const control = await mk({ viewport: { width: 1280, height: 860 } }, BASE + '/control');
    await control.waitForSelector('#pinModal:not(.hidden)');
    await control.fill('#pinInput', '0000'); await control.click('#pinBtn'); await sleep(300);
    results.wrongPinRejected = (await control.textContent('#err')).includes('Wrong');
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });

    // --- displays: skewed clocks + random one-way delays ---
    const specs = [
      { name: 'Table 1', skew: 4000, delay: 0, vp: { width: 1280, height: 720 } },          // TV/laptop
      { name: 'Table 2', skew: -2500, delay: 40, vp: { width: 390, height: 844 }, mobile: true }, // iPhone-ish portrait
      { name: 'Table 3', skew: 777, delay: 120, vp: { width: 844, height: 390 }, mobile: true },  // phone landscape
    ];
    const displays = [];
    for (const s of specs) {
      const p = await mk({ viewport: s.vp, isMobile: !!s.mobile, hasTouch: !!s.mobile, deviceScaleFactor: s.mobile ? 2 : 1 },
        `${BASE}/display?role=timer&name=${encodeURIComponent(s.name)}&autostart=1`,
        `window.__SKEW=${s.skew};window.__SIM_DELAY=${s.delay};`);
      displays.push({ ...s, p });
    }
    await sleep(2500); // let clocks sync
    for (const d of displays) {
      const o = await d.p.evaluate(() => ({ offset: FLL.offset, rtt: FLL.rtt, synced: FLL.synced }));
      d.offsetErr = o.offset + d.skew; // true offset is -skew (same physical clock)
      d.rtt = o.rtt;
    }
    results.offsetErrorsMs = Object.fromEntries(displays.map(d => [d.name, +d.offsetErr.toFixed(2)]));
    results.listedOnControl = await control.$$eval('#clients tr td.n', tds => tds.map(t => t.textContent));
    await control.screenshot({ path: path.join(SHOTS, 'control_idle_desktop.png') });

    // --- start the 2:30 match ---
    const t0 = Date.now();
    await control.click('#startBtn');
    await sleep(6800);
    // late joiner mid-match (skewed, delayed)
    const late = await mk({ viewport: { width: 1024, height: 768 } }, `${BASE}/display?role=timer&name=Late%20joiner&autostart=1`, 'window.__SKEW=-9000;window.__SIM_DELAY=60;');
    await sleep(4500);
    await control.screenshot({ path: path.join(SHOTS, 'control_running_desktop.png') });
    await displays[0].p.screenshot({ path: path.join(SHOTS, 'display_running_desktop.png') });
    await displays[1].p.screenshot({ path: path.join(SHOTS, 'display_running_phone_portrait.png') });
    await displays[2].p.screenshot({ path: path.join(SHOTS, 'display_running_phone_landscape.png') });

    // --- measure second-boundary agreement ---
    const all = [...displays, { name: 'Late joiner', p: late }];
    const trans = {};
    // drop each page's first running entry: that's when it joined/started rendering, not a second boundary
    for (const d of all) trans[d.name] = await d.p.evaluate(() => window.__transitions.filter(t => t.status === 'running').slice(1));
    const byText = {};
    for (const [n, list] of Object.entries(trans)) for (const t of list) (byText[t.text] = byText[t.text] || {})[n] = t.at;
    const spreads = [];
    for (const [text, m] of Object.entries(byText)) {
      const v = Object.values(m); if (v.length < 3 || text === '2:30') continue;
      spreads.push({ text, n: v.length, spreadMs: +(Math.max(...v) - Math.min(...v)).toFixed(1) });
    }
    results.secondBoundarySpread = spreads;
    results.maxSpreadMs = Math.max(...spreads.map(s => s.spreadMs));
    results.lateJoinerFirstShown = await late.evaluate(() => window.__transitions.map(t => t.text).slice(0, 3));
    results.lateJoinerShown = await late.textContent('#time');
    results.displaysNow = await Promise.all(all.map(d => d.p.textContent('#time')));
    results.startCues = await Promise.all(all.map(d => d.p.evaluate(() => window.__cues.map(c => c.name).join(','))));

    // --- pause / resume ---
    await control.click('#startBtn'); await sleep(800);
    const paused = await Promise.all(all.map(d => d.p.evaluate(() => [FLL.state.status, FLL.fmt(FLL.remaining())])));
    await displays[0].p.screenshot({ path: path.join(SHOTS, 'display_paused_desktop.png') });
    await sleep(1500);
    const stillPaused = await Promise.all(all.map(d => d.p.textContent('#time')));
    results.pause = { paused, sameAfter1_5s: JSON.stringify(paused.map(p => p[1])) === JSON.stringify(stillPaused) };
    await control.click('#startBtn'); await sleep(1500);
    results.resumed = await Promise.all(all.map(d => d.p.evaluate(() => [FLL.state.status, FLL.fmt(FLL.remaining())])));

    // --- reset (confirm dialog auto-accepted) then a short custom run through the end-game + buzzer ---
    control.on('dialog', d => d.accept());
    await control.keyboard.press('r'); await sleep(500);
    results.afterReset = await Promise.all(all.map(d => d.p.textContent('#time')));
    await control.fill('#customTime', '0:33'); await control.click('#setCustom'); await sleep(400);
    for (const d of all) await d.p.evaluate(() => { window.__cues = []; });
    await control.keyboard.press('Space');
    await sleep(4600);
    await displays[0].p.screenshot({ path: path.join(SHOTS, 'display_endgame_desktop.png') });
    await displays[1].p.screenshot({ path: path.join(SHOTS, 'display_endgame_phone_portrait.png') });
    await sleep(29500);
    await displays[0].p.screenshot({ path: path.join(SHOTS, 'display_time_up_desktop.png') });
    await control.screenshot({ path: path.join(SHOTS, 'control_done_desktop.png') });
    const cues = await Promise.all(all.map(d => d.p.evaluate(() => window.__cues)));
    results.customRunCues = cues.map((c, i) => all[i].name + ': ' + c.map(x => x.name).join(','));
    const cueSpread = name => { const v = cues.map(c => (c.find(x => x.name === name) || {}).at).filter(Boolean); return +(Math.max(...v) - Math.min(...v)).toFixed(1); };
    results.cueSpreadMs = { start: cueSpread('start'), warn: cueSpread('warn'), end: cueSpread('end') };
    results.finalShown = await Promise.all(all.map(d => d.p.textContent('#time')));

    // --- phone-sized control screenshot + spectator without PIN can't control ---
    const phoneCtl = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, BASE + '/control');
    await sleep(800);
    results.spectatorSeesPinPrompt = await phoneCtl.isVisible('#pinModal');
    const sent = await phoneCtl.evaluate(() => FLL.cmd('start'));
    await sleep(400);
    results.spectatorCmdBlocked = (await control.evaluate(() => FLL.state.status)) !== 'running';
    await phoneCtl.fill('#pinInput', PIN); await phoneCtl.click('#pinBtn'); await sleep(400);
    await control.keyboard.press('r'); await sleep(300);
    await phoneCtl.click('[data-ms="150000"]'); await sleep(300);
    await phoneCtl.click('#startBtn'); await sleep(3300);
    await phoneCtl.screenshot({ path: path.join(SHOTS, 'control_running_phone.png'), fullPage: true });
    await late.screenshot({ path: path.join(SHOTS, 'display_running_tablet.png') });
    // first-run overlay (tap to enable sound)
    const fresh = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, `${BASE}/display?role=timer`);
    await sleep(600);
    await fresh.screenshot({ path: path.join(SHOTS, 'display_tap_to_enable_phone.png') });
    const picker = await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display`);
    await sleep(600);
    results.pickerShown = await picker.isVisible('#picker');
    await picker.screenshot({ path: path.join(SHOTS, 'display_role_picker.png') });
    results.elapsedS = (Date.now() - t0) / 1000;
  } finally {
    console.log(JSON.stringify(results, null, 2));
    await browser.close(); srv.kill();
  }
  // Limit for the second-boundary spread. Headless Chrome paints in ~16.7 ms frames, so the spread is normally 1 or 2 frames (17 / 33 ms);
  // a busy shared CI runner sometimes adds a third frame (50.x ms). CI sets SYNC_MAX_SPREAD_MS=60; local runs keep 50.
  const maxSpread = Number(process.env.SYNC_MAX_SPREAD_MS) || 50;
  results.maxSpreadLimitMs = maxSpread;
  const ok = results.maxSpreadMs < maxSpread && results.pause && results.pause.sameAfter1_5s && results.spectatorCmdBlocked && results.wrongPinRejected;
  console.log(ok ? '\nPASS' : '\nFAIL'); process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
