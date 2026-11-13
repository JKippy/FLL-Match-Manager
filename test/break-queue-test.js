// End-to-end: field breaks, queuing screen, sound packs, theme.  node test/break-queue-test.js
// Screens: control + main projector + pairs A/B/C + queue, using public/sample-schedule-6tables.csv.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 8096, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const { SHOTS } = require('./shots');   // test-output/screenshots unless --update
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-break-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  async function mk(ctxOpts, url, init) {
    const ctx = await browser.newContext(ctxOpts); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; });
    await p.goto(url); return p;
  }
  try {
    const control = await mk({ viewport: { width: 1366, height: 900 } }, `${BASE}/control`);
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    const notices = []; await control.exposeFunction('__note', t => notices.push(t));
    await control.evaluate(() => { FLL.on('notice', t => window.__note(t)); FLL.on('error', t => window.__note('ERR ' + t)); });
    const D = {
      main: await mk({ viewport: { width: 1920, height: 1080 } }, `${BASE}/display?role=main&autostart=1`, 'window.__SKEW=2500;window.__SIM_DELAY=30;window.__DEVICE_ID="m";'),
      A: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=A&autostart=1`, 'window.__SKEW=-1200;window.__SIM_DELAY=50;window.__DEVICE_ID="a";'),
      B: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=B&autostart=1`, 'window.__DEVICE_ID="b";window.__SIM_DELAY=80;'),
      C: await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display?pair=C&autostart=1`, 'window.__DEVICE_ID="c";window.__SIM_DELAY=20;'),
      Q: await mk({ viewport: { width: 1920, height: 1080 } }, `${BASE}/display?role=queue&autostart=1`, 'window.__SKEW=-4000;window.__DEVICE_ID="q";window.__SIM_DELAY=40;'),
    };
    await sleep(2500);
    const cmd = (c, e) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const view = p => p.evaluate(() => window.__view);
    const text = p => p.evaluate(() => document.getElementById('main').innerText.replace(/\s+/g, ' '));
    const st = () => control.evaluate(() => FLL.state);
    const clearLogs = () => Promise.all(Object.values(D).map(p => p.evaluate(() => { window.__cues = []; window.__plays = []; })));
    const cueLog = async () => { const o = {}; for (const [k, p] of Object.entries(D)) o[k] = await p.evaluate(() => window.__cues.map(c => c.name).join(',')); return o; };
    const shift = (idx, at) => cmd('scheduleShift', { index: idx, time: at });

    // ---- load the sample schedule through the CSV file picker ----
    await control.click('#csvBox summary');
    await control.setInputFiles('#csvFile', SAMPLE);
    for (let i = 0; i < 20 && !(await control.evaluate(() => FLL.schedule)); i++) await sleep(200);
    check('sample schedule loaded: 24 matches', (await control.evaluate(() => FLL.schedule && FLL.schedule.matches.length)) === 24);
    await shift(0, Date.now() + 30000); await sleep(700);

    // ---- defaults: nature theme + nature sound pack ----
    check('nature theme on by default', await D.main.evaluate(() => document.body.classList.contains('nature')));
    await clearLogs(); await control.click('button[data-test="start"]'); await sleep(500);
    check('default sound pack = nature', (await D.main.evaluate(() => window.__plays[0] && window.__plays[0].pack)) === 'nature');

    // ---- queue screen, idle ----
    let q = await text(D.Q);
    check('queue idle: Next = Match 1 with 4 teams + names', (await view(D.Q)) === 'queue' && /Next Match 1\b/i.test(q) && ['32778', '27469', '87440', '66894', 'Servo Stars'].every(x => q.includes(x)), q.slice(0, 200));
    check('queue idle: Then = Match 2, queuing soon = Match 3, 4', /Then Match 2\b/i.test(q) && /queuing soon.*Match 3\b.*Match 4\b/i.test(q) && !/Match 5\b/.test(q), q.slice(-260));

    // ---- full match 1 running: queue shows now playing, then abort ----
    await control.evaluate(() => window.scrollTo(0, 0)); await sleep(200);
    await control.click('#startBtn'); await sleep(2500);
    check('#60 START does not scroll the control page', (await control.evaluate(() => window.scrollY)) === 0, await control.evaluate(() => window.scrollY));
    q = await text(D.Q);
    check('queue during match 1: Now playing Match 1, Next Match 2, Then Match 3', /Now playing Match 1\b/i.test(q) && /Next Match 2\b/i.test(q) && /Then Match 3\b/i.test(q) && /Match 4\b/.test(q) && /Match 5\b/.test(q), q.slice(0, 240));
    check('queue screen plays no match sounds', (await D.Q.evaluate(() => window.__cues.length)) === 0);
    await D.Q.screenshot({ path: path.join(SHOTS, 'v3_queue_now_playing.png') });
    await D.main.screenshot({ path: path.join(SHOTS, 'v3_main_match_nature.png') });
    await D.A.screenshot({ path: path.join(SHOTS, 'v3_pairA_timer_nature.png') });
    control.once('dialog', d => d.accept()); await control.click('#resetBtn'); await sleep(600);
    check('abort cue is the gentle nature one', (await D.main.evaluate(() => (window.__plays.find(p => p.cue === 'abort') || {}).pack)) === 'nature');

    // ---- short match 1 on time, then End match session -> field break ----
    await cmd('set', { duration: 4000, label: 'Match' }); await sleep(200);
    await shift(0, Date.now()); await sleep(300);
    await control.click('#startBtn'); await sleep(5400);
    let s = await st();
    check('match 1 done → auto-advanced to match 2', s.status === 'done' && s.match.current === 1);
    q = await text(D.Q);
    check('queue updates live: Next = Match 2', /Next Match 2\b/i.test(q) && /Then Match 3\b/i.test(q), q.slice(0, 160));
    await clearLogs();
    await control.click('#endSession'); await sleep(900);
    s = await st();
    const m2 = await control.evaluate(() => FLL.schedule.matches[1].time);
    check('End match session → silent break until next match − 2 min (default target)', s.kind === 'break' && s.status === 'running' && s.breakUntil === m2 - 120000, { kind: s.kind, until: s.breakUntil - m2 });
    const remain = await D.main.evaluate(() => FLL.remaining());
    check('break length ≈ 3 min (5 min spacing − 4 s match − 2 min)', remain > 165000 && remain < 181000, remain);
    check('projector: break view, orange countdown', (await view(D.main)) === 'main-break' && (await D.main.evaluate(() => getComputedStyle(document.querySelector('.breaknote .cd')).color)) === 'rgb(255, 154, 46)');
    const mt = await text(D.main);
    check('projector: FIELD BREAK + next match time + up next Match 2 teams', /Field break/i.test(mt) && /next match in \d+:\d\d/.test(mt) && /Match 2\b/.test(mt) && /79742/.test(mt), mt.slice(0, 200));
    check('pair C: up next Match 2 with break secondary', (await view(D.C)) === 'pair-upnext-break' && /Match 2\b/.test(await text(D.C)) && /FIELD BREAK/.test(await text(D.C)));
    check('pair A: up next Match 3 during break', (await view(D.A)) === 'pair-upnext-break' && /Match 3\b/.test(await text(D.A)) && /84288/.test(await text(D.A)));
    check('#59 pair screens say "Next match on this field"; the projector keeps "Up next"', /Next match on this field/i.test(await text(D.A)) && /Next match on this field/i.test(await text(D.C)) &&
      /Up next/i.test(mt) && !/on this field/i.test(mt), { A: (await text(D.A)).slice(0, 80), main: mt.slice(0, 80) });
    q = await text(D.Q);
    check('queue: Field break + remaining time, Next Match 2', /Field break/i.test(q) && /\d:\d\d/.test(q) && /Next Match 2\b/i.test(q), q.slice(0, 160));
    await D.main.screenshot({ path: path.join(SHOTS, 'v3_main_field_break.png') });
    await D.C.screenshot({ path: path.join(SHOTS, 'v3_pairC_break_upnext.png') });
    await D.A.screenshot({ path: path.join(SHOTS, 'v3_pairA_break_upnext.png') });
    await D.Q.screenshot({ path: path.join(SHOTS, 'v3_queue_field_break.png') });
    await control.evaluate(() => window.scrollTo(0, 0));
    await control.screenshot({ path: path.join(SHOTS, 'v3_control_break_running.png') });
    // ---- #62 Lunch label: every screen says Lunch, the break itself is unchanged ----
    const b0 = await st();
    await control.check('#brkLunch'); await sleep(900);
    const b1 = await st(), lm = await text(D.main), lc = await text(D.C), lq = await text(D.Q);
    check('#62 Lunch on: projector, pair and queue screens say Lunch instead of Field break', [lm, lc, lq].every(x => /lunch/i.test(x) && !/field break/i.test(x)), { lm: lm.slice(0, 100), lc: lc.slice(0, 100), lq: lq.slice(0, 100) });
    check('#75 queue during Lunch is a wide on-a-break sign for Match 2, not the call list', /on a break/i.test(lq) && /when we're back/i.test(lq) && /matches resume at/i.test(lq) && /Match 2\b/.test(lq) && /79742/.test(lq) && /6470/.test(lq) && !/do not need to queue/i.test(lq) && !/queuing soon/i.test(lq) && !/\bNext\b/.test(lq) && !/84288/.test(lq), lq.slice(0, 400));
    const oneLine = await D.Q.evaluate(() => {
      const el = document.querySelector('.qbreak-on');
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { text: el.textContent, nowrap: s.whiteSpace === 'nowrap', lines: r.height / parseFloat(s.lineHeight), wide: r.width > 400 };
    });
    check('On a break is one wide line', oneLine.text === 'On a break' && oneLine.nowrap && oneLine.lines < 1.4 && oneLine.wide, oneLine);
    const backBefore = await D.Q.evaluate(() => document.querySelector('.qback').innerText.replace(/\s+/g, ' '));
    const t2 = await control.evaluate(() => FLL.schedule.matches[1].time);
    await cmd('scheduleShift', { index: 1, time: Date.now() - 3600000 }); await sleep(400);
    const backLate = await D.Q.evaluate(() => document.querySelector('.qback').innerText.replace(/\s+/g, ' '));
    await cmd('scheduleShift', { index: 1, time: Date.now() + 3 * 3600000 }); await sleep(400);
    const backEarly = await D.Q.evaluate(() => document.querySelector('.qback').innerText.replace(/\s+/g, ' '));
    await cmd('scheduleShift', { index: 1, time: t2 }); await sleep(300);
    check('the match we return to stays put when the break is early or late', /Match 2/.test(backBefore) && backLate === backBefore && backEarly === backBefore, { backBefore, backLate, backEarly });
    await D.Q.setViewportSize({ width: 1366, height: 768 });
    await sleep(200);
    const fit768 = await D.Q.evaluate(() => {
      const name = document.querySelector('.qname');
      const bits = [...document.querySelectorAll('.qbreak-on, .qbreak .time, .brksub, .qback-match, .qrow')];
      const inside = bits.every(el => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; });
      return {
        scrollX: document.documentElement.scrollWidth <= innerWidth + 1,
        scrollY: document.documentElement.scrollHeight <= innerHeight + 1,
        inside,
        clamp: name ? getComputedStyle(name).webkitLineClamp : '',
      };
    });
    check('1366x768 lunch sign has no scrollbar and nothing hangs off the screen', fit768.scrollX && fit768.scrollY && fit768.inside && fit768.clamp === '2', fit768);
    const longName = 'The Extraordinarily Determined Robotic Pancake Flippers';
    await D.Q.evaluate(n => { FLL.schedule.teamNames['79742'] = n; }, longName);
    await sleep(300);
    const longFit = await D.Q.evaluate(() => {
      const el = document.querySelector('.qname');
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        title: el.title, clamp: s.webkitLineClamp, whiteSpace: s.whiteSpace,
        inside: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        scrollX: document.documentElement.scrollWidth <= innerWidth + 1,
      };
    });
    check('a long team name wraps to two lines and stays on screen', longFit.title === longName && longFit.clamp === '2' && longFit.whiteSpace !== 'nowrap' && longFit.inside && longFit.scrollX, longFit);
    await D.Q.evaluate(() => { FLL.state.match.current = FLL.schedule.matches.length; });
    await sleep(200);
    const none = await D.Q.evaluate(() => ({
      back: !!document.querySelector('.qback'),
      on: document.querySelector('.qbreak-on').textContent,
      scrollX: document.documentElement.scrollWidth <= innerWidth + 1,
      scrollY: document.documentElement.scrollHeight <= innerHeight + 1,
    }));
    check('no next match hides When we\'re back and the sign still fits', none.back === false && none.on === 'On a break' && none.scrollX && none.scrollY, none);
    await D.Q.setViewportSize({ width: 1920, height: 1080 });
    await sleep(100);
    check('#62 Lunch is a label only: same break, same end time', b1.lunch === true && b1.kind === 'break' && b1.status === 'running' && b1.breakUntil === b0.breakUntil && b1.startAt === b0.startAt && b1.duration === b0.duration);
    check('#62 control status says lunch', /lunch/i.test(await control.textContent('#status')));
    // ---- #61 tap one QR code: only it stays visible; tap again or wait restores all ----
    await control.evaluate(() => { window.__QR_SOLO_MS = 1500; });
    const qrVis = () => control.evaluate(() => [...document.querySelectorAll('#qr, #refGrid .rc .q')].filter(e => getComputedStyle(e).visibility === 'visible').map(e => e.id === 'qr' ? 'display' : e.closest('.rc').dataset.table));
    const allQr = await qrVis();
    await control.click('#refGrid .rc[data-table="3"] .q'); await sleep(200);
    let qv = await qrVis();
    check('#61 tapping table 3\'s QR hides every other QR code', allQr.length >= 4 && qv.length === 1 && qv[0] === '3', { allQr, qv });
    await control.click('#refGrid .rc[data-table="3"] .q'); await sleep(200);
    check('#61 tapping it again shows them all', (await qrVis()).length === allQr.length);
    await control.click('#qr'); await sleep(200);
    qv = await qrVis();
    check('#61 tapping the screen QR shows only that one', qv.length === 1 && qv[0] === 'display', qv);
    await sleep(1800);
    check('#61 after the timeout all QR codes are back', (await qrVis()).length === allQr.length);
    await control.evaluate(() => window.scrollTo(0, 0));
    check('control shows START MATCH / END BREAK during break', (await control.textContent('#startBtn')) === 'START MATCH' && (await control.textContent('#resetBtn')) === 'END BREAK');
    await sleep(1500);
    check('no sounds at all during the break', Object.values(await cueLog()).every(x => x === ''));

    // ---- end break manually -> ready ----
    await control.click('#breakEndBtn'); await sleep(600);
    s = await st();
    check('End break → idle match timer, duration restored', s.kind === 'match' && s.status === 'idle' && s.duration === 4000);
    check('#62 Lunch label clears when that break ends', s.lunch === false && !(await control.isChecked('#brkLunch')));
    q = await text(D.Q);
    check('#75 End break brings the queue call list back', /Next Match 2\b/i.test(q) && /queuing soon/i.test(q) && !/on a break/i.test(q), q.slice(0, 200));
    check('pair C (plays match 2) goes to match-ready; pair A keeps up next', (await view(D.C)) === 'pair-ready' && (await view(D.A)) === 'pair-upnext');

    // ---- custom 6 s break runs out silently ----
    await control.fill('#breakLen', '0:06'); await control.click('#breakCustom'); await sleep(1000);
    check('custom break running', (await st()).kind === 'break');
    await D.B.screenshot({ path: path.join(SHOTS, 'v3_pairB_break_upnext.png') });
    await sleep(6000);
    s = await st();
    check('break ends by itself → ready, no sound', s.kind === 'match' && s.status === 'idle' && Object.values(await cueLog()).every(x => x === '') && ['main', 'main-prematch'].includes(await view(D.main)));

    // ---- break until next match, then START during the break ----
    await control.click('#breakNext'); await sleep(600);
    check('Break until next match', (await st()).kind === 'break');
    await clearLogs(); await control.click('#startBtn'); await sleep(400);
    check('START during the break is > 2 min early → asks to confirm', await control.evaluate(() => !document.getElementById('confirmModal').classList.contains('hidden')));
    await control.click('#confirmYes'); await sleep(1800);
    s = await st(); const cl = await cueLog();
    check('START during break → match 2 starts, start cue on main + C only', s.kind === 'match' && s.status === 'running' && s.match.live === 1 && cl.main === 'start' && cl.C === 'start' && cl.A === '' && cl.Q === '', cl);
    check('pair C shows timer', (await view(D.C)) === 'pair-playing');
    await sleep(3500);
    check('match 2 done → match 3', (await st()).match.current === 2);

    // ---- behind schedule: no break ----
    await shift(2, Date.now() - 180000); await sleep(400); notices.length = 0;
    await control.check('#brkLunch'); await sleep(500);   // #62: Lunch ticked before the break
    check('#62 Lunch can be ticked before the break', (await st()).lunch === true);
    await control.click('#endSession'); await sleep(700);
    s = await st();
    check('behind → End match session skips the break', s.kind === 'match' && s.status === 'idle' && notices.some(n => /Behind/.test(n)), notices);
    check('#62 a Lunch tick made before the break survives an End match session that skips the break', s.lunch === true && (await control.isChecked('#brkLunch')));
    q = await text(D.Q);
    check('#75 Lunch ticked but no break running: queue still calls teams', /queuing soon|Next Match/i.test(q) && !/on a break/i.test(q), q.slice(0, 180));
    check('pair A shows Up next Match 3', (await view(D.A)) === 'pair-upnext' && /Match 3\b/.test(await text(D.A)));
    notices.length = 0; await control.click('#breakNext'); await sleep(500);
    check('break until next refused when behind', (await st()).kind === 'match' && notices.some(n => /ERR/.test(n)), notices);

    // ---- automatic end of session, target 3 min, queue count 3 ----
    await control.fill('#brkAhead', '3'); await control.dispatchEvent('#brkAhead', 'change');
    await control.fill('#brkDelay', '1'); await control.dispatchEvent('#brkDelay', 'change');
    await control.check('#brkAuto');
    await control.fill('#queueCount', '3'); await control.dispatchEvent('#queueCount', 'change');
    await shift(2, Date.now()); await sleep(500);
    // Time the checks from the server's own start time, not a fixed sleep after the click: 'done' only lasts the 1 s
    // auto delay, so a slow click or a busy machine used to land the check outside that window.
    await control.click('#startBtn');
    let r3 = await st(); for (let i = 0; i < 50 && !(r3.kind === 'match' && r3.status === 'running'); i++) { await sleep(100); r3 = await st(); }
    await sleep(Math.max(0, r3.startAt + r3.duration - Date.now()) + 300);
    check('0:00 shown first (done)', (await st()).status === 'done');
    for (let i = 0; i < 40 && (await st()).kind !== 'break'; i++) await sleep(100);
    s = await st(); const m4 = await control.evaluate(() => FLL.schedule.matches[3].time);
    check('auto session → break until match 4 − 3 min (target changed to 3)', s.kind === 'break' && s.breakUntil === m4 - 180000, { kind: s.kind, d: s.breakUntil - m4 });
    q = await text(D.Q);
    check('#75 automatic lunch break: queue stays on a break', /on a break/i.test(q) && /lunch/i.test(q) && !/queuing soon/i.test(q) && !/\bNext\b/.test(q), q.slice(0, 220));
    check('#62 the Lunch tick made before the break carries into the next break', s.lunch === true && /lunch/i.test(await text(D.main)) && !/field break/i.test(await text(D.main)));
    await control.uncheck('#brkLunch'); await sleep(800);
    q = await text(D.Q);
    check('queue count 3 → 3 "queuing soon" rows during a field break (not Lunch)', (await D.Q.$$eval('.qqueue .ln', x => x.length)) === 3 && /Next Match 4\b/i.test(q) && /Match 8\b/.test(q) && !/on a break/i.test(q), q.slice(-200));
    await D.Q.screenshot({ path: path.join(SHOTS, 'v3_queue_break_count3.png') });
    await control.check('#brkLunch'); await sleep(400);
    await control.click('#breakEndBtn'); await sleep(600);
    s = await st();
    check('#62 Lunch ticked before the break clears when that break ends', s.kind === 'match' && s.lunch === false && !(await control.isChecked('#brkLunch')));

    // ---- #62 automatic End match session while behind: no break, the Lunch tick stays ----
    await control.check('#brkLunch'); await sleep(400);
    await shift(3, Date.now() - 180000); await sleep(400);
    await control.click('#startBtn');
    let r4 = await st(); for (let i = 0; i < 50 && !(r4.kind === 'match' && r4.status === 'running'); i++) { await sleep(100); r4 = await st(); }
    await sleep(Math.max(0, r4.startAt + r4.duration - Date.now()) + 300);
    for (let i = 0; i < 40 && (await st()).lastAction !== 'session'; i++) await sleep(100);
    s = await st();
    check('#62 automatic End match session when behind skips the break and keeps the Lunch tick', s.kind === 'match' && s.status === 'idle' && s.lastAction === 'session' && s.lunch === true && (await control.isChecked('#brkLunch')), { kind: s.kind, status: s.status, last: s.lastAction, lunch: s.lunch });
    await control.uncheck('#brkLunch'); await control.uncheck('#brkAuto'); await sleep(400);

    // Saturday's real schedule. The lunch gap is 11:43 AM → 12:45 PM, so the sign names that 12:45 match.
    const mustang = fs.readFileSync(path.join(__dirname, 'fixtures', 'mustang-madness-2026.csv'), 'utf8');
    const loaded = await cmd('scheduleCSV', { text: mustang, date: '2026-11-14', name: 'Mustang Madness' });
    check('Saturday schedule loads: 40 matches, no import warning', loaded.ok && (await control.evaluate(() => FLL.schedule.matches.length)) === 40 && (await control.evaluate(() => document.getElementById('schedWarn').hidden)), loaded);
    await cmd('goto', { index: 8 }); await sleep(300);
    await cmd('scheduleShift', { index: 8, time: Date.now() + 10 * 60000 }); await sleep(300);
    await cmd('breakLabel', { lunch: true });
    const sat = await cmd('endSession'); await sleep(800);
    const sq = await text(D.Q);
    check('Saturday lunch: When we\'re back is the 12:45 match on tables 1-4', sat.ok && (await st()).kind === 'break' && /on a break/i.test(sq) && /when we're back/i.test(sq) && /Match 9\b/.test(sq) && /75440/.test(sq) && /63427/.test(sq) && /38269/.test(sq) && /65886/.test(sq) && !/73079/.test(sq) && !/do not need to queue/i.test(sq), sq.slice(0, 320));

    // ---- classic pack + plain theme toggles ----
    await control.click('#packSeg button[data-pack="classic"]'); await sleep(400);
    await clearLogs(); await control.click('button[data-test="end"]'); await sleep(400);
    check('classic pack pushed to displays', (await D.A.evaluate(() => window.__plays[0] && window.__plays[0].pack)) === 'classic');
    await control.click('#themeSeg button[data-theme="plain"]'); await sleep(400);
    check('plain theme removes nature look', !(await D.main.evaluate(() => document.body.classList.contains('nature'))));
    await control.click('#themeSeg button[data-theme="nature"]'); await control.click('#packSeg button[data-pack="nature"]'); await sleep(400);
    await control.evaluate(() => window.scrollTo(0, 0));
    await control.screenshot({ path: path.join(SHOTS, 'v3_control_break_sounds.png'), fullPage: true });
    const pick = await mk({ viewport: { width: 1180, height: 820 } }, `${BASE}/display`); await sleep(500);
    check('picker has Queuing role', /Queuing/.test(await pick.textContent('#roles')));
    await pick.screenshot({ path: path.join(SHOTS, 'v3_display_role_picker.png') });
  } catch (e) { console.error(e); failed++; }
  await browser.close(); srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'FAIL' : 'PASS');
  process.exit(failed ? 1 : 0);
})();
