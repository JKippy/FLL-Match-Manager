// v0.5.1 robustness regression tests (Testing & Validation findings + projector call chime).   node test/robust-test.js
// Request parsing hardening, CSV limits, device id validation, clients list only for authed controls, PIN limits,
// goto validation + stale NEXT refusal, persist-before-ack (kill -9), corrupt state.json -> .bak, restart across a match end,
// END from the local clock while the server is down (once), heartbeat stall -> stale -> no cues, control-page write-on-change,
// iOS revive hooks + sound hint, soft call chime on the projector only (one-shot, no replay, own volume, nothing visual).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');
const Sched = require('../lib/schedule');
const PORT = 8095, PIN = '4321', BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-robust-'));
const STATE = path.join(DATA, 'state.json');
let srv = null;
async function startServer() {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', PORT, '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.errText = ''; srv.stderr.on('data', d => { srv.errText += d; });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
}
async function stopServer(sig) { const p = srv; if (!p || p.exitCode != null) return; const done = new Promise(r => p.once('exit', r)); p.kill(sig || 'SIGTERM'); await done; }
function raw(text) {   // send raw bytes, return the status line (or '' if the socket just closed)
  return new Promise(res => { const s = net.connect(PORT, '127.0.0.1', () => s.write(text)); let b = '';
    s.on('data', d => b += d); s.on('close', () => res(b.split('\r\n')[0])); s.on('error', () => res(b.split('\r\n')[0])); setTimeout(() => { s.destroy(); }, 1500); });
}
function req(method, p, headers, body) {
  return new Promise(res => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ status: x.statusCode, body: b })); });
    r.on('error', e => res({ status: 0, body: e.message })); if (body) r.write(body); r.end(); });
}

