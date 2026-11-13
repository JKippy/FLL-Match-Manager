// Event-day rehearsal for one gym: Mustang Madness, 14 Nov 2026.
// 24 teams, 2 tables (pair A), 3 practice rounds + 3 ranking rounds, run start to finish
// with a Head Ref laptop, a phone-width Head Ref in simple mode, Firefox and Chromium
// field displays, and the hallway queue (queue server + a cloudflared stand-in).
//
//   npm run test:rehearsal
//
// Shorten the two real-time waits while debugging the script:
//   REHEARSAL_DROP_MS=2000 REHEARSAL_LOCK_MS=3000 npm run test:rehearsal
//
// Not part of test:all. The full run includes a ~35 s match, a 30 s network drop and
// a 2 min phone lock.
'use strict';
const pw = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const PIN = '918273';
const DROP_MS = Number(process.env.REHEARSAL_DROP_MS || 30000);
const LOCK_MS = Number(process.env.REHEARSAL_LOCK_MS || 120000);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SLOT = 5 * 60 * 1000;
const LUNCH_GAP = 45 * 60 * 1000;
const FULL_MATCH_MS = 35000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);
let failed = 0, passed = 0;
const scenarios = {};
function check(scenario, name, ok, detail) {
  (scenarios[scenario] = scenarios[scenario] || []).push(ok);
  ok ? passed++ : failed++;
  let extra = '';
  if (detail !== undefined && !ok) extra = '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + extra);
  return ok;
}
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const NAMES = ['Servo Stars', 'Nano Knights', 'Circuit Breakers', 'Motor Minds', 'Code Crusaders', 'Byte Builders', 'Beam Team', 'Brick Bots', 'Sprocket Squad', 'Logic Lions', 'Cog Commanders', 'Quantum Quokkas', 'Robo Rangers', 'Wheel Wizards', 'Lego Legends', 'Iron Owls', 'Spark Plugs', 'Axle Allies', 'Torque Titans', 'Rocket Rovers', 'Mech Mavericks', 'Pixel Pilots', 'Bolt Brigade', 'Gear Grinders'];

function buildSchedule() {
  let t = [...Array(24).keys()];
  const rounds = [];
  for (let r = 0; r < 6; r++) {
    const pairs = [];
    for (let i = 0; i < 12; i++) pairs.push([t[i], t[23 - i]]);
    const used = pairs.flat();
    if (new Set(used).size !== 24 || pairs.some(([a, b]) => a === b)) throw new Error('bad round ' + r);
    rounds.push(pairs);
    t = [t[0], t[23], ...t.slice(1, 23)];
  }
  const start = Date.parse('2026-11-14T09:00:00-05:00');
  const lines = ['Match,Time,Type,Table 1,Table 2'];
  const meta = [];
  for (let r = 0; r < 6; r++) {
    for (let i = 0; i < 12; i++) {
      const practice = r < 3;
      const p = r * 12 + i;
      const when = practice ? start + p * SLOT : start + 35 * SLOT + LUNCH_GAP + (p - 36) * SLOT;
      const [a, b] = rounds[r][i];
      const swap = (r + i) % 2 === 1;
      const t1 = swap ? b : a, t2 = swap ? a : b;
      const n1 = 24101 + t1, n2 = 24101 + t2;
      lines.push([p + 1, String(when), practice ? 'Practice' : 'Ranking', n1 + ' - ' + NAMES[t1], n2 + ' - ' + NAMES[t2]].join(','));
      meta.push({ practice, when, teams: [String(n1), String(n2)] });
    }
  }
  return { csv: lines.join('\n') + '\n', meta };
}

function snap(s) {
  if (!s) return null;
  return {
    status: s.status, kind: s.kind, current: s.match && s.match.current, live: s.match && s.match.live,
    startAt: s.startAt, duration: s.duration, lunch: !!s.lunch, breakUntil: s.breakUntil,
    runId: s.runId, remainingAtPause: s.remainingAtPause, ready: !!s.ready, lastAction: s.lastAction,
  };
}

