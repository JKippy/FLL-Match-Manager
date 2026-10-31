// End-to-end regression tests for v4: one-shot cues, refused-command feedback, ahead-of-schedule confirm,
// simplified break settings, match-ready after a break, projector break layout.   node test/v4-test.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 8098, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const { SHOTS } = require('./shots');   // test-output/screenshots unless --update
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-v4-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const consoleLog = [];
  async function mk(ctxOpts, url, init) {
    const ctx = await browser.newContext(ctxOpts); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; });
    p.on('console', m => consoleLog.push(m.type() + ' ' + m.text()));
    p.on('dialog', d => d.accept());
    await p.goto(url); return p;
  }
  try {
    const control = await mk({ viewport: { width: 1366, height: 900 } }, `${BASE}/control`);
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    await control.evaluate(() => { window.__cc = []; const o = FLLSound.play.bind(FLLSound); FLLSound.play = (n, ...a) => { window.__cc.push(n); return o(n, ...a); }; });
    const D = {
      main: await mk({ viewport: { width: 1920, height: 1080 } }, `${BASE}/display?role=main&autostart=1`, 'window.__SKEW=2500;window.__SIM_DELAY=30;window.__DEVICE_ID="m";'),
      A: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=A&autostart=1`, 'window.__SKEW=-1200;window.__DEVICE_ID="a";'),
      C: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=C&autostart=1`, 'window.__DEVICE_ID="c";window.__SIM_DELAY=20;'),
    };
    await sleep(2500);
    const cmd = (c, e) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const st = () => control.evaluate(() => FLL.state);
    const view = p => p.evaluate(() => window.__view);
    const text = p => p.evaluate(() => document.getElementById('main').innerText.replace(/\s+/g, ' '));
    const cues = p => p.evaluate(() => window.__cues.map(c => c.name).join(','));
    const ctlCues = () => control.evaluate(() => window.__cc.filter(n => n !== 'test').join(','));
    const clearLogs = () => Promise.all([control, ...Object.values(D)].map(p => p.evaluate(() => { window.__cues = []; window.__cc = []; })));
    const shift = (idx, at) => cmd('scheduleShift', { index: idx, time: at });
    const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
    const toast = () => control.evaluate(() => { const t = document.getElementById('toast'); return t.style.display === 'block' ? { text: t.textContent, err: t.classList.contains('err') } : null; });

    await control.click('#csvBox summary');
    await control.setInputFiles('#csvFile', SAMPLE);
    await waitFor(() => control.evaluate(() => FLL.schedule && FLL.schedule.matches.length === 24));
    await shift(0, Date.now() + 30000); await cmd('set', { duration: 4000, label: 'Match' }); await sleep(600);

    // ================= Bug 1: abort (and every cue) fires once, at the moment =================
    await clearLogs();
    await control.click('#startBtn'); await sleep(1500);
    check('start: no ahead confirm when 30 s ahead', !(await control.evaluate(() => !document.getElementById('confirmModal') || !document.getElementById('confirmModal').classList.contains('hidden') ? false : false)) && (await st()).status === 'running');
    await cmd('reset'); await sleep(900);
    check('abort plays exactly once (projector, pair A, control)', (await cues(D.main)) === 'start,abort' && (await cues(D.A)) === 'start,abort' && (await ctlCues()) === 'start,abort', { main: await cues(D.main), A: await cues(D.A), ctl: await ctlCues() });
    for (const d of [1, 1, -1, -1]) { await control.keyboard.press(d > 0 ? 'ArrowRight' : 'ArrowLeft'); await sleep(350); }
    await control.click('#nextBtn'); await sleep(350); await control.click('#prevBtn'); await sleep(350);
    await cmd('autoAdvance', { on: true }); await cmd('clearActuals'); await sleep(500);
    check('no abort replay after arrow keys / prev-next / other commands', (await cues(D.main)) === 'start,abort' && (await cues(D.A)) === 'start,abort' && (await ctlCues()) === 'start,abort', { main: await cues(D.main), A: await cues(D.A), ctl: await ctlCues() });
    const late = await mk({ viewport: { width: 800, height: 600 } }, `${BASE}/display?role=main&autostart=1`, 'window.__DEVICE_ID="late";');
    await sleep(2000); await cmd('goto', { delta: 1 }); await sleep(400); await cmd('goto', { delta: -1 }); await sleep(600);
    check('late joiner after an abort plays nothing (even on match changes)', (await cues(late)) === '', await cues(late));
    await D.main.evaluate(() => FLL.ws.close()); await sleep(2500); await cmd('goto', { delta: 1 }); await sleep(400); await cmd('goto', { delta: -1 }); await sleep(600);
    check('reconnect after an abort: no replay', (await cues(D.main)) === 'start,abort', await cues(D.main));
    await control.reload(); await sleep(2500);
    await control.evaluate(() => { window.__cc = []; const o = FLLSound.play.bind(FLLSound); FLLSound.play = (n, ...a) => { window.__cc.push(n); return o(n, ...a); }; });
    await cmd('goto', { delta: 1 }); await sleep(400); await cmd('goto', { delta: -1 }); await sleep(600);
    check('control page reloaded after an abort: no replay', (await ctlCues()) === '', await ctlCues());
    // a second abort plays once more
    await clearLogs(); await cmd('start'); await sleep(1200); await cmd('reset'); await sleep(800); await cmd('goto', { delta: 1 }); await sleep(400); await cmd('goto', { delta: -1 }); await sleep(500);
    check('second abort: exactly one more abort', (await cues(D.main)) === 'start,abort', await cues(D.main));
    // end cue: once, never on navigation / late join
    await clearLogs(); await cmd('start'); await waitFor(async () => (await st()).status === 'done', 8000); await sleep(600);
    await cmd('goto', { delta: 1 }); await sleep(400); await cmd('goto', { delta: -1 }); await sleep(400); await cmd('goto', { delta: 1 }); await sleep(500);
    check('start/end cues once per match, none on navigation', (await cues(D.main)) === 'start,end' && (await cues(D.A)) === 'start,end', { main: await cues(D.main), A: await cues(D.A) });
    await late.context().close();
    const late2 = await mk({ viewport: { width: 800, height: 600 } }, `${BASE}/display?role=main&autostart=1`, 'window.__DEVICE_ID="late2";');
    await sleep(2000); await cmd('goto', { delta: -1 }); await sleep(400); await cmd('goto', { delta: 1 }); await sleep(500);
    check('late joiner after a match ended: no start/end replay', (await cues(late2)) === '', await cues(late2));
    await late2.context().close();

    // ================= Change 3/4: simplified settings + ahead-of-schedule confirm =================
    const cfg = await control.evaluate(() => FLL.config.breaks);
    check('default target: up to 2 min ahead', cfg.aheadMin === 2, cfg);
    check('control: one main setting "start matches up to [2] min ahead"', await control.evaluate(() => { const i = document.getElementById('brkAhead'); return !!i && +i.value === 2 && /start matches up to/i.test(i.closest('label').textContent) && !document.getElementById('brkOffset'); }));
    check('control: explanation line under the setting', /ends 2 min before the next match's scheduled time/i.test(await control.evaluate(() => document.getElementById('brkHint').textContent)), await control.evaluate(() => document.getElementById('brkHint').textContent));
    check('control: minimum break under Advanced, default 30 s, explained', await control.evaluate(() => { const i = document.getElementById('brkMin'); const det = i && i.closest('details'); return !!det && +i.value === 30 && /shorter than/i.test(det.textContent); }));
    await control.evaluate(() => document.querySelector('.brkbox details').open = true);
    await (await control.$('.brkbox')).screenshot({ path: path.join(SHOTS, 'v4_control_break_settings.png') });
    await control.evaluate(() => document.querySelector('.brkbox details').open = false);

    await cmd('goto', { index: 1 }); await sleep(300);
    await shift(1, Date.now() + 4 * 60000 + 20000); await sleep(400);
    await control.click('#startBtn'); await sleep(500);
    const cm = await control.evaluate(() => { const m = document.getElementById('confirmModal'); return m && !m.classList.contains('hidden') ? m.innerText.replace(/\s+/g, ' ') : null; });
    check("START 4 min ahead shows confirm \"You're 4 min ahead of schedule. Start anyway?\"", !!cm && /You're 4 min ahead of schedule\. Start anyway\?/.test(cm), cm);
    check('...and the match has not started yet', (await st()).status === 'idle');
    await control.screenshot({ path: path.join(SHOTS, 'v4_control_ahead_confirm.png') });
    await control.click('#confirmNo'); await sleep(400);
    check('Cancel: match stays ready', (await st()).status === 'idle' && await control.evaluate(() => document.getElementById('confirmModal').classList.contains('hidden')));
    await control.keyboard.press('Space'); await sleep(400);
    check('Space also asks', await control.evaluate(() => !document.getElementById('confirmModal').classList.contains('hidden')));
    await control.click('#confirmYes'); await sleep(800);
    check('Start anyway: match starts', (await st()).status === 'running');
    await cmd('reset'); await sleep(400);
    await shift(1, Date.now() + 90000); await sleep(300); await control.click('#startBtn'); await sleep(500);
    check('1.5 min ahead: starts with no confirm', (await st()).status === 'running' && await control.evaluate(() => document.getElementById('confirmModal').classList.contains('hidden')));
    await cmd('reset'); await sleep(400);

    // ================= Change 6: projector during a break =================
    await clearLogs();
    await shift(1, Date.now() + 2 * 60000 + 12000); await sleep(300);
    await cmd('breakStart', { until: 'next' }); await sleep(900);
    const s1 = await st(); const m2 = await control.evaluate(() => FLL.schedule.matches[1]);
    check('break ends 2 min before the scheduled match', s1.kind === 'break' && Math.abs(s1.breakUntil - (m2.time - 120000)) < 50, { until: s1.breakUntil, sched: m2.time });
    const mt = await text(D.main);
    check('projector break: view main-break, teams first, break note beneath', (await view(D.main)) === 'main-break' && /Up next/i.test(mt) && mt.indexOf('79742') >= 0 && mt.indexOf('79742') < mt.search(/Field break/i), mt);
    check("projector break note: 'Field break · next match in m:ss · scheduled X'", /Field break · next match in \d+:\d\d · scheduled \d{1,2}:\d\d/i.test(mt), mt);
    const layout = await D.main.evaluate(() => { const n = document.querySelector('#main .upnext .num, #main .tchip .num'); const b = document.querySelector('#main .breaknote'); return { numPx: n && parseFloat(getComputedStyle(n).fontSize), numTop: n && n.getBoundingClientRect().top, noteTop: b && b.getBoundingClientRect().top, noteColor: b && getComputedStyle(b.querySelector('.cd') || b).color }; });
    check('projector break: team numbers big (>=150px) and above the orange countdown', layout.numPx >= 150 && layout.noteTop > layout.numTop && layout.noteColor === 'rgb(255, 154, 46)', layout);
    await D.main.screenshot({ path: path.join(SHOTS, 'v4_main_field_break.png') });
    await D.C.screenshot({ path: path.join(SHOTS, 'v4_pairC_field_break.png') });
    // 4-team break (tables 1-4 up next): every card and number must fit on screen at common projector sizes
    await cmd('breakEnd'); await sleep(300);
    await cmd('goto', { index: 2 }); await shift(2, Date.now() + 2 * 60000 + 30000); await sleep(300);
    await cmd('breakStart', { until: 'next' }); await sleep(900);
    for (const vp of [[1920, 1080], [1280, 720], [1024, 768], [1024, 430], [800, 600]]) {
      await D.main.setViewportSize({ width: vp[0], height: vp[1] }); await sleep(400);
      const fit = await D.main.evaluate(() => { const W = innerWidth; const cols = [...document.querySelectorAll('#main .mainbreak .col')]; return { n: cols.length, W, ok: cols.length === 4 && cols.every(c => { const r = c.getBoundingClientRect(); const num = c.querySelector('.num'); return r.left >= 0 && r.right <= W + 1 && num.scrollWidth <= num.clientWidth + 1; }), numPx: cols[0] && parseFloat(getComputedStyle(cols[0].querySelector('.num')).fontSize) }; });
      check(`projector 4-team break fits at ${vp[0]}x${vp[1]}`, fit.ok, fit);
      if (vp[0] === 1920 || vp[1] === 430) await D.main.screenshot({ path: path.join(SHOTS, `v4_main_break_4teams_${vp[0]}x${vp[1]}.png`) });
    }
    await D.main.setViewportSize({ width: 1920, height: 1080 });
    await cmd('breakEnd'); await sleep(300); await cmd('goto', { index: 1 }); await sleep(300);
    // short break again for match 2 so it can end by itself
    await shift(1, Date.now() + 2 * 60000 + 6000); await sleep(300); await cmd('breakStart', { until: 'next' }); await sleep(500);

    // ================= Change 5: break ends -> match-ready =================
    await waitFor(async () => (await st()).kind === 'match', 20000); await sleep(800);
    const s2 = await st();
    check('break ended naturally: idle 4 s match timer, ready flag', s2.status === 'idle' && s2.kind === 'match' && s2.ready === true, s2);
    // use 2:30 for the ready picture
    await cmd('set', { duration: 150000, label: 'Match' }); await sleep(300);
    // second break, for a match with pairs A+B, using real 2:30 matches
    await cmd('goto', { index: 2 }); await shift(2, Date.now() + 2 * 60000 + 8000); await sleep(300);
    await cmd('breakStart', { until: 'next' }); await sleep(500);
    await waitFor(async () => (await st()).kind === 'match', 20000); await sleep(800);
    const mainR = { v: await view(D.main), t: await text(D.main), cls: await D.main.evaluate(() => document.getElementById('time').className), lbl: await D.main.evaluate(() => document.getElementById('label').textContent) };
    check('projector after break: 2:30 ready timer, match + teams', mainR.v === 'main-prematch' && /2:30/.test(mainR.t) && /Match 3/.test(mainR.t) && mainR.t.includes('84288') && /\bidle\b/.test(mainR.cls) && /starting soon/i.test(mainR.lbl), mainR);
    check('projector after break: "Starting soon" shown and no field-break context left', /starting soon/i.test(mainR.t) && !/field break/i.test(mainR.t), mainR.t);
    const aR = { v: await view(D.A), t: await text(D.A), cls: await D.A.evaluate(() => (document.getElementById('time') || {}).className) };
    check('pair A (plays next) after break: 2:30 ready timer with its teams', aR.v === 'pair-ready' && /2:30/.test(aR.t) && aR.t.includes('84288') && aR.t.includes('27575') && /\bidle\b/.test(aR.cls) && /starting soon/i.test(aR.t) && !/field break/i.test(aR.t), aR);
    const cR = { v: await view(D.C), t: await text(D.C) };
    check('pair C (not in next match) keeps up-next teams', cR.v === 'pair-upnext' && cR.t.includes('Match 4'), cR);
    check('no sounds while going into ready', (await cues(D.main)) === '' && (await cues(D.A)) === '' && (await ctlCues()) === '', { main: await cues(D.main), A: await cues(D.A), ctl: await ctlCues() });
    await D.main.screenshot({ path: path.join(SHOTS, 'v4_main_ready_after_break.png') });
    await D.A.screenshot({ path: path.join(SHOTS, 'v4_pairA_ready_after_break.png') });
    await D.C.screenshot({ path: path.join(SHOTS, 'v4_pairC_upnext_after_break.png') });
    await control.click('#startBtn'); await sleep(1500);
    check('START from ready: pair A shows the running timer, start cue on main + A only', (await view(D.A)) === 'pair-playing' && (await cues(D.main)) === 'start' && (await cues(D.A)) === 'start' && (await cues(D.C)) === '', { A: await cues(D.A), C: await cues(D.C) });
    await cmd('reset'); await sleep(500);
    check('ready view clears after abort/navigation', (await view(D.A)) === 'pair-upnext');

    // ================= Bug 2: start never silently does nothing =================
    await cmd('set', { duration: 150000 }); await cmd('goto', { index: 2 }); await shift(2, Date.now() + 30000); await sleep(400);
    await control.click('#time'); await sleep(800);
    check('clicking the big timer digits starts the match', (await st()).status === 'running');
    await control.click('#time'); await sleep(800);
    check('...and pauses it', (await st()).status === 'paused');
    await cmd('reset'); await sleep(400);
    await control.click('#autoAdv'); await control.click('#autoAdv'); await control.keyboard.press('Space'); await sleep(800);
    check('Space starts the timer even with a checkbox focused', (await st()).status === 'running');
    await cmd('reset'); await sleep(500);
    // refused command: visible toast + console
    consoleLog.length = 0;
    await control.evaluate(() => document.getElementById('toast').style.display = 'none');
    await cmd('breakEnd'); await sleep(500);
    let t = await toast();
    check('refused command shows a red toast with the reason', !!t && t.err && /no field break/i.test(t.text), t);
    check('...and logs to the console', consoleLog.some(l => /no field break/i.test(l)), consoleLog.slice(-3));
    await control.screenshot({ path: path.join(SHOTS, 'v4_control_refused_toast.png') });
    await cmd('start'); await sleep(600); await control.evaluate(() => document.getElementById('toast').style.display = 'none');
    await control.keyboard.press('ArrowRight'); await sleep(500); t = await toast();
    check('arrow key during a running match: toast says why', !!t && t.err && /stop the running timer/i.test(t.text), t);
    await cmd('reset'); await sleep(400);
    // disconnected
    await control.evaluate(() => { document.getElementById('toast').style.display = 'none'; FLL.ws.close(); });
    await control.click('#startBtn'); await sleep(200); t = await toast();
    check('START while disconnected: toast says not connected', !!t && t.err && /not connected/i.test(t.text), t);
    await sleep(2500);
    // unauthorised control (no PIN)
    const ctl2 = await mk({ viewport: { width: 1000, height: 700 } }, `${BASE}/control`); await sleep(1500);
    await ctl2.evaluate(() => FLL.cmd('start')); await sleep(500);
    const t2 = await ctl2.evaluate(() => (document.getElementById('err').textContent || '') + '|' + (document.getElementById('toast').style.display === 'block' ? document.getElementById('toast').textContent : ''));
    check('command without PIN: reason shown', /PIN/i.test(t2) && (await st()).status === 'idle', t2);
    await ctl2.context().close();
    // server ack: every command is acknowledged
    const ack = await control.evaluate(() => new Promise(r => { FLL.cmd('autoAdvance', { on: true }).then(x => r(x)); }));
    check('commands are acknowledged by the server', ack && ack.ok === true, ack);
  } catch (e) { console.log('TEST CRASH', e); failed++; }
  finally {
    await browser.close(); srv.kill();
    console.log(`\n${passed} passed, ${failed} failed`); console.log(failed ? 'FAIL' : 'PASS');
    process.exit(failed ? 1 : 0);
  }
})();
