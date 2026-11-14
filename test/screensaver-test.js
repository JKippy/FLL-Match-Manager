// Ceremony screensaver (event exception for Mustang Madness).   node test/screensaver-test.js
// Head Ref toggle -> every display role (projector, pairs, gym/hallway queue, plain timer) shows only the BIOGLOW logo:
// no clock, teams, QR or corner link, and no sound of any kind (START / 0:30 / END, test plays, the Call Head Ref chime).
// A match started or running under it keeps running and is not changed. The setting is saved in state.json, so a
// display reload and a server restart keep it on; an older state.json without the field loads as off. OFF brings
// every screen straight back to its normal view.
'use strict';
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const PIN = '4321';
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const SHOTS = path.join(__dirname, '..', 'test-output', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? rej(e) : res(p)); }); });
}
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-saver-'));
const STATE = path.join(DATA, 'state.json');
let srv = null, PORT = 0;
async function startServer() {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT), '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.err = ''; srv.stderr.on('data', d => { srv.err += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout\n' + srv.err)), 8000);
    srv.stdout.on('data', d => { if (/Control/.test(String(d))) { clearTimeout(t); res(); } });
  });
}
function stopServer() {
  const p = srv; if (!p || p.exitCode != null) return Promise.resolve();
  return new Promise(res => { const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} res(); }, 3000); p.once('exit', () => { clearTimeout(t); res(); }); p.kill('SIGTERM'); });
}