(async () => {
  const sched = buildSchedule();
  const PORT = await freePort();
  const QPORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-rehearsal-'));
  const URLFILE = path.join(DATA, 'queue-public.json');
  fs.writeFileSync(path.join(DATA, 'fake-cloudflared.js'), '#!/usr/bin/env node\nconsole.log("Your quick Tunnel has been created! Visit it at");\nconsole.log("https://rehearsal-queue.trycloudflare.com");\nsetInterval(() => {}, 1000);\n');
  fs.chmodSync(path.join(DATA, 'fake-cloudflared.js'), 0o755);

  let srv = null, queueProc = null, tun = null;
  const children = [];
  function track(p) { children.push(p); return p; }

  async function startServer() {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const logBuf = { s: '' };
      const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--pin', PIN, '--data', DATA, '--queue-url-file', URLFILE], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { logBuf.s += d; });
      child.stderr.on('data', d => { logBuf.s += d; });
      try {
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('server start timeout\n' + logBuf.s.slice(-500))), 8000);
          child.stdout.on('data', d => { if (/Control/.test(d.toString())) { clearTimeout(timer); res(); } });
          child.once('exit', code => { clearTimeout(timer); rej(new Error('server exited ' + code + '\n' + logBuf.s.slice(-500))); });
        });
        srv = child;
        srv.buf = logBuf;
        return;
      } catch (e) {
        lastErr = e;
        try { child.kill('SIGKILL'); } catch (e2) {}
        await sleep(400);
      }
    }
    throw lastErr;
  }
  async function killServer() {
    const p = srv;
    if (!p || p.exitCode != null) return;
    const done = new Promise(r => p.once('exit', r));
    p.kill('SIGKILL');
    await Promise.race([done, sleep(4000)]);
    srv = null;
  }

  const chromium = await pw.chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'] });
  const firefox = await pw.firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false } });
  const browserPages = [];
  function watch(p, name) {
    browserPages.push(p);
    p.on('pageerror', e => { console.log('PAGE ERROR', name, e.message); failed++; });
  }
  async function open(browser, url, opts, init) {
    const ctx = await browser.newContext(opts || { viewport: { width: 1366, height: 768 } });
    if (init) await ctx.addInitScript(init.fn, init.arg);
    const p = await ctx.newPage();
    watch(p, url);
    p.on('dialog', d => d.accept());
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    return { ctx, p };
  }

  const waitFor = async (fn, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(80); }
    return false;
  };

  try {
    log('starting main server, queue server, cloudflared stand-in');
    await startServer();
    queueProc = track(spawn(process.execPath, [path.join(ROOT, 'queue-server.js')], {
      env: Object.assign({}, process.env, { QUEUE_PORT: String(QPORT), QUEUE_MAIN_PORT: String(PORT), QUEUE_POLL_MS: '500', QUEUE_TIMEOUT_MS: '800' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    tun = track(spawn(process.execPath, [path.join(ROOT, 'tunnel.js')], {
      env: Object.assign({}, process.env, {
        CLOUDFLARED_BIN: path.join(DATA, 'fake-cloudflared.js'),
        QUEUE_URL_FILE: URLFILE,
        QUEUE_PORT: String(QPORT),
        CLOUDFLARED_CONFIG: '',
        QUEUE_HOSTNAME: '',
      }),
      cwd: DATA,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const qUp = await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${QPORT}/queue.json`);
        return r.ok;
      } catch (e) { return false; }
    }, 8000);
    if (!qUp) throw new Error('queue server did not start');

    const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const pinInit = { fn: pin => { try { localStorage.setItem('fll.pin', pin); } catch (e) {} }, arg: PIN };
    log('opening Head Ref laptop, phone, field displays, hallway queue');
    const lapD = await open(chromium, BASE + '/control', { viewport: { width: 1366, height: 900 } }, pinInit);
    const phoneD = await open(chromium, BASE + '/control', PHONE, pinInit);
    const mainD = await open(chromium, BASE + '/display?role=main&autostart=1&name=Projector', { viewport: { width: 1280, height: 720 } }, { fn: () => { window.__DEVICE_ID = 're-main'; } });
    const pairCD = await open(chromium, BASE + '/display?pair=A&autostart=1&name=Field%20Chromium', { viewport: { width: 1366, height: 768 } }, { fn: () => { window.__DEVICE_ID = 're-pair-c'; } });
    const pairFD = await open(firefox, BASE + '/display?pair=A&autostart=1&name=Field%20Firefox', { viewport: { width: 1366, height: 768 } }, { fn: () => { window.__DEVICE_ID = 're-pair-f'; } });
    const queueD = await open(chromium, `http://127.0.0.1:${QPORT}/?poll=500`, { viewport: { width: 1280, height: 720 } });
    const lap = lapD.p, phone = phoneD.p, main = mainD.p, pairC = pairCD.p, pairF = pairFD.p, queue = queueD.p;
    const fields = [main, pairC, pairF];

    const readyCtrl = p => waitFor(() => p.evaluate(() => !!(window.FLL && FLL.authed && FLL.state && FLL.synced)), 15000);
    const readyDisp = p => waitFor(() => p.evaluate(() => !!(window.FLL && FLL.connected && FLL.synced && FLL.state)), 15000);
    if (!await readyCtrl(lap) || !await readyCtrl(phone)) throw new Error('control pages did not sign in');
    for (const p of fields) if (!await readyDisp(p)) throw new Error('a field display did not connect');

    const st = () => lap.evaluate(() => FLL.state);
    const cmd = (c, e) => lap.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const ends = p => p.evaluate(() => (window.__cues || []).filter(c => c.name === 'end').length);
    const bodyHas = (p, re) => p.evaluate(s => new RegExp(s, 'i').test(document.body.innerText), re);

    check('2-schedule', 'phone Head Ref opens in simple mode', await phone.evaluate(() => document.documentElement.classList.contains('simple')));
    check('2-schedule', 'laptop Head Ref opens the full page', !(await lap.evaluate(() => document.documentElement.classList.contains('simple'))));

    log('importing Mustang Madness schedule');
    const loaded = await lap.evaluate(text => FLL.cmd('scheduleCSV', { text, name: 'Mustang Madness', date: '2026-11-14' }), sched.csv);
    const imported = await waitFor(() => lap.evaluate(() => FLL.schedule && FLL.schedule.matches.length === 72), 8000);
    const shape = await lap.evaluate(() => {
      const m = FLL.schedule.matches;
      const teams = new Set();
      const per = {};
      for (const x of m) for (const n of Object.values(x.teams)) { teams.add(n); per[n] = per[n] || { p: 0, r: 0 }; per[n][x.practice ? 'p' : 'r']++; }
      const gaps = [];
      for (let i = 1; i < m.length; i++) gaps.push(m[i].time - m[i - 1].time);
      return {
        n: m.length, practice: m.filter(x => x.practice).length, ranking: m.filter(x => !x.practice).length,
        teams: teams.size, name: FLL.schedule.event && FLL.schedule.event.name,
        each: Object.values(per).every(v => v.p === 3 && v.r === 3),
        gapLunch: gaps[35], gapNormal: gaps[0], tables: m.every(x => Object.keys(x.teams).sort().join() === '1,2'),
        pairs: FLL.config.layout.pairs.map(p => p.id + ':' + p.tables.join('+')).join(','),
      };
    });
    check('2-schedule', 'schedule CSV loaded', loaded.ok && imported, { loaded, shape });
    check('2-schedule', '72 matches, 24 teams, 3 practice + 3 ranking, tables 1 and 2 only',
      shape.n === 72 && shape.practice === 36 && shape.ranking === 36 && shape.teams === 24 && shape.each && shape.tables, shape);
    check('2-schedule', 'event name is Mustang Madness and the lunch gap is 45 min (other slots 5 min)',
      shape.name === 'Mustang Madness' && shape.gapLunch === LUNCH_GAP && shape.gapNormal === SLOT, shape);

    const layout = await cmd('layout', { pairs: [{ id: 'A', tables: ['1', '2'] }] });
    await sleep(300);
    const pairs = await lap.evaluate(() => FLL.config.layout.pairs.map(p => p.id + ':' + p.tables.join('+')));
    check('2-schedule', 'one field pair A = tables 1 and 2', layout.ok && pairs.length === 1 && pairs[0] === 'A:1+2', pairs);

    const shifted = await cmd('scheduleShift', { index: 0, time: Date.now() + 8000 });
    check('2-schedule', 'schedule shifted so the day starts now (gaps kept)', shifted.ok === true, shifted);

    // ---------- full match: timer sync (3e) and a real start-to-finish ----------
    log('full match on both field displays (sync)');
    await cmd('set', { duration: FULL_MATCH_MS, label: 'Match' });
    await sleep(300);
    for (const p of fields) await p.evaluate(() => { window.__cues = []; window.__transitions = []; });
    await waitFor(() => pairF.evaluate(() => FLL.synced && FLL.state.duration === 35000));
    const bases = [];
    for (const p of fields) bases.push(await p.evaluate(() => Date.now() - (performance.timeOrigin + performance.now())));
    const offsetsBefore = [];
    for (const p of fields) offsetsBefore.push(await p.evaluate(() => FLL.offset));
    const tMatch = Date.now();
    const started = await cmd('start', { force: true });
    check('2-matches', 'first practice match starts', started.ok === true, started);
    const finished = await waitFor(async () => { const s = await st(); return s.status === 'done' && s.match.current === 1 && s.match.live === 0; }, FULL_MATCH_MS + 8000);
    const sDone = snap(await st());
    check('2-matches', 'first match runs to 0:00 and advances', finished, sDone);
    const cueNames = {};
    for (const [name, p] of [['projector', main], ['chromium field', pairC], ['firefox field', pairF]]) {
      cueNames[name] = await p.evaluate(() => (window.__cues || []).map(c => c.name).join(','));
    }
    check('3e-sync', 'start, 30 s warning and end each play once on projector and both fields',
      Object.values(cueNames).every(s => s === 'start,warn,end'), cueNames);
    const maxOffset = Number(process.env.SYNC_MAX_OFFSET_MS) || 45;
    const maxSpread = Number(process.env.SYNC_MAX_SPREAD_MS) || 50;
    const offErrs = offsetsBefore.map(v => Math.abs(v));
    check('3e-sync', 'clock offset error within the sync spec before the match', offErrs.every(v => v < maxOffset), { offErrs, maxOffset });
    const spreads = [];
    const maps = [];
    for (let i = 0; i < fields.length; i++) {
      const list = await fields[i].evaluate(() => (window.__transitions || []).filter(t => t.status === 'running').slice(1));
      const m = {};
      for (const item of list) if (m[item.text] == null) m[item.text] = item.at;
      maps.push(m);
    }
    const texts = Object.keys(maps[0] || {});
    for (const text of texts) {
      if (text === '0:35') continue;
      const vals = maps.map((m, i) => m[text] == null ? null : m[text] + bases[i]).filter(v => v != null);
      if (vals.length < fields.length) continue;
      spreads.push(Math.max(...vals) - Math.min(...vals));
    }
    const maxSeen = spreads.length ? Math.max(...spreads) : Infinity;
    check('3e-sync', 'second-boundary spread across Firefox and Chromium stays within the sync spec',
      spreads.length >= 8 && maxSeen < maxSpread, { samples: spreads.length, maxSeen, maxSpread, elapsed: Date.now() - tMatch });
    const cueSpread = {};
    for (const name of ['start', 'warn', 'end']) {
      const vals = [];
      for (let i = 0; i < fields.length; i++) {
        const at = await fields[i].evaluate(n => { const c = (window.__cues || []).find(x => x.name === n); return c ? c.at : null; }, name);
        if (at != null) vals.push(at + bases[i]);
      }
      cueSpread[name] = vals.length === fields.length ? Math.max(...vals) - Math.min(...vals) : null;
    }
    check('3e-sync', 'start / 30 s / end cues agree across displays within the sync spec',
      ['start', 'warn', 'end'].every(n => cueSpread[n] != null && cueSpread[n] < maxSpread), cueSpread);

    const teams0 = sched.meta[0].teams;
    // The match is already over; the field should have shown those teams. Queue still has the schedule.
    const qText = await queue.evaluate(() => document.body.innerText);
    check('2-matches', 'hallway queue is serving the schedule', /Practice/.test(qText) && teams0.every(n => qText.includes(n)) && /Last updated \d{2}:\d{2}/.test(qText), qText.slice(0, 180));

    // ---------- pause / resume from the phone ----------
    log('pause / resume from the phone');
    await cmd('set', { duration: 8000, label: 'Match' });
    await sleep(400);
    for (const p of fields) await p.evaluate(() => { window.__cues = []; });
    await phone.waitForFunction(() => /START/i.test(document.getElementById('startBtn').textContent || ''));
    await phone.click('#startBtn');
    await sleep(500);
    if (!await phone.evaluate(() => document.getElementById('confirmModal').classList.contains('hidden'))) await phone.click('#confirmYes');
    const running = await waitFor(async () => (await st()).status === 'running', 5000);
    check('2-pause', 'phone START (simple mode) runs the match', running, snap(await st()));
    await sleep(1200);
    await phone.waitForFunction(() => /PAUSE/i.test(document.getElementById('startBtn').textContent || ''));
    await phone.click('#startBtn');
    const paused = await waitFor(async () => (await st()).status === 'paused', 4000);
    const held = snap(await st());
    await sleep(1500);
    const still = snap(await st());
    const shown = [];
    for (const p of fields) shown.push(await p.evaluate(() => ({ status: FLL.state.status, text: (document.getElementById('time') || {}).textContent || '' })));
    check('2-pause', 'phone PAUSE freezes the match on the server and both fields',
      paused && still.status === 'paused' && still.remainingAtPause === held.remainingAtPause && shown.every(s => s.status === 'paused' && s.text), { held, still, shown });
    await phone.waitForFunction(() => /RESUME/i.test(document.getElementById('startBtn').textContent || ''));
    await phone.click('#startBtn');
    const resumed = await waitFor(async () => (await st()).status === 'running', 4000);
    check('2-pause', 'phone RESUME continues the match', resumed, snap(await st()));
    const pauseDone = await waitFor(async () => { const s = await st(); return s.status === 'done' && s.match.current === 2; }, 12000);
    check('2-matches', 'paused match still finishes and advances', pauseDone, snap(await st()));

    // ---------- End match session on a normal slot, then End break ----------
    log('end match session, then end break');
    const endsBeforeBreak = [];
    for (const p of fields) endsBeforeBreak.push(await ends(p));
    await phone.click('#endSession');
    // lunch is unset until a break is labelled or ended; unset means Field break.
    const broke = await waitFor(async () => { const s = await st(); return s.kind === 'break' && s.status === 'running' && !s.lunch; }, 5000);
    const br = await st();
    const nextT = await lap.evaluate(() => FLL.schedule.matches[FLL.state.match.current].time);
    const target = nextT - 2 * 60000;
    check('2-end-session', 'End match session starts a field break until 2 min before the next match',
      broke && !br.lunch && br.breakUntil === target && br.duration > 30000 && Math.abs(br.duration - (br.breakUntil - br.startAt)) < 20,
      { duration: br.duration, startAt: br.startAt, breakUntil: br.breakUntil, target, lunch: br.lunch, current: br.match.current });
    await sleep(700);
    const breakWords = {};
    for (const [name, p] of [['projector', main], ['chromium', pairC], ['firefox', pairF], ['queue', queue]]) breakWords[name] = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 240));
    check('2-end-session', 'screens say Field break and not Lunch',
      ['projector', 'chromium', 'firefox'].every(n => /field break/i.test(breakWords[n]) && !/lunch/i.test(breakWords[n])), breakWords);
    const endsDuring = [];
    for (const p of fields) endsDuring.push(await ends(p));
    check('2-end-session', 'the field break plays no extra END', endsDuring.every((n, i) => n === endsBeforeBreak[i]), { endsBeforeBreak, endsDuring });
    const phoneEnd = await phone.evaluate(() => ({ reset: document.getElementById('resetBtn').textContent, end: document.getElementById('breakEndBtn').className, simple: document.documentElement.classList.contains('simple') }));
    check('2-end-break', 'phone simple mode shows End break', phoneEnd.simple && /END BREAK/.test(phoneEnd.reset) && !/hidden/.test(phoneEnd.end), phoneEnd);
    await phone.click('#breakEndBtn');
    const endedBr = await waitFor(async () => { const s = await st(); return s.kind === 'match' && s.status === 'idle' && s.lunch === false && s.match.current === 2; }, 5000);
    check('2-end-break', 'End break leaves the next match ready', endedBr && (await st()).ready === true, snap(await st()));

    // ---------- rest of practice, compressed ----------
    log('playing the rest of practice (compressed clock)');
    async function playRange(from, to) {
      const set = await cmd('set', { duration: 1500, label: 'Match' });
      if (!set.ok) throw new Error('set duration failed: ' + (set.error || ''));
      for (let i = from; i < to; i++) {
        const cur = (await st()).match.current;
        if (cur !== i) {
          const g = await cmd('goto', { index: i });
          if (!g.ok) throw new Error('goto ' + i + ' failed: ' + g.error);
        }
        const go = await cmd('start', { force: true });
        if (!go.ok) throw new Error('start ' + i + ' failed: ' + (go.error || ''));
        const ok = await waitFor(async () => {
          const s = await st();
          const advanced = i < 71 ? s.match.current === i + 1 : s.match.current === i;
          return s.status === 'done' && s.kind === 'match' && s.match.live === i && advanced;
        }, 10000);
        if (!ok) {
          check('2-matches', 'match ' + (i + 1) + ' finished and advanced', false, snap(await st()));
          throw new Error('match index ' + i + ' did not finish');
        }
      }
    }
    await playRange(2, 35);
    check('2-matches', 'practice matches 3 through 35 finished', (await st()).match.current === 35 && (await st()).status === 'done', snap(await st()));

    // ---------- automatic lunch break from the 45 min gap ----------
    log('automatic lunch break from the 45 min gap');
    const shiftLunch = await cmd('scheduleShift', { index: 35, time: Date.now() + 2000 });
    check('2-auto-break', 'last practice match shifted to now; the 45 min gap stays', shiftLunch.ok === true, shiftLunch);
    const lunchGap = await lap.evaluate(() => FLL.schedule.matches[36].time - FLL.schedule.matches[35].time);
    check('2-auto-break', 'gap before the first ranking match is still 45 min', lunchGap === LUNCH_GAP, lunchGap);
    await phone.check('#brkLunch');
    const lunchOn = await waitFor(async () => (await st()).lunch === true, 4000);
    check('2-lunch', 'phone Lunch toggle is on before the break', lunchOn);
    const auto = await cmd('breakConfig', { auto: true, autoDelaySec: 1, aheadMin: 2, minBreakSec: 30 });
    check('2-auto-break', 'automatic end-of-match session is on for the gap', auto.ok === true, auto);
    for (const p of fields) await p.evaluate(() => { window.__cues = []; });
    await cmd('set', { duration: 1500, label: 'Match' });
    await sleep(200);
    const lunchStart = await cmd('start', { force: true });
    check('2-matches', 'last practice match starts', lunchStart.ok === true, lunchStart);
    const lunchBreak = await waitFor(async () => {
      const s = await st();
      return s.kind === 'break' && s.status === 'running' && s.lunch === true && s.match.current === 36;
    }, 10000);
    const lb = await st();
    const rankT = await lap.evaluate(() => FLL.schedule.matches[36].time);
    const expectLunch = rankT - 2 * 60000 - Date.now();
    check('2-auto-break', 'a 30+ min schedule gap starts a break on its own, about 43 min long',
      lunchBreak && lb.duration > 30 * 60000 && lb.duration < 50 * 60000 && Math.abs(lb.duration - expectLunch) < 8000,
      { duration: lb.duration, expectLunch, current: lb.match && lb.match.current });
    await sleep(800);
    const lunchWords = {};
    for (const [name, p] of [['projector', main], ['chromium', pairC], ['firefox', pairF], ['queue', queue]]) lunchWords[name] = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
    check('2-lunch', 'Lunch shows on the projector, both fields and the hallway queue',
      ['projector', 'chromium', 'firefox', 'queue'].every(n => /lunch/i.test(lunchWords[n]) && !/field break/i.test(lunchWords[n])), lunchWords);
    check('2-lunch', 'hallway queue is on a break and names the match we return to',
      /on a break/i.test(lunchWords.queue) && /when we're back/i.test(lunchWords.queue) && !/do not need to queue/i.test(lunchWords.queue) && !/queuing soon/i.test(lunchWords.queue), lunchWords.queue);
    const lunchEnds = [];
    for (const p of fields) lunchEnds.push(await ends(p));
    check('2-lunch', 'Lunch does not add an END (the match end already played once)', lunchEnds.every(n => n === 1), lunchEnds);

    // ---------- 3a: restart during the break ----------
    log('kill and restart the main server during lunch');
    const breakSnap = snap(lb);
    const qBeforeRestart = await queue.evaluate(() => ({ text: document.body.innerText.slice(0, 200), updated: document.getElementById('updated').textContent }));
    await killServer();
    await sleep(800);
    const qDuring = await queue.evaluate(() => ({ text: document.body.innerText.slice(0, 200), updated: (document.getElementById('updated').textContent || '').trim(), at: document.getElementById('updated').getAttribute('data-at') }));
    check('3a-break', 'while the laptop is down the hallway keeps the last queue and Last updated',
      /lunch/i.test(qDuring.text) && /Last updated \d{2}:\d{2}/.test(qDuring.updated) && qDuring.updated === qBeforeRestart.updated.trim(), qDuring);
    await startServer();
    const back = {};
    for (const [name, p] of [['laptop', lap], ['phone', phone], ['projector', main], ['chromium field', pairC], ['firefox field', pairF]]) {
      back[name] = await waitFor(() => p.evaluate(() => !!(FLL.connected && FLL.synced && !FLL.stale && FLL.state && (FLL.role !== 'control' || FLL.authed))), 15000);
    }
    check('3a-break', 'laptop, phone and displays reconnect on their own after a restart during lunch', Object.values(back).every(Boolean), back);
    await sleep(400);
    const br2 = snap(await st());
    check('3a-break', 'lunch break, match index and end time are the same after restart',
      br2.kind === 'break' && br2.status === 'running' && br2.lunch === true && br2.current === 36 && br2.breakUntil === breakSnap.breakUntil && br2.startAt === breakSnap.startAt,
      { before: breakSnap, after: br2 });
    const remainServer = await lap.evaluate(() => FLL.remaining());
    const remainFields = [];
    for (const p of fields) remainFields.push(await p.evaluate(() => FLL.remaining()));
    check('3a-break', 'break countdown matches across displays after restart',
      remainFields.every(r => Math.abs(r - remainServer) < 1500), { remainServer, remainFields });

    log('end lunch, then restart between matches');
    await phone.click('#breakEndBtn');
    const afterLunch = await waitFor(async () => { const s = await st(); return s.kind === 'match' && s.status === 'idle' && s.lunch === false && s.ready === true && s.match.current === 36; }, 5000);
    check('2-end-break', 'End break after lunch clears the Lunch label and readies the ranking match', afterLunch, snap(await st()));
    await cmd('breakConfig', { auto: false });
    const between = snap(await st());
    const schedN = await lap.evaluate(() => FLL.schedule.matches.length);
    await killServer();
    await sleep(500);
    await startServer();
    const back2 = {};
    for (const [name, p] of [['laptop', lap], ['phone', phone], ['projector', main], ['chromium field', pairC], ['firefox field', pairF]]) {
      back2[name] = await waitFor(() => p.evaluate(() => !!(FLL.connected && FLL.synced && !FLL.stale && FLL.state && (FLL.role !== 'control' || FLL.authed))), 15000);
    }
    check('3a-between', 'displays and the phone reconnect on their own between matches', Object.values(back2).every(Boolean), back2);
    const between2 = snap(await st());
    const schedN2 = await lap.evaluate(() => FLL.schedule && FLL.schedule.matches.length);
    check('3a-between', 'idle ranking match, schedule and break-off state survive a restart',
      between2.status === 'idle' && between2.kind === 'match' && between2.current === between.current && between2.lunch === false && between2.breakUntil == null && schedN2 === schedN && schedN2 === 72,
      { before: between, after: between2, schedN2 });

    // ---------- 3a mid-match ----------
    log('kill and restart mid-match');
    for (const p of fields) await p.evaluate(() => { window.__cues = []; });
    await cmd('set', { duration: 20000, label: 'Match' });
    await sleep(200);
    const midGo = await cmd('start', { force: true });
    check('3a-mid', 'ranking match starts before the kill', midGo.ok === true, midGo);
    await sleep(1500);
    const midBefore = snap(await st());
    const endsAtKill = [];
    for (const p of fields) endsAtKill.push(await ends(p));
    await killServer();
    await sleep(700);
    await startServer();
    const back3 = {};
    for (const [name, p] of [['laptop', lap], ['phone', phone], ['projector', main], ['chromium field', pairC], ['firefox field', pairF]]) {
      back3[name] = await waitFor(() => p.evaluate(() => !!(FLL.connected && FLL.synced && !FLL.stale && FLL.state && (FLL.role !== 'control' || FLL.authed))), 15000);
    }
    check('3a-mid', 'displays and the phone reconnect on their own mid-match', Object.values(back3).every(Boolean), back3);
    await sleep(400);
    const midAfter = snap(await st());
    const endsAfter = [];
    for (const p of fields) endsAfter.push(await ends(p));
    check('3a-mid', 'same match keeps running from the same start time, no false END',
      midAfter.status === 'running' && midAfter.kind === 'match' && midAfter.current === midBefore.current && midAfter.live === midBefore.live && midAfter.startAt === midBefore.startAt && midAfter.runId === midBefore.runId && midAfter.lunch === false && endsAfter.every((n, i) => n === endsAtKill[i] && n === 0),
      { before: midBefore, after: midAfter, endsAtKill, endsAfter });
    const midRemain = await lap.evaluate(() => FLL.remaining());
    const midFieldR = [];
    for (const p of fields) midFieldR.push(await p.evaluate(() => FLL.remaining()));
    check('3a-mid', 'displays resync to the server clock after the restart', midFieldR.every(r => Math.abs(r - midRemain) < 1500) && midRemain > 5000, { midRemain, midFieldR });
    const midFinished = await waitFor(async () => { const s = await st(); return s.status === 'done' && s.match.current === midBefore.current + 1; }, 25000);
    const endsFinal = [];
    for (const p of fields) endsFinal.push(await ends(p));
    check('3a-mid', 'the recovered match ends once and advances', midFinished && endsFinal.every(n => n === 1), { snap: snap(await st()), endsFinal });

    // ---------- 3b network drop on a field display ----------
    // Chromium's offline mode actually black-holes the socket. Firefox's does not
    // (navigator.onLine flips, the existing WebSocket stays up), so the dropped
    // screen is the Chromium field laptop. The Firefox field is the one that stays up.
    log('drop the Chromium field network for ' + DROP_MS + ' ms');
    await cmd('set', { duration: 150000, label: 'Match' });
    await sleep(200);
    for (const p of fields) await p.evaluate(() => { window.__cues = []; document.body.classList.remove('flash-end'); });
    const dropGo = await cmd('start', { force: true });
    check('3b-drop', 'long match is running before the network drop', dropGo.ok && (await st()).status === 'running', snap(await st()));
    await sleep(1000);
    const runDuringDrop = (await st()).runId;
    await pairCD.ctx.setOffline(true);
    const wentOff = await waitFor(() => pairC.evaluate(() => navigator.onLine === false && !FLL.connected), 8000);
    check('3b-drop', 'Chromium field loses the network', wentOff);
    await sleep(DROP_MS);
    const duringDrop = await pairC.evaluate(() => ({
      ends: (window.__cues || []).filter(c => c.name === 'end').length,
      text: (document.getElementById('time') || {}).textContent || '',
      flash: document.body.classList.contains('flash-end'),
      banner: (document.querySelector('.banner') || {}).textContent || document.body.innerText.slice(0, 120),
      offline: FLL.offline,
    }));
    const foxStill = await pairF.evaluate(() => ({ connected: FLL.connected, status: FLL.state && FLL.state.status, ends: (window.__cues || []).filter(c => c.name === 'end').length }));
    const serverDuring = snap(await st());
    check('3b-drop', 'dropped field plays no END while the match is still going',
      duringDrop.ends === 0 && duringDrop.text !== '0:00' && !duringDrop.flash && !/time!/i.test(duringDrop.banner) && serverDuring.status === 'running' && serverDuring.runId === runDuringDrop, { duringDrop, serverDuring });
    check('3b-drop', 'Firefox field stays with the server during the other screen\'s outage',
      foxStill.connected && foxStill.status === 'running' && foxStill.ends === 0, foxStill);
    await pairCD.ctx.setOffline(false);
    const resynced = await waitFor(() => pairC.evaluate(() => FLL.connected && FLL.synced && !FLL.stale && !FLL.offline && navigator.onLine !== false), 15000);
    await sleep(600);
    const afterDrop = await pairC.evaluate(() => ({ ends: (window.__cues || []).filter(c => c.name === 'end').length, r: FLL.remaining(), status: FLL.state.status, text: (document.getElementById('time') || {}).textContent || '' }));
    const serverR = await lap.evaluate(() => FLL.remaining());
    check('3b-drop', 'Chromium field resyncs to the running match and still does not play END',
      resynced && afterDrop.status === 'running' && afterDrop.ends === 0 && Math.abs(afterDrop.r - serverR) < 1500 && afterDrop.text !== '0:00', { afterDrop, serverR });

    // ---------- 3c queue server + cloudflared ----------
    log('kill queue server and cloudflared');
    const fieldBeforeQ = snap(await st());
    const liveTeams = await lap.evaluate(() => {
      const m = FLL.schedule.matches[FLL.state.match.live];
      return m ? Object.values(m.teams) : [];
    });
    await sleep(600);
    const qLive = await queue.evaluate(() => ({
      text: document.body.innerText,
      updated: (document.getElementById('updated').textContent || '').trim(),
      at: document.getElementById('updated').getAttribute('data-at'),
      stale: document.getElementById('updated').classList.contains('stale'),
    }));
    check('3c-queue', 'hallway has live queue data and Last updated before the kill',
      /Last updated \d{2}:\d{2}/.test(qLive.updated) && liveTeams.every(n => qLive.text.includes(n)), { updated: qLive.updated, teams: liveTeams });
    const killChild = proc => new Promise(r => { if (!proc || proc.exitCode != null) return r(); proc.once('exit', r); try { proc.kill('SIGKILL'); } catch (e) { r(); } });
    await killChild(queueProc); queueProc = null;
    await killChild(tun); tun = null;
    const wentStale = await waitFor(() => queue.evaluate(() => document.getElementById('updated').classList.contains('stale')), 8000);
    const qDead = await queue.evaluate(() => ({
      text: document.body.innerText,
      updated: (document.getElementById('updated').textContent || '').trim(),
      at: document.getElementById('updated').getAttribute('data-at'),
      stale: document.getElementById('updated').classList.contains('stale'),
    }));
    const fieldAfterQ = snap(await st());
    const chromeLive = await pairC.evaluate(() => FLL.connected && FLL.state && FLL.state.status);
    check('3c-queue', 'killing the queue server and cloudflared does not change the running field',
      fieldAfterQ.status === 'running' && fieldAfterQ.startAt === fieldBeforeQ.startAt && fieldAfterQ.runId === fieldBeforeQ.runId && chromeLive === 'running', { before: fieldBeforeQ, after: fieldAfterQ, chromeLive });
    check('3c-queue', 'hallway page keeps the last teams and shows Last updated as stale',
      wentStale && qDead.stale === true && qDead.updated === qLive.updated && qDead.at === qLive.at && /^Last updated \d{2}:\d{2}$/.test(qDead.updated) && liveTeams.every(n => qDead.text.includes(n)),
      { before: qLive.updated, after: qDead.updated, stale: qDead.stale, wentStale });

    // Field still accepts a pause from the laptop while the queue is dead, then we stop this long match.
    const pausedOk = await cmd('pause');
    check('3c-queue', 'Head Ref can still pause the field while the queue is dead', pausedOk.ok && (await st()).status === 'paused', snap(await st()));
    await cmd('reset');
    await waitFor(async () => (await st()).status === 'idle', 4000);

    // ---------- finish the ranking rounds ----------
    log('finishing the ranking rounds');
    const resumeAt = (await st()).match.current;
    await playRange(resumeAt, 72);
    const finalS = snap(await st());
    const played = await lap.evaluate(() => Object.keys(FLL.state.match.actualStarts).length);
    check('2-matches', 'all 72 matches have been started and the last one is done',
      finalS.status === 'done' && finalS.current === 71 && finalS.live === 71 && played === 72, { finalS, played });

    // ---------- 3d phone background / lock ----------
    log('phone backgrounded for ' + LOCK_MS + ' ms');
    await cmd('set', { duration: 20000, label: 'Match' });
    await sleep(300);
    await cmd('goto', { index: 71 });
    const cdp = await phone.context().newCDPSession(phone);
    await phoneD.ctx.setOffline(true);
    let froze = false;
    try { await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); froze = true; } catch (e) { log('lifecycle freeze unavailable (' + e.message + '); using offline + hidden'); }
    if (!froze) {
      await phone.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      }).catch(() => {});
    }
    await sleep(LOCK_MS);
    if (froze) { try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch (e) { log('unfreeze: ' + e.message); } }
    await phoneD.ctx.setOffline(false);
    await phone.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    }).catch(() => {});
    const phoneBack = await waitFor(() => phone.evaluate(() => FLL.connected && FLL.authed && FLL.synced && !FLL.stale), 12000);
    check('3d-phone', 'phone reconnects on its own after being locked', phoneBack, await phone.evaluate(() => ({ connected: FLL.connected, authed: FLL.authed, synced: FLL.synced, stale: FLL.stale })).catch(e => e.message));
    const stillSimple = await phone.evaluate(() => document.documentElement.classList.contains('simple'));
    check('3d-phone', 'phone is still in simple mode', stillSimple);
    await phone.waitForFunction(() => { const b = document.getElementById('startBtn'); return b && /START/i.test(b.textContent || ''); }, { timeout: 8000 }).catch(() => {});
    await phone.click('#startBtn');
    await sleep(600);
    if (!await phone.evaluate(() => document.getElementById('confirmModal').classList.contains('hidden'))) await phone.click('#confirmYes');
    const phoneRan = await waitFor(async () => (await st()).status === 'running', 6000);
    check('3d-phone', 'phone START still runs a match after the lock', phoneRan, snap(await st()));
    await sleep(500);
    await phone.waitForFunction(() => /PAUSE/i.test((document.getElementById('startBtn').textContent || ''))).catch(() => {});
    await phone.click('#startBtn');
    const phonePaused = await waitFor(async () => (await st()).status === 'paused', 5000);
    check('3d-phone', 'phone PAUSE still works after the lock', phonePaused, snap(await st()));
    await cmd('reset');
  } catch (e) {
    console.log('ERROR', e && e.stack || e);
    failed++;
    if (srv && srv.buf) console.log('SERVER', srv.buf.s.slice(-800));
  } finally {
    for (const p of browserPages) await p.close().catch(() => {});
    await chromium.close().catch(() => {});
    await firefox.close().catch(() => {});
    for (const c of [srv, queueProc, tun, ...children]) { try { if (c && c.exitCode == null) c.kill('SIGKILL'); } catch (e) {} }
  }

  console.log('\nScenario summary');
  const order = ['2-schedule', '2-matches', '2-pause', '2-end-session', '2-end-break', '2-lunch', '2-auto-break', '3a-mid', '3a-between', '3a-break', '3b-drop', '3c-queue', '3d-phone', '3e-sync'];
  let scenarioFails = 0;
  for (const id of order) {
    const rows = scenarios[id] || [];
    const ok = rows.length > 0 && rows.every(Boolean);
    if (!ok) scenarioFails++;
    console.log((ok ? '  PASS ' : '  FAIL ') + id + '  (' + rows.filter(Boolean).length + '/' + rows.length + ')');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed || scenarioFails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
