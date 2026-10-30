// End-to-end event test: Head Ref control + main projector + 3 pair screens, real headless Chrome.
// Uses the public Nexus sample event "wipws" (live fetch if online, else the bundled fixture as CSV).
// node test/event-test.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const S = require('../lib/schedule');
const PORT = 8097, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { checks: [] }; let failed = 0;
function check(name, ok, detail) { results.checks.push({ name, ok: !!ok, detail }); if (!ok) failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
function wav(freq, secs) { // tiny mono 16-bit PCM WAV, stands in for an uploaded FIRST sound file
  const sr = 22050, n = Math.floor(sr * secs), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 12000), 44 + i * 2);
  return b;
}
async function startServer(DATA) {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  return srv;
}

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-event-'));
  let srv = await startServer(DATA);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const pages = [];
  async function mk(ctxOpts, url, init) {
    const ctx = await browser.newContext(ctxOpts); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; });
    await p.goto(url); pages.push(p); return p;
  }
  try {
    const control = await mk({ viewport: { width: 1366, height: 900 } }, `${BASE}/control`);
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });

    const D = {
      main: await mk({ viewport: { width: 1920, height: 1080 } }, `${BASE}/display?role=main&autostart=1`, 'window.__SKEW=3000;window.__SIM_DELAY=30;window.__DEVICE_ID="dev-main";'),
      A: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=A&autostart=1`, 'window.__SKEW=-1500;window.__SIM_DELAY=60;window.__DEVICE_ID="dev-A";'),
      B: await mk({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, `${BASE}/display?pair=B&autostart=1`, 'window.__SKEW=800;window.__SIM_DELAY=100;window.__DEVICE_ID="dev-B";'),
      C: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=C&autostart=1`, 'window.__DEVICE_ID="dev-C";window.__SIM_DELAY=20;'),
    };
    await sleep(2500);
    const cmd = (c, extra) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, extra]);
    const view = p => p.evaluate(() => window.__view);
    const text = p => p.evaluate(() => document.getElementById('main').innerText.replace(/\s+/g, ' '));

    // ---- 1. load the wipws schedule: live from Nexus, fallback to fixture CSV ----
    await control.fill('#nexusUrl', 'https://fll.nexus/region/wisconsin/event/wipws/schedule');
    await control.click('#nexusBtn');
    for (let i = 0; i < 40 && !(await control.evaluate(() => FLL.schedule)); i++) await sleep(250);
    let source = await control.evaluate(() => FLL.schedule && FLL.schedule.source);
    if (source === 'nexus') results.scheduleSource = 'live Nexus fetch (wipws)';
    else {
      results.nexusError = await control.evaluate(() => FLL.config.nexus.error);
      const csv = S.toCSV(S.fromNexus(require('./fixtures/wipws-sessions.json'), require('./fixtures/wipws-config.json'), require('./fixtures/wipws-teams.json'), { key: 'wipws' }));
      await control.click('#csvBox summary'); await control.fill('#csvText', csv); await control.click('#csvLoad');
      for (let i = 0; i < 20 && !(await control.evaluate(() => FLL.schedule)); i++) await sleep(250);
      results.scheduleSource = 'fixture CSV (wipws) – live fetch failed: ' + results.nexusError;
    }
    console.log('Schedule source:', results.scheduleSource);
    check('42 matches loaded', (await control.evaluate(() => FLL.schedule.matches.length)) === 42);
    // Pretend the event is running 3 minutes late: match 1 was scheduled 3 min ago.
    await cmd('scheduleShift', { index: 0, time: Date.now() - 180000 }); await sleep(800);

    // ---- 2. idle views ----
    check('main view', (await view(D.main)) === 'main');
    const mt = await text(D.main);
    check('main shows Match 1 with 4 teams', /Match 1\b/.test(mt) && ['77354', '38663', '54448', '74194'].every(t => mt.includes(t)), mt.slice(0, 200));
    check('main shows behind schedule', /\+3 min behind/.test(await D.main.textContent('#delta')), await D.main.textContent('#delta'));
    check('pair A idle = up next', (await view(D.A)) === 'pair-upnext');
    check('pair C up next Match 2 (72268/60861)', /Match 2\b/.test(await text(D.C)) && /72268/.test(await text(D.C)) && /60861/.test(await text(D.C)), (await text(D.C)).slice(0, 160));

    // ---- 3. sounds: volume sliders, per-display mute, custom upload, test ----
    async function slide(cue, pct) { await control.evaluate(([c, v]) => { const r = document.querySelector(`input[data-cue="${c}"]`); r.value = v; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }, [cue, pct]); }
    await slide('master', 80); await slide('warn', 50); await slide('end', 150); await sleep(700);
    const cfgs = await Promise.all(Object.values(D).map(p => p.evaluate(() => [FLLSound.cfg.master, FLLSound.cfg.cues.warn.vol, FLLSound.cfg.cues.end.vol])));
    check('volumes pushed live to every display', cfgs.every(c => c[0] === 0.8 && c[1] === 0.5 && c[2] === 1.5), cfgs);
    await control.click('#clients button[data-mute="dev-B"]'); await sleep(500);
    await control.evaluate(() => { const r = document.querySelector('#clients input[data-dev="dev-C"]'); r.value = 40; r.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(500);
    check('pair B muted / pair C 40%', await D.B.evaluate(() => FLLSound.pref.muted) && (await D.C.evaluate(() => FLLSound.pref.vol)) === 0.4);
    const up = await control.evaluate(async b64 => { const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const r = await fetch('/api/sound/start', { method: 'POST', body: new Blob([bin], { type: 'audio/wav' }), headers: { 'Content-Type': 'audio/wav', 'X-File-Name': 'charge.wav', 'X-FLL-PIN': FLL.pin } }); return r.status; }, wav(660, 0.6).toString('base64'));
    const badUp = await control.evaluate(async () => (await fetch('/api/sound/end', { method: 'POST', body: 'x', headers: { 'Content-Type': 'audio/wav', 'X-File-Name': 'x.wav', 'X-FLL-PIN': 'nope' } })).status);
    check('upload accepted with PIN, rejected without', up === 200 && badUp === 403, { up, badUp });
    await sleep(1500);
    check('displays decoded the uploaded start sound', (await Promise.all(Object.values(D).map(p => p.evaluate(() => !!FLLSound.buffers.start)))).every(Boolean));
    await Promise.all(Object.values(D).map(p => p.evaluate(() => { window.__plays = []; })));
    await control.click('button[data-test="warn"]'); await sleep(600);
    const tp = {}; for (const [k, p] of Object.entries(D)) tp[k] = await p.evaluate(() => (window.__plays || []).filter(x => x.cue === 'warn').map(x => x.gain)[0]);
    check('test sound: gains = master×cue×display (B muted → 0, C 40%)', tp.main === 0.4 && tp.A === 0.4 && tp.B === 0 && tp.C === 0.16, tp);
    await control.click('#clients button[data-mute="dev-B"]'); await sleep(300); // unmute B again
    await control.evaluate(() => { const r = document.querySelector('#clients input[data-dev="dev-C"]'); r.value = 100; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await control.evaluate(() => window.scrollTo(0, 0)); await sleep(400);
    await control.screenshot({ path: path.join(SHOTS, 'v2_control_schedule_volumes.png'), fullPage: true });

    // ---- 4. start match 1 (tables 1–4) ----
    await Promise.all(Object.values(D).map(p => p.evaluate(() => { window.__cues = []; window.__plays = []; window.__transitions = []; })));
    await control.click('#startBtn');
    await sleep(3200);
    check('pair A + B show the timer', (await view(D.A)) === 'pair-playing' && (await view(D.B)) === 'pair-playing');
    check('pair C shows up next Match 2 during A+B', (await view(D.C)) === 'pair-upnext' && /Match 2\b/.test(await text(D.C)));
    check('main shows match 1 running + started time', (await view(D.main)) === 'main' && /started/i.test(await text(D.main)), (await text(D.main)).slice(0, 160));
    check('ahead/behind uses actual start (+3 behind)', /\+3 min behind/.test(await D.main.textContent('#delta')), await D.main.textContent('#delta'));
    await D.main.screenshot({ path: path.join(SHOTS, 'v2_main_projector_AB_match.png') });
    await D.C.screenshot({ path: path.join(SHOTS, 'v2_pairC_upnext_during_AB.png') });
    await D.A.screenshot({ path: path.join(SHOTS, 'v2_pairA_timer.png') });
    await D.B.screenshot({ path: path.join(SHOTS, 'v2_pairB_phone_timer.png') });
    await control.evaluate(() => window.scrollTo(0, 0));
    await control.screenshot({ path: path.join(SHOTS, 'v2_control_running.png') });
    // sync spread across all 4 screens (second-boundary transitions, local clocks deliberately skewed up to 4.5 s)
    await sleep(4000);
    // perfNow() is the real (unskewed) machine clock, shared by all pages, so tick times compare directly
    const st = {}; for (const [k, p] of Object.entries(D)) st[k] = await p.evaluate(() => window.__transitions.slice(1).map(x => [x.text, x.at]));
    const byText = {}; for (const k in st) for (const [t, s] of st[k]) if (s != null) (byText[t] = byText[t] || []).push(s);
    const spreads = Object.values(byText).filter(v => v.length === 4).map(v => Math.max(...v) - Math.min(...v));
    results.syncSpreadMs = spreads.length ? +Math.max(...spreads).toFixed(1) : null;
    check('4 screens within 50 ms (server-time at each second tick)', spreads.length >= 3 && Math.max(...spreads) < 50, { samples: spreads.length, max: results.syncSpreadMs });
    const startCues = {}; for (const [k, p] of Object.entries(D)) startCues[k] = await p.evaluate(() => window.__cues.map(c => c.name).join(','));
    check('start cue only on playing screens (main, A, B – not C)', startCues.main === 'start' && startCues.A === 'start' && startCues.B === 'start' && startCues.C === '', startCues);
    check('uploaded file used for start', (await D.A.evaluate(() => window.__plays.find(p => p.cue === 'start').src)) === 'file');
    check('PIN-less goto refused while running', await control.evaluate(async () => { const before = FLL.state.match.current; FLL.cmd('goto', { delta: 1 }); await new Promise(r => setTimeout(r, 400)); return FLL.state.match.current === before; }));

    // ---- 5. abort: foghorn, match not advanced, actual start removed ----
    control.once('dialog', d => d.accept());
    await control.click('#resetBtn'); await sleep(800);
    const ab = {}; for (const [k, p] of Object.entries(D)) ab[k] = await p.evaluate(() => window.__cues.map(c => c.name).join(','));
    const m0 = await control.evaluate(() => FLL.state.match);
    check('abort → foghorn on A/B/main, not C; still match 1; no actual start', /abort$/.test(ab.A) && /abort$/.test(ab.main) && ab.C === '' && m0.current === 0 && !m0.actualStarts['1'], { ab, current: m0.current });

    // ---- 6. short matches to exercise end + auto-advance ----
    await cmd('set', { duration: 4000, label: 'Match' }); await sleep(300);
    await Promise.all(Object.values(D).map(p => p.evaluate(() => { window.__cues = []; })));
    await control.click('#startBtn'); await sleep(5600);
    let m = await control.evaluate(() => FLL.state.match);
    check('match 1 ended → auto-advanced to match 2, actual start recorded', m.current === 1 && !!m.actualStarts['1'], m);
    const endC = {}; for (const [k, p] of Object.entries(D)) endC[k] = await p.evaluate(() => window.__cues.map(c => c.name).join(','));
    check('end buzzer on main/A/B only', /end/.test(endC.main) && /end/.test(endC.A) && /end/.test(endC.B) && endC.C === '', endC);
    check('pair A now shows up next Match 3 (32206/938) right after its match', (await view(D.A)) === 'pair-upnext' && /Match 3\b/.test(await text(D.A)) && /32206/.test(await text(D.A)) && /\b938\b/.test(await text(D.A)), (await text(D.A)).slice(0, 160));
    await D.A.screenshot({ path: path.join(SHOTS, 'v2_pairA_upnext_after_match.png') });
    await D.main.screenshot({ path: path.join(SHOTS, 'v2_main_between_matches.png') });
    await control.click('#startBtn'); await sleep(2000);
    check('match 2: pair C plays, A + B show up next', (await view(D.C)) === 'pair-playing' && (await view(D.A)) === 'pair-upnext' && (await view(D.B)) === 'pair-upnext');
    await D.C.screenshot({ path: path.join(SHOTS, 'v2_pairC_timer.png') });
    await D.main.screenshot({ path: path.join(SHOTS, 'v2_main_projector_C_match.png') });
    await sleep(3200);
    m = await control.evaluate(() => FLL.state.match);
    check('match 2 ended → current = match 3', m.current === 2, m.current);

    // ---- 7. prev / next, spectator & layout ----
    await control.click('#nextBtn'); await sleep(300); const n1 = await control.evaluate(() => FLL.state.match.current);
    await control.click('#prevBtn'); await sleep(300); const n2 = await control.evaluate(() => FLL.state.match.current);
    check('next / prev buttons', n1 === 3 && n2 === 2, [n1, n2]);
    const spy = await mk({ viewport: { width: 800, height: 600 } }, `${BASE}/control`);
    await sleep(800); await spy.evaluate(() => FLL.cmd('goto', { delta: 5 })); await sleep(400);
    check('control page without PIN cannot change match', (await control.evaluate(() => FLL.state.match.current)) === 2);
    const pick = await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display`); await sleep(500);
    check('role picker lists main + 3 pairs + queue + timer', (await pick.$$eval('#roles a', a => a.length)) === 6);
    await pick.screenshot({ path: path.join(SHOTS, 'v2_display_role_picker.png') });

    // ---- 8. persistence across a server restart ----
    await sleep(400); srv.kill(); await sleep(500); srv = await startServer(DATA);
    const csv = await (await fetch(`${BASE}/api/schedule.csv`)).text();
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json')));
    check('restart keeps schedule, match, volumes, uploaded sound', csv.trim().split('\n').length === 43 && saved.match.current === 2 && saved.sound.master === 0.8 && !!saved.sound.cues.start.file, { rows: csv.trim().split('\n').length, current: saved.match.current });
    await sleep(3500);
    check('displays reconnect after restart', (await D.main.evaluate(() => FLL.connected)) && (await view(D.A)) === 'pair-upnext');
  } catch (e) { console.error(e); failed++; }
  await browser.close(); srv.kill();
  console.log(JSON.stringify(results, null, 1).slice(0, 400));
  console.log(failed ? `\nFAIL (${failed})` : '\nPASS');
  process.exit(failed ? 1 : 0);
})();
