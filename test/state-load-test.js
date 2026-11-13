// #84: a state.json that parses but has the wrong shape must not crash-loop on startup.
//   null timer and nothing worth keeping -> state.json.bak (bad file renamed aside)
//   null timer with a real schedule -> repair the timer, keep the schedule
//   both files unusable -> default state
//   truncated / unparseable state.json with a good .bak still recovers
//   a valid state.json is loaded unchanged
// node test/state-load-test.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');

let failed = 0, passed = 0;
function check(name, ok, detail) {
  ok ? passed++ : failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(err => err ? rej(err) : res(p)); });
  });
}
function startServer(data) {
  return freePort().then(port => new Promise((res, rej) => {
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(port), '--pin', '2468', '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
    srv.err = ''; srv.out = ''; srv.port = port;
    srv.stderr.on('data', d => { srv.err += d; });
    srv.stdout.on('data', d => { srv.out += d; });
    const t = setTimeout(() => rej(Object.assign(new Error('server start timeout'), { srv })), 8000);
    const done = () => { if (srv.out.includes('Control')) { clearTimeout(t); res(srv); } };
    srv.stdout.on('data', done);
    srv.once('exit', code => { clearTimeout(t); const e = new Error('server exited ' + code); e.srv = srv; rej(e); });
  }));
}
function stopServer(srv) {
  if (!srv || srv.exitCode != null) return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch (e) {} res(); }, 3000);
    srv.once('exit', () => { clearTimeout(t); res(); });
    try { srv.kill('SIGTERM'); } catch (e) { clearTimeout(t); res(); }
  });
}
function getJson(port, p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, x => {
      let b = ''; x.on('data', d => b += d);
      x.on('end', () => { try { res({ status: x.statusCode, body: JSON.parse(b) }); } catch (e) { res({ status: x.statusCode, body: b, parseError: e.message }); } });
    });
    r.on('error', rej); r.end();
  });
}
function asideFiles(dir, prefix) {
  return fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
}
function oneLine(err, re) {
  return err.split(/\r?\n/).map(s => s.trim()).filter(s => re.test(s));
}

const cue = (vol) => ({ vol: vol == null ? 1 : vol, file: null });
function validState(over) {
  const base = {
    timer: { status: 'idle', kind: 'match', duration: 54321, matchDuration: 54321, startAt: null, remainingAtPause: null, label: 'Match', seq: 3, lastAction: 'reset', breakUntil: null, breakFor: null, runId: 2, abortId: 0, abortAt: null, ready: false },
    sound: { master: 0.9, pack: 'nature', callMain: 0.35, cues: { start: cue(), warn: cue(), end: cue(), abort: cue(), call: cue() } },
    displays: {},
    layout: { pairs: [{ id: 'A', tables: ['1', '2'] }, { id: 'B', tables: ['3', '4'] }, { id: 'C', tables: ['5', '6'] }] },
    schedule: null,
    match: { current: 0, live: null, actualStarts: {}, autoAdvance: true },
    nexus: { url: '', auto: false, lastFetch: null, error: null },
    breaks: { aheadMin: 2, minBreakSec: 30, auto: false, autoDelaySec: 5 },
    display: { theme: 'nature', queueCount: 2 },
    refs: { ready: {}, calls: {}, callSeq: 0, used: false, confirm: true, keys: {} },
  };
  return Object.assign(base, over || {});
}
function scheduleOf(team, n) {
  const matches = [];
  for (let i = 0; i < n; i++) matches.push({ n: i + 1, time: 1793453400000 + i * 300000, teams: { '1': team }, practice: false });
  return { source: 'csv', event: { name: 'Load', date: '2026-11-14' }, teamNames: { [team]: 'Team ' + team }, tableNames: { '1': 'Table 1' }, matches };
}

async function boot(dir) {
  try { return { srv: await startServer(dir) }; }
  catch (e) { return { error: e.message, err: e.srv ? e.srv.err : '', out: e.srv ? e.srv.out : '' }; }
}