// What a display shows: the logo overlay, and whether anything outside it can be seen or hit.
function saverView() {
  const s = document.getElementById('saver'), img = s && s.querySelector('img');
  const vw = innerWidth, vh = innerHeight, r = img ? img.getBoundingClientRect() : null;
  const outside = [...document.body.querySelectorAll('*')].filter(e => !s.contains(e) && e !== s);
  const seen = outside.filter(e => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none' && e.getClientRects().length > 0; });
  let hits = 0, total = 0;
  for (let x = 0.02; x < 1; x += 0.12) for (let y = 0.02; y < 1; y += 0.12) { total++; const el = document.elementFromPoint(vw * x, vh * y); if (el && (el === s || s.contains(el))) hits++; }
  const bg = getComputedStyle(s).backgroundColor;
  return { on: document.body.classList.contains('saver') && !s.classList.contains('hidden') && getComputedStyle(s).display !== 'none',
    loaded: !!(img && img.complete && img.naturalWidth > 0), src: img && img.getAttribute('src'), fit: img && getComputedStyle(img).objectFit,
    covers: !!r && r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1 && r.width > vw * 0.5,
    seen: seen.map(e => e.id || e.tagName).slice(0, 8), hits, total, bg,
    time: !!document.getElementById('time'), view: window.__view };
}

(async () => {
  PORT = await freePort();
  // An older save with no screensaver field: it must load as off.
  fs.writeFileSync(STATE, JSON.stringify({ display: { theme: 'nature', queueCount: 2 } }));
  await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const BASE = `http://127.0.0.1:${PORT}`;
  const mk = async (url, vp) => {
    const ctx = await browser.newContext({ viewport: vp || { width: 1920, height: 1080 } });
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; });
    p.on('dialog', d => d.accept()); await p.goto(url); return p;
  };
  try {
    const control = await mk(`${BASE}/control`, { width: 1366, height: 900 });
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    const cmd = (c, e) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const st = () => control.evaluate(() => FLL.state);
    check('older state.json without the field loads as OFF', await control.evaluate(() => FLL.config.display.screensaver === false && !document.getElementById('saverToggle').checked && document.getElementById('saverBanner').classList.contains('hidden')));
    const csv = await cmd('scheduleCSV', { text: fs.readFileSync(SAMPLE, 'utf8'), name: 'sample' });
    check('schedule loaded', csv.ok, csv);

    const ROLES = { main: '/display?role=main', pairA: '/display?pair=A', pairB: '/display?pair=B', pairC: '/display?pair=C', queue: '/display?role=queue', timer: '/display?role=timer' };
    const disp = {};
    for (const [k, u] of Object.entries(ROLES)) disp[k] = await mk(`${BASE}${u}&autostart=1&fs=0`);
    const ready = await waitFor(async () => { for (const p of Object.values(disp)) if (!await p.evaluate(() => !!(FLL.state && FLL.config && FLL.schedule && window.__view))) return false; return true; }, 15000);
    check('every display role is up with its normal view', ready, await Promise.all(Object.values(disp).map(p => p.evaluate(() => window.__view))));
    // Sounds that reached Sound.play's real body since the mark (a reloaded or late page starts from 0).
    const markPlays = () => Promise.all(Object.values(disp).map(p => p.evaluate(() => { window.__mark = (window.__plays || []).length; })));
    const plays = () => Promise.all(Object.entries(disp).map(async ([k, p]) => [k, await p.evaluate(() => (window.__plays || []).slice(window.__mark || 0).map(x => x.cue))]));
    // Sanity: before the screensaver, a test sound from the Head Ref reaches the displays (so "no plays" later means something).
    await cmd('testSound', { cue: 'warn' });
    check('before ON, a Head Ref test sound plays on the displays', await waitFor(async () => (await disp.main.evaluate(() => (window.__plays || []).some(x => x.cue === 'warn'))), 3000));

    // ---------- ON before match 1 ----------
    const before = await st();
    await control.click('#saverToggle');
    const allOn = async () => { for (const p of Object.values(disp)) if (!(await p.evaluate(saverView)).on) return false; return true; };
    check('ON before match 1: every display switches to the logo', await waitFor(allOn, 5000));
    check('control page stays normal and shows "Screensaver ON"', await control.evaluate(() => {
      const b = document.getElementById('saverBanner'); return !b.classList.contains('hidden') && /SCREENSAVER ON/.test(b.textContent) && document.getElementById('saverToggle').checked && getComputedStyle(document.getElementById('startBtn')).display !== 'none' && !!document.getElementById('time').textContent;
    }));
    const after = await st();
    check('ON does not touch the timer state', after.status === before.status && after.seq === before.seq && after.duration === before.duration && after.match.current === before.match.current, { before: [before.status, before.seq], after: [after.status, after.seq] });
    const views = {};
    for (const [k, p] of Object.entries(disp)) views[k] = await p.evaluate(saverView);
    for (const [k, v] of Object.entries(views))
      check(`${k}: only the BIOGLOW logo (contain, nothing else visible)`, v.on && v.loaded && v.src === '/bioglow-logo.png' && v.fit === 'contain' && v.covers && v.seen.length === 0 && v.hits === v.total && v.bg === 'rgb(15, 24, 33)', v);
    fs.mkdirSync(SHOTS, { recursive: true });
    await disp.main.screenshot({ path: path.join(SHOTS, 'screensaver-projector.png') });
    await disp.pairA.screenshot({ path: path.join(SHOTS, 'screensaver-pair.png') });

    // ---------- a match started under the screensaver keeps running, silently ----------
    await markPlays();
    await cmd('set', { duration: 35000, label: 'Match' });
    const s1 = await cmd('start', { force: true });
    check('START works while the screensaver is on', s1.ok && await waitFor(async () => (await st()).status === 'running', 3000), s1);
    const run = await st();
    check('the START cue is suppressed on the projector', await waitFor(() => disp.main.evaluate(() => window.__saverMuted.some(c => c.cue === 'start')), 4000));
    check('the 0:30 warning is suppressed on the projector', await waitFor(() => disp.main.evaluate(() => window.__saverMuted.some(c => c.cue === 'warn')), 8000));
    // OFF mid-match: the running clock is back right away; then ON again mid-match.
    await control.click('#saverToggle');
    const offMid = await waitFor(async () => { for (const p of Object.values(disp)) if ((await p.evaluate(saverView)).on) return false; return true; }, 5000);
    const mainMid = await disp.main.evaluate(() => ({ time: (document.getElementById('time') || {}).textContent, view: window.__view, vis: getComputedStyle(document.getElementById('main')).visibility }));
    check('OFF mid-match: screens show the running match again', offMid && mainMid.view === 'main' && mainMid.vis === 'visible' && /^0:[0-3]\d$/.test(mainMid.time || ''), mainMid);
    await control.click('#saverToggle');
    check('ON mid-match: logo again', await waitFor(allOn, 5000));
    const mid = await st();
    check('the match keeps running underneath (same run, start time and duration)', mid.status === 'running' && mid.runId === run.runId && mid.startAt === run.startAt && mid.duration === run.duration, { run: [run.runId, run.startAt], mid: [mid.status, mid.runId, mid.startAt] });

    // ---------- display reconnect ----------
    await disp.pairA.reload();
    check('a display that reloads comes back on the logo', await waitFor(async () => (await disp.pairA.evaluate(saverView)).on, 8000));
    const late = await mk(`${BASE}/display?role=queue&name=Hallway&autostart=1&fs=0`);
    check('a display that connects late (hallway queue) shows the logo', await waitFor(async () => (await late.evaluate(saverView)).on, 8000));
    disp.hall = late;

    // ---------- server restart mid-match ----------
    await stopServer();
    const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    check('state.json has screensaver: true', saved.display && saved.display.screensaver === true);
    await startServer();
    const back = await waitFor(async () => { for (const p of [control, ...Object.values(disp)]) if (!await p.evaluate(() => FLL.connected && FLL.synced)) return false; return true; }, 15000);
    check('after a server restart every page reconnects', back);
    check('after the restart every display still shows the logo', await allOn() && await control.evaluate(() => FLL.config.display.screensaver === true && !document.getElementById('saverBanner').classList.contains('hidden')));
    const rs = await st();
    check('the match survived the restart unchanged', rs.status === 'running' && rs.runId === run.runId && rs.startAt === run.startAt, [rs.status, rs.runId]);

    // ---------- other sounds while on: test play and the Call Head Ref chime ----------
    await cmd('testSound', { cue: 'start' });
    await cmd('testSound', { cue: 'callSoft' });
    const rc = await cmd('refCall', { table: '1' });
    check('a referee call goes through while on', rc.ok, rc);
    check('the Call Head Ref chime is suppressed on the projector', await waitFor(() => disp.main.evaluate(() => window.__saverMuted.some(c => c.cue === 'callSoft')), 4000));
    await cmd('callAck', { table: '1' }).catch(() => {});
    // END at 0:00
    check('the match ends on time underneath', await waitFor(async () => (await st()).status === 'done', 40000));
    check('the END cue is suppressed on the projector', await waitFor(() => disp.main.evaluate(() => window.__saverMuted.some(c => c.cue === 'end')), 4000));

    // ---------- during a field break ----------
    const br = await cmd('breakStart', { duration: 60000 });
    const bs = await st();
    check('a field break runs while on, and the logo stays', br.ok && bs.kind === 'break' && bs.status === 'running' && await allOn(), br);
    const now = await plays();
    const muted = await disp.main.evaluate(() => window.__saverMuted.map(c => c.cue));
    check('no display played any sound while the screensaver was on', now.every(([, cues]) => cues.length === 0) && muted.length >= 4, { now, muted });
    check('every display (and the late one) is still logo only', (await Promise.all(Object.values(disp).map(p => p.evaluate(saverView)))).every(v => v.on && v.seen.length === 0 && v.hits === v.total));

    // ---------- OFF: each screen back to its normal view ----------
    await control.click('#saverToggle');
    const offAll = await waitFor(async () => { for (const p of Object.values(disp)) { const v = await p.evaluate(saverView); if (v.on || v.seen.length === 0 || !v.view) return false; } return true; }, 5000);
    check('OFF: every display is back to its normal view', offAll, await Promise.all(Object.entries(disp).map(async ([k, p]) => [k, (await p.evaluate(saverView)).view])));
    check('OFF: the break clock and corner link are visible again', await disp.main.evaluate(() => getComputedStyle(document.getElementById('name')).visibility === 'visible' && document.getElementById('main').textContent.length > 0)
      && await disp.timer.evaluate(() => !!document.getElementById('time') && getComputedStyle(document.getElementById('time')).visibility === 'visible'));
    check('OFF: control banner gone, toggle off', await control.evaluate(() => document.getElementById('saverBanner').classList.contains('hidden') && !document.getElementById('saverToggle').checked && FLL.config.display.screensaver === false));
    await cmd('testSound', { cue: 'abort' });
    check('OFF: sound plays again', await waitFor(() => disp.main.evaluate(() => (window.__plays || []).some(x => x.cue === 'abort')), 3000));
    await cmd('breakEnd');
  } catch (e) {
    failed++; console.log('  ✗ test crashed: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    await stopServer();
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