(async () => {
  await startServer();
  // ---------- 1. malformed requests ----------
  check('request parsing: bad request line -> 400', /400/.test(await raw('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n')));
  check('request parsing: bad upgrade -> 400', /400/.test(await raw('GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')));
  const up = await req('POST', '/api/sound/start', { 'X-File-Name': '%', 'X-FLL-PIN': PIN, 'Content-Type': 'audio/wav' }, Buffer.alloc(100));
  check('request parsing: bad upload header -> 400', up.status === 400, up);
  await raw('garbage\r\n\r\n');
  check('server healthy after request parsing checks', (await req('GET', '/')).status === 200 && srv.exitCode == null);

  // ---------- 6. CSV caps ----------
  const big = 'Match,Time,Table 1,Table 2\n' + Array.from({ length: 30000 }, (_, i) => `${i + 1},9:00,${100 + i},${200 + i}`).join('\n');
  let t0 = Date.now(), err = null; try { Sched.parseCSV(big); } catch (e) { err = e.message; }
  check('oversized CSV is refused quickly', !!err && Date.now() - t0 < 500, { err, ms: Date.now() - t0 });
  const okCsv = 'Match,Time,Table 1,Table 2\n' + Array.from({ length: 1500 }, (_, i) => `${i + 1},9:00,${100 + i},${200 + i}`).join('\n');
  t0 = Date.now(); const s15 = Sched.parseCSV(okCsv);
  check('1500-match CSV still parses fast', s15.matches.length === 1500 && Date.now() - t0 < 1000, { n: s15.matches.length, ms: Date.now() - t0 });

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const pages = [];
  async function mk(url, init, vp) {
    const ctx = await browser.newContext({ viewport: vp || { width: 1366, height: 900 } }); if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', url, e.message); failed++; }); p.on('dialog', d => d.accept());
    await p.goto(url); pages.push(p); return p;
  }
  const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
  try {
    const control = await mk(`${BASE}/control`, 'window.__DEVICE_ID="ctl";');
    await control.waitForSelector('#pinModal:not(.hidden)', { state: 'attached' });
    await control.fill('#pinInput', PIN); await control.click('#pinBtn');
    await control.waitForSelector('#pinModal.hidden', { state: 'attached' });
    const cmd = (c, e) => control.evaluate(([c, e]) => FLL.cmd(c, e || {}), [c, e]);
    const st = () => control.evaluate(() => FLL.state);

    // ---------- 6. __proto__ id, clients list ----------
    const evil = await mk(`${BASE}/display?role=main&autostart=1`, 'window.__DEVICE_ID="__proto__";');
    await sleep(800);
    check('reserved device id is handled safely', srv.exitCode == null && (await req('GET', '/')).status === 200);
    const r1 = await cmd('displayPref', { deviceId: '__proto__', vol: 0.5 });
    check('displayPref for a reserved id is refused', r1.ok === false, r1);
    await evil.close();
    const anon = await mk(`${BASE}/control`, 'window.__clientsSeen=0;');
    await anon.evaluate(() => FLL.on('clients', () => window.__clientsSeen++));
    await sleep(1500);
    check('clients list only for signed-in controls', await anon.evaluate(() => window.__clientsSeen) === 0);

    // ---------- 5. PIN lockout ----------
    await anon.evaluate(() => { window.__auth = []; FLL.on('auth', (ok, m) => window.__auth.push({ ok, error: m && m.error, retryIn: m && m.retryIn })); });
    for (let i = 0; i < 6; i++) { await anon.evaluate(() => FLL.send({ t: 'auth', pin: '0000' })); await sleep(60); }
    await sleep(200);
    let auths = await anon.evaluate(() => window.__auth);
    const locked = auths[auths.length - 1];
    check('repeated wrong PINs get a retry delay', locked && !locked.ok && locked.retryIn > 0 && /try again|wait|locked/i.test(locked.error || ''), auths.slice(-2));
    await anon.evaluate(p => FLL.send({ t: 'auth', pin: p }), PIN); await sleep(200);
    auths = await anon.evaluate(() => window.__auth);
    check('PIN waits for the retry delay', auths[auths.length - 1].ok === false);
    await sleep((locked.retryIn || 1000) + 300);
    await anon.evaluate(p => FLL.send({ t: 'auth', pin: p }), PIN); await sleep(300);
    auths = await anon.evaluate(() => window.__auth);
    check('correct PIN works after the delay', auths[auths.length - 1].ok === true, auths[auths.length - 1]);
    const lockedUp = await req('POST', '/api/sound/start', { 'X-File-Name': 'a.wav', 'X-FLL-PIN': 'bad', 'Content-Type': 'audio/wav' }, Buffer.alloc(10));
    check('wrong PIN on upload is refused', [401, 403, 429].includes(lockedUp.status), lockedUp.status);
    await anon.close();

    // ---------- schedule ----------
    await control.click('#csvBox summary'); await control.setInputFiles('#csvFile', SAMPLE);
    await waitFor(() => control.evaluate(() => FLL.schedule && FLL.schedule.matches.length === 24));
    await cmd('scheduleShift', { index: 0, time: Date.now() + 600000 });

    // ---------- 6/5. goto validation + stale ----------
    let r = await cmd('goto', { index: 'abc' }); check("goto 'abc' is refused", r.ok === false, r);
    r = await cmd('goto', { index: 999 }); check('goto out of range is refused', r.ok === false, r);
    r = await cmd('goto', { index: 1.5 }); check('goto non-integer is refused', r.ok === false, r);
    await cmd('goto', { index: 0 });
    r = await cmd('goto', { delta: 1, from: 0 }); const r2 = await cmd('goto', { delta: 1, from: 0 });
    check('NEXT carries the expected index; the stale second one is refused', r.ok && !r2.ok && r2.code === 'stale' && (await st()).match.current === 1, { r, r2 });
    const toasts = () => control.evaluate(() => document.getElementById('toast').textContent);
    await control.evaluate(() => { const b = document.getElementById('nextBtn'); b.click(); b.click(); });
    await sleep(600);
    check('double-click on NEXT moves exactly one match', (await st()).match.current === 2, { current: (await st()).match.current, toasts: await toasts() });
    await cmd('goto', { index: 0 });

    // ---------- 7. control page writes only on change ----------
    await cmd('set', { duration: 6000, label: 'Match' });
    await control.evaluate(() => { window.__timeWrites = 0; new MutationObserver(l => window.__timeWrites += l.length).observe(document.getElementById('time'), { attributes: true, attributeFilter: ['class'] }); });
    await cmd('start', { force: true }); await sleep(2500);
    const tw = await control.evaluate(() => window.__timeWrites);
    check('#time className is not rewritten every frame while running', tw <= 4, { writes: tw });
    await cmd('stop').catch(() => {}); await cmd('reset'); await sleep(300);
    await control.evaluate(() => { window.__aa = []; const cb = document.getElementById('autoAdv'); const iv = setInterval(() => window.__aa.push(cb.checked), 15); setTimeout(() => clearInterval(iv), 900);
      cb.click(); for (let i = 0; i < 20; i++) setTimeout(() => FLL.emit('state', { state: FLL.state }), i * 20); });
    await sleep(1100);
    const aa = await control.evaluate(() => window.__aa);
    check('auto-advance checkbox never flips back while its change awaits the ack', aa.length > 10 && aa.every(v => v === aa[0]) && (await st()).match.autoAdvance === aa[0], { first: aa[0], flips: aa.filter((v, i) => i && v !== aa[i - 1]).length });
    if ((await st()).match.autoAdvance === false) await control.click('#autoAdv');
    await sleep(300);

    // ---------- 9. projector call chime ----------
    const main = await mk(`${BASE}/display?role=main&autostart=1`, 'window.__DEVICE_ID="main1";', { width: 1920, height: 1080 });
    const pairA = await mk(`${BASE}/display?pair=A&autostart=1`, 'window.__DEVICE_ID="pa";');
    await waitFor(() => control.evaluate(() => !!document.querySelector('#refGrid .rc[data-table="1"] a[href*="k="]')));
    const ref1 = await mk(await control.evaluate(() => document.querySelector('#refGrid .rc[data-table="1"] a').href), null, { width: 390, height: 844 });
    await sleep(1500);
    const plays = (p, cue) => p.evaluate(c => (window.__plays || []).filter(x => x.cue === c && !x.test), cue);
    const mainText = () => main.evaluate(() => document.body.innerText.replace(/\d+:\d\d/g, '').replace(/\s+/g, ' '));
    const before = await mainText(), domBefore = await main.evaluate(() => document.querySelectorAll('*').length);
    await ref1.evaluate(() => FLL.cmd('refCall', { table: '1' }));
    await sleep(800);
    let mp = await plays(main, 'callSoft');
    check('projector plays the soft call chime once', mp.length === 1 && (await main.evaluate(() => window.__chimes.length)) === 1, mp);
    const startGain = (await main.evaluate(() => FLLSound.gainFor('start')));
    check('call chime is quieter than the match cues by default', mp[0] && mp[0].gain > 0 && mp[0].gain < startGain * 0.6, { chime: mp[0] && mp[0].gain, start: startGain });
    check('control page still plays its own call cue', (await control.evaluate(() => window.__callPlays.length)) === 1);
    check('pair screen stays silent', (await plays(pairA, 'callSoft')).length === 0 && (await plays(pairA, 'call')).length === 0);
    const after = await mainText();
    check('nothing visual on the projector (no table / Head Ref text, no new elements)', after === before && !/head ref|call/i.test(after), { before: before.slice(0, 120), after: after.slice(0, 120), domBefore, domAfter: await main.evaluate(() => document.querySelectorAll('*').length) });
    await main.evaluate(() => FLL._lost(false)); await sleep(2000);
    check('no replay after the projector reconnects', (await plays(main, 'callSoft')).length === 1);
    await ref1.evaluate(() => FLL.cmd('refCall', { table: '1' })); await sleep(500);
    check('pressing Call again for the same open call does not re-chime', (await plays(main, 'callSoft')).length === 1);
    await main.reload(); await sleep(1500);
    check('no replay on reload / late join', (await plays(main, 'callSoft')).length === 0);
    const late = await mk(`${BASE}/display?role=main&autostart=1`, 'window.__DEVICE_ID="main2";'); await sleep(1500);
    check('a projector joining late does not chime', (await plays(late, 'callSoft')).length === 0);
    await cmd('volume', { cue: 'callMain', value: 0.1 }); await sleep(300);
    await cmd('displayPref', { deviceId: 'main1', vol: 0.5 }); await sleep(300);
    await ref1.evaluate(() => FLL.cmd('refCancel', { table: '1' })); await ref1.evaluate(() => FLL.cmd('refCall', { table: '1' })); await sleep(700);
    check('cancel + call again right away does not chime twice', (await plays(main, 'callSoft')).length === 0);
    await cmd('callAck', { table: '1' }); await ref1.evaluate(() => FLL.cmd('refCall', { table: '1' })); await sleep(700);
    mp = await plays(main, 'callSoft');
    const master = (await st()) && (await control.evaluate(() => FLLSound.cfg.master));
    check('new call chimes again with its own volume x per-display volume', mp.length === 1 && Math.abs(mp[0].gain - master * 0.1 * 0.5) < 0.01, { mp, master });
    check('control has a "Call chime on projector" slider', await control.evaluate(() => !!document.querySelector('#volGrid input[data-cue="callMain"]')));
    await control.evaluate(() => document.querySelector('#volGrid [data-test="callSoft"]').click()); await sleep(500);
    check('"▶ Projector" test plays only on projectors', (await main.evaluate(() => (window.__plays || []).filter(x => x.cue === 'callSoft' && x.test).length)) === 1 &&
      (await pairA.evaluate(() => (window.__plays || []).filter(x => x.cue === 'callSoft').length)) === 0);
    await cmd('displayPref', { deviceId: 'main1', vol: 1 }); await ref1.evaluate(() => FLL.cmd('refCancel', { table: '1' }));
    await late.close(); await ref1.close(); await pairA.close();

    // ---------- 8. iOS revive + sound hint ----------
    const rv0 = await main.evaluate(() => (window.__revives || []).length);
    await main.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); });
    await sleep(300);
    check('visibilitychange/pageshow run the revive (wake + audio + link check)', (await main.evaluate(() => (window.__revives || []).length)) > rv0);
    await main.evaluate(async () => { await FLLSound.ctx.suspend(); FLL.updateSoundHint(); });
    const hint = await main.evaluate(() => { const h = document.getElementById('soundHint'); return h && getComputedStyle(h).display !== 'none' ? h.textContent : null; });
    check('suspended audio shows the "tap to re-enable sound" hint', !!hint && /tap/i.test(hint), hint);
    await main.evaluate(async () => { await FLLSound.ctx.resume(); FLL.updateSoundHint(); });
    check('hint hides once audio runs again', await main.evaluate(() => { const h = document.getElementById('soundHint'); return !h || getComputedStyle(h).display === 'none'; }));

    // ---------- 2. heartbeat: frozen server -> stale -> no cues ----------
    const hb = await mk(`${BASE}/display?role=main&autostart=1`, 'window.__DEVICE_ID="hb";window.__HB_MS=1500;');
    await sleep(1500);
    await cmd('set', { duration: 3000, label: 'Match' }); await hb.evaluate(() => window.__cues = []);
    await cmd('start', { force: true }); await sleep(800);
    srv.kill('SIGSTOP'); await sleep(4000);
    const hbv = await hb.evaluate(() => ({ connected: FLL.connected, stale: FLL.stale, cues: window.__cues.map(c => c.name).join(',') }));
    check('frozen server: display notices (stale, disconnected) and plays no END', hbv.stale === true && hbv.connected === false && !/end/.test(hbv.cues), hbv);
    srv.kill('SIGCONT');
    check('recovers after the server unfreezes', await waitFor(() => hb.evaluate(() => FLL.connected && FLL.synced && !FLL.stale), 8000));
    await sleep(500);
    const hbc = await hb.evaluate(() => window.__cues.filter(c => c.name === 'end').length);
    check('END still at most once after recovery', hbc <= 1, hbc);
    await hb.close();
    await waitFor(() => control.evaluate(() => FLL.connected && FLL.synced));
    await cmd('reset'); await cmd('goto', { index: 0 }); await sleep(300);

    // ---------- 3. END from the local clock while the server is down ----------
    await cmd('set', { duration: 2500, label: 'Match' }); await sleep(200);
    await main.evaluate(() => window.__cues = []);
    await cmd('start', { force: true }); await sleep(600);
    const runId = (await st()).runId;
    await stopServer('SIGTERM'); await sleep(3200);
    const down = await main.evaluate(() => ({ cues: window.__cues.map(c => c.name).join(','), connected: FLL.connected }));
    check('server down at 0:00: END still plays from the local clock', /end/.test(down.cues) && !down.connected, down);
    await startServer();
    await waitFor(() => main.evaluate(() => FLL.connected && FLL.synced), 8000); await sleep(1200);
    const upc = await main.evaluate(() => window.__cues.filter(c => c.name === 'end').length);
    check('no second END after reconnect', upc === 1, upc);
    await waitFor(() => control.evaluate(() => FLL.connected && FLL.synced), 8000);
    const s3 = await st();
    check('restart across the match end: match finalized and advanced', s3.status === 'done' && s3.lastAction === 'end' && s3.match.current === 1 && s3.runId === runId, { status: s3.status, lastAction: s3.lastAction, current: s3.match.current });

    // ---------- 4. persist before ack (kill -9) + corrupt state.json ----------
    await cmd('reset');
    const ack = await cmd('set', { duration: 4321, label: 'Match' });
    const st4 = await st();
    await stopServer('SIGKILL');
    const disk = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    check('acked command is on disk immediately (kill -9 right after the ack)', ack.ok && disk.timer.duration === 4321 && st4.duration === 4321, { dur: disk.timer && disk.timer.duration });
    check('no leftover tmp file', !fs.readdirSync(DATA).some(f => /\.tmp/.test(f)));
    if (!fs.existsSync(STATE + '.bak')) fs.copyFileSync(STATE, STATE + '.bak');
    fs.writeFileSync(STATE, '{"timer":{"dur');   // truncated
    await startServer();
    check('corrupt state.json: falls back to state.json.bak and warns loudly', /!!!/.test(srv.errText) && /backup/i.test(srv.errText), srv.errText.slice(0, 200));
    check('corrupt file kept for inspection', fs.readdirSync(DATA).some(f => /corrupt/.test(f)));
    await waitFor(() => control.evaluate(() => FLL.connected && FLL.synced), 8000);
    const s4 = await st();
    check('schedule restored from the backup', s4 && (await control.evaluate(() => FLL.schedule && FLL.schedule.matches.length)) === 24);

    // ---------- CSV import that drops teams says so on the control page ----------
    const lossy = await cmd('scheduleCSV', { text: 'Match,Time,Table 1,Red,Table 2\n1,9:30,111,222,333\n2,9:35,444,555,666\n', name: 'lossy' });
    await waitFor(() => control.evaluate(() => !document.getElementById('schedWarn').hidden), 3000);
    const w = await control.evaluate(() => ({ hidden: document.getElementById('schedWarn').hidden, text: document.getElementById('schedWarn').textContent, toast: document.getElementById('toast').textContent }));
    check('CSV import that drops teams shows a warning with the count and the teams', lossy.ok && !w.hidden && /2 teams were dropped/.test(w.text) && /team 222/.test(w.text) && /team 555/.test(w.text) && /dropped/.test(w.toast), w);
    await cmd('scheduleCSV', { text: fs.readFileSync(SAMPLE, 'utf8'), name: 'clean' }); await sleep(400);
    check('the warning clears after a clean schedule load', await control.evaluate(() => document.getElementById('schedWarn').hidden));

    // ---------- automatic field break ends on its own ----------
    const pad = n => String(n).padStart(2, '0'), iso = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const tb = Date.now();
    await cmd('set', { duration: 2000 });
    await cmd('breakConfig', { aheadMin: 0, minBreakSec: 0, auto: true, autoDelaySec: 1 });
    await cmd('scheduleCSV', { text: `Match,Time,Table 1\n1,${iso(tb)},101\n2,${iso(tb + 12000)},102\n`, name: 'auto-break' });
    await sleep(300); await cmd('start', { force: true });
    const inBreak = await waitFor(async () => { const s = await st(); return s.kind === 'break' && s.status === 'running'; }, 8000);
    const b5 = await st();
    check('auto field break starts after the match', inBreak, { kind: b5.kind, status: b5.status });
    await sleep(Math.max(0, b5.startAt + b5.duration - Date.now()) + 2500);
    const a5 = await st();
    check('auto field break ends on its own and the next match is ready', a5.kind !== 'break' && a5.status === 'idle' && a5.match.current === 1, { kind: a5.kind, status: a5.status, current: a5.match && a5.match.current });
  } catch (e) { console.log('ERROR', e.stack); failed++; }
  await browser.close().catch(() => {});
  await stopServer('SIGTERM');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