(async () => {
  // ---------- null timer, no schedule, good backup: load the backup ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-load-bak-'));
    const stateFile = path.join(dir, 'state.json');
    const bakFile = stateFile + '.bak';
    const bad = '{"timer":null,"match":null,"schedule":null}';
    const bak = validState({ timer: Object.assign({}, validState().timer, { duration: 11111, matchDuration: 11111 }), schedule: scheduleOf('9999', 2) });
    fs.writeFileSync(stateFile, bad);
    fs.writeFileSync(bakFile, JSON.stringify(bak));
    const bakBytes = fs.readFileSync(bakFile);
    const started = await boot(dir);
    if (!started.srv) check('#84 null timer with a good backup: server stays up', false, started);
    else {
      const srv = started.srv;
      try {
        const time = await getJson(srv.port, '/api/time');
        const snap = await getJson(srv.port, '/internal/queue-snapshot');
        const team = snap.body && snap.body.schedule && snap.body.schedule.matches && snap.body.schedule.matches[0] && snap.body.schedule.matches[0].teams['1'];
        check('#84 null timer with a good backup: server stays up', srv.exitCode == null && time.status === 200, { exit: srv.exitCode, status: time.status });
        check('#84 null timer with a good backup: loaded state.json.bak', time.body && time.body.duration === 11111 && time.body.status === 'idle' && snap.body.schedule.matches.length === 2 && team === '9999', { duration: time.body && time.body.duration, status: time.body && time.body.status, n: snap.body.schedule && snap.body.schedule.matches.length, team });
        const aside = asideFiles(dir, 'state.json.corrupt-');
        const live = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
        check('#84 null timer: bad state.json renamed aside and bytes kept', aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === bad && live !== bad, { aside, still: fs.existsSync(stateFile) });
        check('#84 null timer: backup file was not overwritten', fs.readFileSync(bakFile).equals(bakBytes));
        const warn = oneLine(srv.err, /state\.json is damaged \(timer is not an object\).*loaded /);
        check('#84 null timer: one-line warning names the bad file and the backup', warn.length === 1 && /state\.json\.bak/.test(warn[0]) && !/default state/.test(warn[0]), warn);
        await stopServer(srv);
        const again = await boot(dir);
        if (!again.srv) check('#84 second start after a null timer still comes up', false, again);
        else {
          try {
            const time2 = await getJson(again.srv.port, '/api/time');
            const snap2 = await getJson(again.srv.port, '/internal/queue-snapshot');
            const team2 = snap2.body.schedule && snap2.body.schedule.matches[0].teams['1'];
            check('#84 second start after a null timer still comes up on the backup', again.srv.exitCode == null && time2.body.duration === 11111 && team2 === '9999', { duration: time2.body && time2.body.duration, team: team2 });
          } finally { await stopServer(again.srv); }
        }
      } finally { await stopServer(srv); }
    }
  }

  // ---------- null timer but the schedule is real: keep it, default the timer ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-load-repair-'));
    const stateFile = path.join(dir, 'state.json');
    const bakFile = stateFile + '.bak';
    const broken = validState({ timer: null, schedule: scheduleOf('LIVE', 3) });
    const bad = JSON.stringify(broken);
    const bak = validState({ timer: Object.assign({}, validState().timer, { duration: 11111, matchDuration: 11111 }), schedule: scheduleOf('BAK', 1) });
    fs.writeFileSync(stateFile, bad);
    fs.writeFileSync(bakFile, JSON.stringify(bak));
    const bakBytes = fs.readFileSync(bakFile);
    const started = await boot(dir);
    if (!started.srv) check('#84 null timer with a schedule: server stays up and keeps the schedule', false, started);
    else {
      const srv = started.srv;
      try {
        const time = await getJson(srv.port, '/api/time');
        const snap = await getJson(srv.port, '/internal/queue-snapshot');
        const matches = snap.body && snap.body.schedule && snap.body.schedule.matches;
        const team = matches && matches[0] && matches[0].teams['1'];
        check('#84 null timer with a schedule: repaired timer, schedule kept (not the backup)', srv.exitCode == null && time.body && time.body.status === 'idle' && time.body.duration === 150000 && matches && matches.length === 3 && team === 'LIVE', { status: time.body && time.body.status, duration: time.body && time.body.duration, n: matches && matches.length, team });
        const aside = asideFiles(dir, 'state.json.corrupt-');
        check('#84 repaired file: original bytes renamed aside', aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === bad);
        check('#84 repaired file: backup left untouched', fs.readFileSync(bakFile).equals(bakBytes));
        const warn = oneLine(srv.err, /state\.json is damaged/);
        check('#84 repaired file: one-line warning says the schedule was kept', warn.length === 1 && /loaded repaired /.test(warn[0]) && /timer/.test(warn[0]) && !/loaded .*state\.json\.bak/.test(warn[0]), warn);
      } finally { await stopServer(srv); }
    }
  }

  // ---------- both files structurally invalid: default state ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-load-default-'));
    const stateFile = path.join(dir, 'state.json');
    const bakFile = stateFile + '.bak';
    const bad = '{"timer":null,"match":null,"schedule":null}';
    const badBak = '{"timer":null,"schedule":{"matches":{}}}';
    fs.writeFileSync(stateFile, bad);
    fs.writeFileSync(bakFile, badBak);
    const started = await boot(dir);
    if (!started.srv) check('#84 both files invalid: server starts on the default state', false, started);
    else {
      const srv = started.srv;
      try {
        const time = await getJson(srv.port, '/api/time');
        const snap = await getJson(srv.port, '/internal/queue-snapshot');
        check('#84 both files invalid: server starts on the default state', srv.exitCode == null && time.status === 200 && time.body.status === 'idle' && time.body.duration === 150000 && time.body.kind === 'match' && snap.body.schedule == null, { status: time.body && time.body.status, duration: time.body && time.body.duration, kind: time.body && time.body.kind, schedule: snap.body && snap.body.schedule });
        const aside = asideFiles(dir, 'state.json.corrupt-');
        const asideBak = asideFiles(dir, 'state.json.bak.corrupt-');
        check('#84 both files invalid: each bad file renamed aside', aside.length === 1 && asideBak.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === bad && fs.readFileSync(path.join(dir, asideBak[0]), 'utf8') === badBak, { aside, asideBak });
        const warn = oneLine(srv.err, /loaded default state/);
        check('#84 both files invalid: one-line warning names both files and the default state', warn.length === 1 && /state\.json is damaged/.test(warn[0]) && /state\.json\.bak is damaged/.test(warn[0]), warn);
      } finally { await stopServer(srv); }
    }
  }

  // ---------- truncated and unparseable: still recover from the backup ----------
  for (const sample of [
    { name: 'truncated', text: '{"timer":{"dur' },
    { name: 'unparseable', text: '\u0000\u0001 not json' },
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-load-' + sample.name + '-'));
    const stateFile = path.join(dir, 'state.json');
    const bakFile = stateFile + '.bak';
    const bak = validState({ timer: Object.assign({}, validState().timer, { duration: 7777, matchDuration: 7777 }), schedule: scheduleOf('7771', 4) });
    fs.writeFileSync(stateFile, sample.text);
    fs.writeFileSync(bakFile, JSON.stringify(bak));
    const started = await boot(dir);
    if (!started.srv) check('#84 ' + sample.name + ' state.json still recovers from the backup', false, started);
    else {
      const srv = started.srv;
      try {
        const time = await getJson(srv.port, '/api/time');
        const snap = await getJson(srv.port, '/internal/queue-snapshot');
        const team = snap.body && snap.body.schedule && snap.body.schedule.matches && snap.body.schedule.matches[0] && snap.body.schedule.matches[0].teams['1'];
        const aside = asideFiles(dir, 'state.json.corrupt-');
        check('#84 ' + sample.name + ' state.json still recovers from the backup', srv.exitCode == null && time.body && time.body.duration === 7777 && snap.body.schedule && snap.body.schedule.matches.length === 4 && team === '7771' && aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === sample.text && /!!!/.test(srv.err) && /backup/i.test(srv.err), { duration: time.body && time.body.duration, n: snap.body.schedule && snap.body.schedule.matches && snap.body.schedule.matches.length, team, aside: aside.length });
      } finally { await stopServer(srv); }
    }
  }

  // ---------- a good file is not rewritten or set aside ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-load-valid-'));
    const stateFile = path.join(dir, 'state.json');
    const good = JSON.stringify(validState({ schedule: scheduleOf('4242', 1) }), null, 1);
    fs.writeFileSync(stateFile, good);
    const started = await boot(dir);
    if (!started.srv) check('#84 valid state.json loads unchanged', false, started);
    else {
      const srv = started.srv;
      try {
        const time = await getJson(srv.port, '/api/time');
        const snap = await getJson(srv.port, '/internal/queue-snapshot');
        const team = snap.body && snap.body.schedule && snap.body.schedule.matches && snap.body.schedule.matches[0] && snap.body.schedule.matches[0].teams['1'];
        const disk = fs.readFileSync(stateFile, 'utf8');
        check('#84 valid state.json loads unchanged', disk === good && time.body && time.body.duration === 54321 && time.body.status === 'idle' && time.body.seq === 3 && team === '4242' && asideFiles(dir, 'state.json.corrupt-').length === 0 && !fs.existsSync(stateFile + '.bak') && !/is damaged/.test(srv.err), { duration: time.body && time.body.duration, seq: time.body && time.body.seq, team, diskSame: disk === good, err: srv.err.slice(0, 200) });
      } finally { await stopServer(srv); }
    }
  }

  // ---------- breaks: null and a match that ended while down: startup must not throw ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-load-breaks-'));
    const stateFile = path.join(dir, 'state.json');
    const timer = Object.assign({}, validState().timer, { status: 'running', kind: 'match', duration: 5000, matchDuration: 5000, startAt: Date.now() - 20000, seq: 1, lastAction: 'start', runId: 1 });
    const broken = validState({
      timer,
      breaks: null,
      match: { current: 0, live: 0, actualStarts: {}, autoAdvance: false },
      schedule: scheduleOf('5050', 1),
    });
    fs.writeFileSync(stateFile, JSON.stringify(broken));
    const started = await boot(dir);
    if (!started.srv) check('#84 null breaks with an expired running match: server stays up and keeps the schedule', false, started);
    else {
      const srv = started.srv;
      try {
        const time = await getJson(srv.port, '/api/time');
        const snap = await getJson(srv.port, '/internal/queue-snapshot');
        const team = snap.body && snap.body.schedule && snap.body.schedule.matches && snap.body.schedule.matches[0] && snap.body.schedule.matches[0].teams['1'];
        check('#84 null breaks with an expired running match: server stays up and keeps the schedule', srv.exitCode == null && time.body && time.body.status === 'done' && team === '5050', { status: time.body && time.body.status, team, err: srv.err.slice(0, 240) });
      } finally { await stopServer(srv); }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack || e); process.exit(1); });
