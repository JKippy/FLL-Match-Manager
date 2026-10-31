// End-to-end: table referee page (/ref): READY toggle + broadcast, Ready tags on the audience screens (pre-match only),
// resets on end / abort / reset / goto, START confirm when tables aren't ready (+ override, + combined with "ahead"),
// "Call Head Ref" banner + acknowledge + one-shot sound.   node test/ref-test.js
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 8099, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const { SHOTS } = require('./shots');   // test-output/screenshots unless --update
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-ref-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  async function mk(ctxOpts, url, init) {
    const ctx = await browser.newContext(ctxOpts); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; });
    p.on('dialog', d => d.accept());
    await p.goto(url); return p;
  }
  try {
    const control = await mk({ viewport: { width: 1366, height: 1000 } }, `${BASE}/control`);
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    const D = {
      main: await mk({ viewport: { width: 1920, height: 1080 } }, `${BASE}/display?role=main&autostart=1`, 'window.__SKEW=1500;window.__SIM_DELAY=30;window.__DEVICE_ID="m";'),
      A: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=A&autostart=1`, 'window.__SKEW=-900;window.__DEVICE_ID="a";'),
      C: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=C&autostart=1`, 'window.__DEVICE_ID="c";'),
    };
    const cmd = (c, e) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const st = () => control.evaluate(() => FLL.state);
    const view = p => p.evaluate(() => window.__view);
    const tags = p => p.evaluate(() => [...document.querySelectorAll('#main .rtag')].map(e => e.dataset.ready).join(','));
    const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(120); } return false; };
    const shift = (idx, at) => cmd('scheduleShift', { index: idx, time: at });
    const modal = () => control.evaluate(() => document.getElementById('confirmModal').classList.contains('hidden') ? null : document.getElementById('confirmMsg').textContent + ' | ' + document.getElementById('confirmWhy').textContent);
    const readyOf = idx => control.evaluate(i => Object.keys(FLL.readyOf(i)).sort().join(','), idx);
    // Each table's referee link (its QR code on the control page) carries that table's key.
    const refUrl = async t => { await waitFor(() => control.evaluate(t => !!(FLL.refKeys || {})[t], t)); return control.evaluate(t => document.querySelector(`#refGrid .rc[data-table="${t}"] a`).href, t); };

    await control.click('#csvBox summary');
    await control.setInputFiles('#csvFile', SAMPLE);
    await waitFor(() => control.evaluate(() => FLL.schedule && FLL.schedule.matches.length === 24));
    await shift(0, Date.now() + 30000); await cmd('set', { duration: 4000, label: 'Match' }); await sleep(500);
    check('before any referee page: ready check not in use', (await st()).refs.used === false);

    // ---------- referee pages ----------
    const R = {};
    for (const t of ['1', '2', '3', '4', '5']) R[t] = await mk(PHONE, await refUrl(t));
    await sleep(1800);
    check('opening a referee page turns the ready check on', (await st()).refs.used === true);
    const refTxt = p => p.evaluate(() => document.getElementById('ref').innerText.replace(/\s+/g, ' '));
    const rs = p => p.evaluate(() => window.__refState);
    let t1 = await refTxt(R['1']);
    check('ref T1: shows Match 1, its scheduled time and team 32778 (Servo Stars)', /Match 1\b/.test(t1) && t1.includes('32778') && t1.includes('Servo Stars') && /\d:\d\d/.test(t1), t1.slice(0, 200));
    check('ref T1: header names the table and pair', /Table 1 · Pair A/.test(await R['1'].evaluate(() => document.getElementById('tname').textContent)));
    const t5 = await refTxt(R['5']);
    check('ref T5 (not in Match 1): shows its next match, Match 2, team 79742', /Match 2\b/.test(t5) && t5.includes('79742') && /Next on the field: Match 1/.test(t5), t5.slice(0, 220));
    const picker = await mk(PHONE, `${BASE}/ref`); await sleep(1200);
    check('/ref without a table: table picker with 6 tables', (await picker.evaluate(() => document.querySelectorAll('#tables a').length)) === 6);
    await picker.screenshot({ path: path.join(SHOTS, 'v5_ref_picker_phone.png') }); await picker.context().close();
    const home = await mk({ viewport: { width: 800, height: 900 } }, `${BASE}/`); await sleep(500);
    check('index page links to the referee page with a table picker', (await home.evaluate(() => [...document.querySelectorAll('a[href^="/ref"]')].length)) === 7);
    await home.context().close();
    await R['1'].screenshot({ path: path.join(SHOTS, 'v5_ref_phone_not_ready.png') });

    // ---------- READY toggle + broadcast ----------
    await R['1'].tap('#readyBtn'); await sleep(700);   // > the ref page's ~600 ms repeat-tap guard
    { const wk = await R['1'].evaluate(() => ({ wake: FLL.wake || '', video: [...document.querySelectorAll('video')].some(v => !v.paused) }));
      check('ref page keeps the phone screen awake after the first tap', (!!wk.wake && wk.wake !== 'none') || wk.video, wk); }
    check('tap READY: server state + control see T1 ready for Match 1', (await readyOf(0)) === '1' && (await rs(R['1'])).ready === true);
    check('ref T1: button shows ✓ READY', /✓ READY/.test(await R['1'].evaluate(() => document.getElementById('readyBtn').textContent)));
    await R['1'].screenshot({ path: path.join(SHOTS, 'v5_ref_phone_ready.png') });
    await R['1'].tap('#readyBtn'); await sleep(700);
    check('tap again: toggles back to not ready', (await readyOf(0)) === '' && (await rs(R['1'])).ready === false);
    await R['1'].tap('#readyBtn'); await R['2'].tap('#readyBtn'); await sleep(500);
    check('T1 + T2 ready: broadcast to every page', (await readyOf(0)) === '1,2' && (await D.main.evaluate(() => Object.keys(FLL.readyOf(0)).sort().join(','))) === '1,2');
    check('projector (main) shows Ready tags for T1, T2 only', (await view(D.main)) === 'main' && (await tags(D.main)) === '1,2', await tags(D.main));
    check('pair A screen shows Ready tags for T1, T2', (await tags(D.A)) === '1,2', { v: await view(D.A), t: await tags(D.A) });
    check('pair C screen (next: Match 2) shows no tags', (await tags(D.C)) === '');
    check('control: T1/T2 chips ready, T3/T4 not, pill "2/4 ready"', await control.evaluate(() => {
      const c = t => document.querySelector(`#mTeams .chip[data-table="${t}"]`).className;
      return /rdy/.test(c(1)) && /rdy/.test(c(2)) && /wait/.test(c(3)) && /wait/.test(c(4)) && document.getElementById('mReady').textContent === '2/4 ready';
    }));
    check('ready mark survives a referee reconnect / reload', await (async () => { await R['2'].evaluate(() => FLL.ws.close()); await sleep(1500); await R['2'].reload(); await sleep(1500); return (await rs(R['2'])).ready === true; })());
    const bad = await R['5'].evaluate(() => FLL.cmd('refReady', { table: '5', index: 0, on: true }));
    check('server refuses READY for a table that is not in the match', !bad.ok && /isn't in that match/.test(bad.error), bad);
    const bad2 = await R['5'].evaluate(() => FLL.cmd('refReady', { table: '9', index: 1, on: true }));
    check('server refuses an unknown table', !bad2.ok && /Unknown table/.test(bad2.error), bad2);
    const bad3 = await R['5'].evaluate(() => FLL.cmd('start'));
    check('a referee page cannot run Head Ref commands', !bad3.ok && /PIN/.test(bad3.error), bad3);

    // ---------- START confirm: not all ready ----------
    await control.click('#startBtn'); await sleep(500);
    let mtxt = await modal();
    check("START with T3, T4 not ready: confirm 'Tables 3, 4 aren't ready. Start anyway?'", !!mtxt && mtxt.startsWith("Tables 3, 4 aren't ready. Start anyway?") && !/ahead/.test(mtxt), mtxt);
    check('...and the match did not start', (await st()).status === 'idle');
    await control.click('#confirmNo'); await sleep(200);
    await control.evaluate(() => document.activeElement && document.activeElement.blur());
    await control.keyboard.press('Space'); await sleep(500);
    check('Space behaves the same (prompt, no start)', !!(await modal()) && (await st()).status === 'idle');
    await control.keyboard.press('Escape'); await sleep(200);
    check('Escape cancels the prompt', !(await modal()));
    // ready tags must not show during the match: override first
    await control.click('#startBtn'); await sleep(400); await control.click('#confirmYes'); await sleep(1300);
    check('override "Start anyway": match runs', (await st()).status === 'running');
    check('while running: no Ready tags on projector or pair A', (await tags(D.main)) === '' && (await tags(D.A)) === '' && (await view(D.A)) === 'pair-playing');
    check('ref T1 while running: MATCH RUNNING, button disabled', (await rs(R['1'])).live === true && await R['1'].evaluate(() => document.getElementById('readyBtn').disabled));
    check('control hides the ready pill while running', await control.evaluate(() => document.getElementById('mReady').classList.contains('hidden')));
    await waitFor(async () => (await st()).status === 'done', 8000); await sleep(400);
    check('match end resets the ready marks', (await readyOf(0)) === '' && !Object.keys((await st()).refs.ready).includes('0'), (await st()).refs.ready);
    const t1b = await refTxt(R['1']);
    check('ref T1 after its match: moves on to Match 3 (team 84288)', /Match 3\b/.test(t1b) && t1b.includes('84288') && (await rs(R['1'])).ready === false, t1b.slice(0, 160));

    // ---------- all ready: no confirm ----------
    await shift(1, Date.now() + 30000); await sleep(300);
    const R6 = await mk(PHONE, await refUrl('6')); await sleep(1200);
    check('C refs: Match 2 is up', (await rs(R['5'])).matchIdx === 1 && (await rs(R6)).matchIdx === 1);
    // A+B refs can get ready for Match 3 while Match 2 (pair C) is up
    await R['1'].tap('#readyBtn'); await sleep(300);
    check('T1 can mark ready for its own next match (Match 3) while Match 2 is up', (await readyOf(2)) === '1');
    await R['5'].tap('#readyBtn'); await R6.tap('#readyBtn'); await sleep(500);
    check('control after Match 1 ended: pill counts the next match, "Match 2: ✓ All ready"', (await control.evaluate(() => document.getElementById('mReady').textContent)) === 'Match 2: ✓ All ready', await control.evaluate(() => document.getElementById('mReady').textContent));
    await cmd('goto', { index: 1 }); await sleep(400);
    check('clicking the match that is already up (goto same index) keeps its marks', (await readyOf(1)) === '5,6');
    check('control: "✓ All ready" + every chip ready when the whole match is ready', await control.evaluate(() => document.getElementById('mReady').textContent === '✓ All ready' && [...document.querySelectorAll('#mTeams .chip[data-table]')].every(c => /rdy/.test(c.className))));
    check('pair C screen shows Ready on T5, T6', (await tags(D.C)) === '5,6', { v: await view(D.C), t: await tags(D.C) });
    await D.main.screenshot({ path: path.join(SHOTS, 'v5_main_prematch_ready_tags.png') });
    await D.C.screenshot({ path: path.join(SHOTS, 'v5_pairC_ready_tags.png') });
    await control.click('#startBtn'); await sleep(600);
    check('all ready + on time: START has no prompt and runs', !(await modal()) && (await st()).status === 'running');
    // abort resets
    await cmd('reset'); await sleep(500);
    check('abort resets the ready marks for that match', (await readyOf(1)) === '' && (await readyOf(2)) === '1');
    // idle reset resets
    await R['5'].tap('#readyBtn'); await sleep(300); check('(T5 ready again)', (await readyOf(1)) === '5');
    await cmd('reset'); await sleep(400);
    check('RESET while idle also clears the match\'s ready marks', (await readyOf(1)) === '');
    // goto resets
    await R['5'].tap('#readyBtn'); await sleep(300);
    await cmd('goto', { delta: 1 }); await sleep(400);
    check('navigating to another match resets the ready marks of the one we left', (await readyOf(1)) === '');
    check('...the new match keeps marks refs already made for it (T1 for Match 3)', (await readyOf(2)) === '1');
    await cmd('goto', { delta: -1 }); await sleep(400);
    check('...and going back shows them not ready', (await readyOf(1)) === '' && (await rs(R['5'])).ready === false);

    // ---------- combined: ahead of schedule + not ready ----------
    await shift(1, Date.now() + 10 * 60000); await sleep(300);
    await control.click('#startBtn'); await sleep(500);
    mtxt = await modal();
    check("ahead + not ready: one combined prompt", !!mtxt && /^Tables 5, 6 aren't ready, and you're \d+ min ahead of schedule\. Start anyway\?/.test(mtxt) && /tapped READY/.test(mtxt) && /no more than 2 min early/.test(mtxt), mtxt);
    await control.click('#confirmNo');
    await R['5'].tap('#readyBtn'); await R6.tap('#readyBtn'); await sleep(400);
    await control.click('#startBtn'); await sleep(500);
    mtxt = await modal();
    check('ahead only (all ready): the original ahead prompt', !!mtxt && /^You're \d+ min ahead of schedule\. Start anyway\?/.test(mtxt), mtxt);
    await control.click('#confirmYes'); await sleep(800);
    check('...override starts it', (await st()).status === 'running');
    await cmd('reset'); await sleep(400);
    await shift(1, Date.now() + 30000);
    await control.click('#refConfirm'); await sleep(400);
    await control.click('#startBtn'); await sleep(600);
    check('Head Ref can switch the ready check off: no prompt', !(await modal()) && (await st()).status === 'running');
    await cmd('reset'); await sleep(300); await control.click('#refConfirm'); await sleep(300);
    check('...and back on', (await st()).refs.confirm === true);

    // ---------- Call Head Ref ----------
    await control.evaluate(() => { window.__callPlays = []; window.__plays = []; });
    await Promise.all(Object.values(D).map(p => p.evaluate(() => { window.__plays = []; })));
    await cmd('volume', { cue: 'call', value: 0.5 }); await sleep(300);
    await R['3'].tap('#callBtn'); await sleep(700);
    const ban = await control.evaluate(() => document.getElementById('callBanner').innerText);
    check('call: control shows a banner naming the table', /Table 3 is calling the Head Ref/.test(ban), ban);
    const plays = await control.evaluate(() => window.__plays.filter(p => p.cue === 'call'));
    check('call: the sound plays once on control, at the "call" volume (master 0.9 × 0.5)', plays.length === 1 && Math.abs(plays[0].gain - 0.45) < 0.01, plays);
    check('ref T3 shows "Head Ref called"', (await rs(R['3'])).called === 'called' && /Head Ref called/.test(await R['3'].evaluate(() => document.getElementById('callBtn').textContent)));
    await R['3'].screenshot({ path: path.join(SHOTS, 'v5_ref_phone_hr_called.png') });
    check('audience displays never show the call or play it', await (async () => {
      for (const p of Object.values(D)) { const txt = await p.evaluate(() => document.body.innerText); const pl = await p.evaluate(() => (window.__plays || []).filter(x => x.cue === 'call').length); if (/calling|Head Ref called/i.test(txt) || pl) return false; }
      return true; })());
    await R['4'].tap('#callBtn'); await sleep(700);
    check('second table calls: two banners, one more chime', (await control.evaluate(() => document.querySelectorAll('#callBanner .callrow').length)) === 2 && (await control.evaluate(() => window.__callPlays.length)) === 2);
    await R['4'].tap('#callBtn'); await sleep(500);
    check('ref can cancel its call: banner goes away', (await control.evaluate(() => document.querySelectorAll('#callBanner .callrow').length)) === 1 && (await rs(R['4'])).called === 'none');
    await control.screenshot({ path: path.join(SHOTS, 'v5_control_ready_and_call.png') });
    // no replay on reconnect / reload / late join
    await control.evaluate(() => FLL.ws.close()); await sleep(2500);
    check('control reconnect: no replayed chime, banner still there', (await control.evaluate(() => window.__callPlays.length)) === 2 && /Table 3/.test(await control.evaluate(() => document.getElementById('callBanner').innerText)));
    await control.reload(); await sleep(2500);
    check('control reload: banner restored, no chime', /Table 3/.test(await control.evaluate(() => document.getElementById('callBanner').innerText)) && (await control.evaluate(() => window.__callPlays.length)) === 0);
    const ctl2 = await mk({ viewport: { width: 1200, height: 800 } }, `${BASE}/control`, `localStorage.setItem('fll.pin','${PIN}')`); await sleep(2000);
    check('late-joining control: banner shown, no chime', /Table 3/.test(await ctl2.evaluate(() => document.getElementById('callBanner').innerText)) && (await ctl2.evaluate(() => window.__callPlays.length)) === 0);
    await control.click('#callBanner button[data-ack="3"]'); await sleep(600);
    check('"On my way ✓" acknowledges: banner gone on every control page', (await control.evaluate(() => document.getElementById('callBanner').children.length)) === 0 && (await ctl2.evaluate(() => document.getElementById('callBanner').children.length)) === 0);
    check('ref T3 sees "Head Ref is on the way"', (await rs(R['3'])).called === 'acked');
    await ctl2.context().close();
    const unauth = await R['3'].evaluate(() => FLL.cmd('callAck', { table: '3' }));
    check('a referee page cannot acknowledge calls', !unauth.ok);
    const vg = await control.evaluate(() => !!document.querySelector('#volGrid input[data-cue="call"]') && !document.querySelector('#volGrid button[data-test="call"]'));
    check('control: "Ref calls Head Ref" volume slider (Here test only, never on the screens)', vg);

    // ---------- after a field break: "Starting soon" pre-match layout keeps the Ready tags ----------
    await shift(1, Date.now() + 30000); await sleep(200);
    await R['5'].tap('#readyBtn'); await R6.tap('#readyBtn'); await sleep(300);
    await cmd('breakStart', { duration: 5000 }); await sleep(600);
    check('during a field break the marks are kept and shown on the projector', (await view(D.main)) === 'main-break' && (await tags(D.main)) === '5,6', { v: await view(D.main), t: await tags(D.main) });
    await waitFor(async () => (await view(D.main)) === 'main-prematch', 9000); await sleep(400);
    check('break over: projector "Starting soon" with Ready tags on T5, T6', (await view(D.main)) === 'main-prematch' && (await tags(D.main)) === '5,6', { v: await view(D.main), t: await tags(D.main) });
    check('break over: pair C match-ready screen with Ready tags', (await view(D.C)) === 'pair-ready' && (await tags(D.C)) === '5,6', { v: await view(D.C), t: await tags(D.C) });
    await D.main.screenshot({ path: path.join(SHOTS, 'v5_main_starting_soon_ready_tags.png') });
    await D.C.screenshot({ path: path.join(SHOTS, 'v5_pairC_starting_soon_ready_tags.png') });
    await R6.tap('#readyBtn'); await sleep(300);   // leave one not ready for the control screenshot

    // control screenshot with ready statuses + an open call
    await R['1'].tap('#callBtn'); await sleep(600);
    await control.evaluate(() => window.scrollTo(0, 0));
    await control.screenshot({ path: path.join(SHOTS, 'v5_control_ready_and_call.png') });
    await control.evaluate(() => document.getElementById('refCard').scrollIntoView());
    await control.screenshot({ path: path.join(SHOTS, 'v5_control_ref_links.png') });
    await control.click('#callBanner button[data-ack="1"]');

    // ---------- Regenerate ref links ----------
    const oldLink = await refUrl('6');
    check('each table QR link carries its own key', /[?&]k=/.test(oldLink) && oldLink !== await refUrl('5'), oldLink.replace(/k=.*/, 'k=…'));
    check('referee page with its table link is accepted', await R6.evaluate(() => FLL.refOk === true));
    await control.click('#refRegen'); await sleep(800);
    const newLink = await refUrl('6');
    check('Regenerate ref links: the QR link changes', newLink !== oldLink);
    check('Regenerate ref links: a phone on the old link is told to scan again (READY off)', await R6.evaluate(() => FLL.refOk === false && document.getElementById('readyBtn').disabled && /Scan your table/.test(document.getElementById('readySub').textContent)));
    const R6b = await mk(PHONE, newLink); await sleep(1200);
    check('Regenerate ref links: the new link works', await R6b.evaluate(() => FLL.refOk === true));
  } catch (e) { console.log('TEST CRASH', e); failed++; }
  finally {
    await browser.close(); srv.kill();
    console.log(`\n${passed} passed, ${failed} failed`); console.log(failed ? 'FAIL' : 'PASS');
    process.exit(failed ? 1 : 0);
  }
})();
