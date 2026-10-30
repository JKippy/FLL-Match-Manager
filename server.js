#!/usr/bin/env node
// FLL Synced Match Timer - zero-dependency LAN server.
// HTTP static files + a tiny built-in WebSocket server for sync, control, schedule and sound settings.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Sched = require('./lib/schedule');

// ---------- config ----------
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return process.env[name.toUpperCase().replace(/-/g, '_')] || def;
}
const PORT = parseInt(arg('port', '8080'), 10);
const PIN = String(arg('pin', '') || '');
const START_LEAD_MS = parseInt(arg('lead', '600'), 10);
const DATA_DIR = path.resolve(arg('data', path.join(__dirname, 'data')));
const PUBLIC = path.join(__dirname, 'public');
const SOUND_DIR = path.join(DATA_DIR, 'sounds');
const CUES = ['start', 'warn', 'end', 'abort', 'call'];
const MAX_SOUND = 8 * 1024 * 1024;
fs.mkdirSync(SOUND_DIR, { recursive: true });

const now = () => Date.now();

// ---------- persistent store ----------
const STORE_FILE = path.join(DATA_DIR, 'state.json');
const store = {
  timer: { status: 'idle', kind: 'match', duration: 150000, matchDuration: 150000, startAt: null, remainingAtPause: null, label: 'Match', seq: 0, lastAction: null, breakUntil: null, breakFor: null,
    // One-shot cue events: runId changes on every fresh start (start/30 s/end cues are keyed by it), abortId on every abort.
    runId: 0, abortId: 0, abortAt: null, ready: false },
  // callMain: level of the soft "a ref called the Head Ref" chime on the projector (audio only; quieter than match cues).
  sound: { master: 0.9, pack: 'nature', callMain: 0.35, cues: { start: { vol: 1, file: null }, warn: { vol: 1, file: null }, end: { vol: 1, file: null }, abort: { vol: 1, file: null }, call: { vol: 1, file: null } } },
  displays: {},        // deviceId -> { vol, muted, name }
  layout: JSON.parse(JSON.stringify(Sched.DEFAULT_LAYOUT)),
  schedule: null,
  match: { current: 0, live: null, actualStarts: {}, autoAdvance: true },
  nexus: { url: '', auto: false, lastFetch: null, error: null },
  // Target: start matches at most aheadMin ahead of schedule. A field break ends at (next scheduled start - aheadMin);
  // a break shorter than minBreakSec isn't worth showing (go straight to ready). START more than aheadMin early asks to confirm.
  breaks: { aheadMin: 2, minBreakSec: 30, auto: false, autoDelaySec: 5 },
  display: { theme: 'nature', queueCount: 2 },
  // Table referees (the /ref page): ready[matchIndex][table] = time they tapped READY; calls[table] = a "Call Head Ref" request.
  // used: a ref page has been opened at least once (only then does START check readiness); confirm: the Head Ref's on/off switch.
  refs: { ready: {}, calls: {}, callSeq: 0, used: false, confirm: true },
};
// Display prefs are keyed by a client-chosen id: a null-prototype object so "__proto__" & co. can never touch Object.prototype.
const validDeviceId = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(id) && !/^(__proto__|constructor|prototype)$/.test(id);
const nullProto = o => { const out = Object.create(null); if (o && typeof o === 'object') for (const k of Object.keys(o)) if (validDeviceId(k)) out[k] = o[k]; return out; };
store.displays = nullProto(null);
const BAK_FILE = STORE_FILE + '.bak';
function loudly(...lines) { console.error('\n  ' + '!'.repeat(72)); for (const l of lines) console.error('  !! ' + l); console.error('  ' + '!'.repeat(72) + '\n'); }
// Read state.json; if it is damaged (e.g. power cut mid-write on an old version), fall back to state.json.bak and say so loudly.
function readSaved() {
  for (const f of [STORE_FILE, BAK_FILE]) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; loudly(`Could not read ${f}: ${e.message}`); continue; }
    try {
      const saved = JSON.parse(text);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not a JSON object');
      if (f === BAK_FILE) loudly(`${STORE_FILE} is missing or damaged. Restored the schedule and settings from the backup`, `${BAK_FILE}`, 'Check the match number and the timer on the control page.');
      return saved;
    } catch (e) {
      const keep = f + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.copyFileSync(f, keep); } catch (e2) {}
      loudly(`${f} is damaged and cannot be loaded (${e.message}).`, `A copy was kept as ${keep}`);
    }
  }
  if (fs.existsSync(STORE_FILE)) loudly('No usable saved state: starting with an EMPTY schedule and default settings.');
  return null;
}
let crossedEnd = false;   // the server was down when a running match reached 0:00
try {
  const saved = readSaved(); if (!saved) throw null;
  for (const k of Object.keys(store)) if (saved[k] !== undefined) store[k] = (saved[k] === null || store[k] === null) ? saved[k] : Object.assign({}, store[k], saved[k]);
  store.displays = nullProto(store.displays);
  for (const c of CUES) store.sound.cues[c] = Object.assign({ vol: 1, file: null }, store.sound.cues[c]);
  // A match that was running when the server stopped keeps running (startAt is wall-clock based).
  // One that reached 0:00 while we were down is finished below exactly like a normal end (finishRun), and an
  // expired field break ends like a normal break end (match-ready).
  if (store.timer.status === 'running' && store.timer.startAt + store.timer.duration < now()) crossedEnd = true;
  if (!store.timer.kind) store.timer.kind = 'match';
  delete store.breaks.offsetMin; delete store.breaks.minSec;   // v3 settings, replaced by aheadMin / minBreakSec
  for (const k of ['runId', 'abortId']) if (!store.timer[k]) store.timer[k] = 0;
  if (!store.timer.matchDuration) store.timer.matchDuration = store.timer.duration;
  store.refs = Object.assign({ ready: {}, calls: {}, callSeq: 0, used: false, confirm: true }, store.refs);
} catch (e) { if (e) loudly('Saved state could not be applied: ' + (e.message || e)); }
// Saved synchronously and atomically BEFORE a command is acked: write a temp file, fsync, rename over state.json.
// The previous good file is copied to state.json.bak (at most every 10 s) so a damaged file can be recovered.
let lastBak = 0, saveFailed = false;
function save() {
  const tmp = STORE_FILE + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(store, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (now() - lastBak > 10000 && fs.existsSync(STORE_FILE)) { try { fs.copyFileSync(STORE_FILE, BAK_FILE); lastBak = now(); } catch (e) {} }
    fs.renameSync(tmp, STORE_FILE);
    if (saveFailed) { saveFailed = false; console.error('  Saving state works again.'); }
  } catch (e) { if (!saveFailed) loudly('Could not save the timer state: ' + e.message); saveFailed = true; }
}

const timer = store.timer;
let endTimer = null, autoSessionT = null;

// ---------- field breaks ----------
function endBreak(action) {
  // A break that ends (by itself or END BREAK) puts every screen into match-ready position.
  Object.assign(timer, { status: 'idle', kind: 'match', duration: timer.matchDuration || 150000, startAt: null, remainingAtPause: null, label: 'Match', breakUntil: null, breakFor: null, lastAction: action, ready: action === 'breakEnd' });
  timer.seq++;
}
function startBreak(ms, until, forIdx) {
  if (timer.kind !== 'break') timer.matchDuration = timer.duration;
  const t = now();
  Object.assign(timer, { status: 'running', kind: 'break', startAt: t, duration: Math.max(1000, Math.round(ms)), remainingAtPause: null, label: 'Field break', breakUntil: until || null, breakFor: forIdx == null ? null : forIdx, lastAction: 'break', ready: false });
  store.match.live = null;
  timer.seq++;
}
// Index of the next match nobody has started yet (moves past a just-finished match).
function advancePastDone() {
  const m = store.match, sch = store.schedule;
  if (sch && timer.status === 'done' && m.live != null && m.current === m.live && m.current < sch.matches.length - 1) m.current++;
}
// ---------- table referees ----------
const refs = () => store.refs;
// The match START would begin next (skips a just-finished match that auto-advance didn't move past).
function upcomingIdx() {
  const m = store.match, sch = store.schedule;
  if (!sch || !sch.matches.length) return null;
  return timer.kind !== 'break' && timer.status === 'done' && m.live != null && m.current === m.live && m.current < sch.matches.length - 1 ? m.current + 1 : m.current;
}
const liveIdx = () => timer.kind === 'match' && (timer.status === 'running' || timer.status === 'paused') ? store.match.live : null;
function clearReady(idx) { if (idx != null) delete refs().ready[idx]; }
// Ready marks for matches that are already over (or were navigated away from) are dropped.
function pruneReady() {
  const floor = liveIdx() != null ? liveIdx() : upcomingIdx(), r = refs().ready;
  for (const k of Object.keys(r)) if (floor == null || +k < floor || !Object.keys(r[k]).length) delete r[k];
}
const allTables = () => [...new Set([].concat(...store.layout.pairs.map(p => p.tables.map(String)), ...(store.schedule ? store.schedule.matches.map(x => Object.keys(x.teams)) : [])))];
function refCommand(msg, c) {
  const R = refs(), t = now(), table = String(msg.table || '').trim().slice(0, 12);
  if (!table || !allTables().includes(table)) refuse('Unknown table ' + (table || '(none)'));
  switch (msg.cmd) {
    case 'refReady': {
      const sch = store.schedule; if (!sch) refuse('No schedule loaded yet');
      const idx = +msg.index, mt = sch.matches[idx];
      if (!mt || !mt.teams[table]) refuse(`Table ${table} isn't in that match`);
      const floor = upcomingIdx();
      if (liveIdx() === idx) refuse('That match is already running');
      if (idx < floor) refuse('That match is over');
      const r = R.ready[idx] = R.ready[idx] || {};
      if (msg.on) r[table] = t; else delete r[table];
      pruneReady(); break;
    }
    case 'refCall':
      if (!R.calls[table] || R.calls[table].ackAt) {
        R.calls[table] = { id: ++R.callSeq, at: t, ackAt: null, by: c.name || '' };
        // The projector plays a soft chime so the Head Ref looks at the tablet. Sent live only (never part of the state, so no
        // replay on reconnect / late join), to main displays only, and WITHOUT the table: the audience can't tell who called.
        const chime = { t: 'chime', id: R.callSeq, at: t };
        for (const x of clients.values()) if (x.role === 'display' && x.view === 'main') x.send(chime);
      }
      break;
    case 'refCancel': delete R.calls[table]; break;
    default: refuse('Unknown command: ' + msg.cmd);
  }
  save(); broadcastState(); broadcastCalls();
}
function callsMsg() {
  const R = refs(), t = now();
  for (const [k, v] of Object.entries(R.calls)) if (v.ackAt && t - v.ackAt > 60000) delete R.calls[k];
  return { t: 'calls', calls: R.calls, serverNow: t };
}
function broadcastCalls() { const m = callsMsg(); for (const c of clients.values()) if (c.role === 'control' || c.role === 'ref') c.send(m); }

// "End match session": leave 0:00, then break until (next scheduled start - offset), or straight to ready if we're behind.
function endSession() {
  if (timer.kind === 'match' && (timer.status === 'running' || timer.status === 'paused')) throw new Error('A match is still running');
  advancePastDone();
  const m = store.match, sch = store.schedule;
  const next = sch && sch.matches[m.current];
  const lastDone = sch && m.live === m.current && timer.status === 'done';
  const target = next && next.time != null && !lastDone ? next.time - (+store.breaks.aheadMin || 0) * 60000 : null;
  m.live = null;
  if (target != null && target - now() >= (+store.breaks.minBreakSec || 0) * 1000) { startBreak(target - now(), target, m.current); return 'break'; }
  endBreak('session'); return target == null ? 'ready' : 'behind';
}
// A run reaching 0:00: the same bookkeeping whether it happens live or while the server was down (restart).
function finishRun(endedAt) {
  if (timer.kind === 'break') { endBreak('breakEnd'); return; }
  timer.status = 'done'; timer.seq++; timer.lastAction = 'end';
  const m = store.match;
  clearReady(m.live);
  if (m.live != null && store.match.autoAdvance && m.current === m.live && store.schedule && m.current < store.schedule.matches.length - 1) m.current++;
  m.endedAt = endedAt || now();
  pruneReady();
  if (store.breaks.auto) {
    const seq = timer.seq;
    clearTimeout(autoSessionT);
    const wait = Math.max(0, (+store.breaks.autoDelaySec || 0) * 1000 - (now() - m.endedAt));
    autoSessionT = setTimeout(() => { if (timer.status === 'done' && timer.seq === seq) { try { endSession(); save(); broadcastState(); } catch (e) { console.error('auto end-session:', e.message); } } }, wait);
  }
}
function scheduleDone() {
  clearTimeout(endTimer);
  if (timer.status !== 'running') return;
  endTimer = setTimeout(() => {
    if (timer.status !== 'running') return;
    finishRun(); save(); broadcastState();
  }, Math.max(0, timer.startAt + timer.duration - now()) + 50);
}
if (crossedEnd) {
  const wasBreak = timer.kind === 'break';
  finishRun(timer.startAt + timer.duration);
  console.log(wasBreak ? '  The field break ended while the server was stopped: ready for the next match.'
    : `  A match reached 0:00 while the server was stopped: marked done${store.match.autoAdvance ? ' and advanced to the next match' : ''}.`);
  save();
}
scheduleDone();

function stateMsg() {
  const m = store.match;
  const R = store.refs;
  return { t: 'state', ...timer, serverNow: now(), match: { current: m.current, live: m.live, actualStarts: m.actualStarts, endedAt: m.endedAt || null, autoAdvance: m.autoAdvance },
    refs: { ready: R.ready, used: !!R.used, confirm: R.confirm !== false } };
}
function configMsg(c) {
  const pref = (c && c.deviceId && validDeviceId(c.deviceId) && store.displays[c.deviceId]) || { vol: 1, muted: false };
  return { t: 'config', sound: store.sound, layout: store.layout, pref, nexus: store.nexus, breaks: store.breaks, display: store.display, pinRequired: !!PIN };
}
function scheduleMsg() { return { t: 'schedule', schedule: store.schedule }; }

// ---------- clients ----------
const clients = new Map();
let nextId = 1;
function handleMessage(c, msg) {
  switch (msg.t) {
    case 'ping': c.send({ t: 'pong', c0: msg.c0, s: now() }); return;
    case 'hello':
      c.role = msg.role === 'control' ? 'control' : msg.role === 'ref' ? 'ref' : 'display';
      c.view = String(msg.view || '').slice(0, 20);
      c.deviceId = validDeviceId(msg.deviceId) ? msg.deviceId : null;   // anything odd ("__proto__", "constructor", …) = no saved prefs
      c.name = String(msg.name || '').slice(0, 40) || (c.role === 'control' ? 'Control' : 'Display ' + c.id);
      if (c.role === 'control' && msg.pin) checkPin(c, msg.pin); else c.authed = !PIN;
      if (c.deviceId && c.role === 'display') { const d = store.displays[c.deviceId] = store.displays[c.deviceId] || { vol: 1, muted: false }; d.name = c.name; d.view = c.view; }
      c.send({ t: 'welcome', id: c.id, pinRequired: !!PIN, authed: c.authed, lead: START_LEAD_MS, error: c.authError });
      if (c.role === 'ref' && !store.refs.used) { store.refs.used = true; save(); broadcastState(); }
      c.send(configMsg(c)); c.send(scheduleMsg()); c.send(stateMsg());
      if (c.role !== 'display') c.send(callsMsg());
      broadcastClients(); return;
    case 'auth': checkPin(c, msg.pin); c.send({ t: 'auth', authed: c.authed, error: c.authError, retryIn: c.retryIn }); if (c.authed) broadcastClients(); return;
    case 'report':
      c.rtt = msg.rtt; c.offset = msg.offset; c.lastSeen = now();
      if (typeof msg.name === 'string' && msg.name) c.name = msg.name.slice(0, 40);
      c.audio = !!msg.audio; c.wake = msg.wake || ''; return;
    case 'cmd':
      // Every command gets an ack (ok or the reason it was refused), so the control page never fails silently.
      const reply = (ok, e) => msg.id != null ? c.send({ t: 'ack', id: msg.id, cmd: msg.cmd, ok, error: e ? String(e.message || e) : undefined, code: e && e.code, info: e && e.info })
        : (!ok && c.send({ t: 'error', error: String(e.message || e) }));
      // Table referees need no PIN: they can only mark their own table ready or call the Head Ref.
      if (REF_CMDS.includes(msg.cmd)) { Promise.resolve().then(() => refCommand(msg, c)).then(() => reply(true), e => reply(false, e)); return; }
      if (c.role !== 'control' || !c.authed) { reply(false, new Error('Not authorized: enter the Head Ref PIN')); return; }
      Promise.resolve().then(() => runCommand(msg, c)).then(() => reply(true), e => reply(false, e));
      return;
  }
}

const REF_CMDS = ['refReady', 'refCall', 'refCancel'];
// ---------- PIN brute-force protection ----------
// 5 free tries, then a lockout that doubles (1 s, 2 s, 4 s … max 5 min), per socket AND per IP (a new socket doesn't reset it).
// While locked out every attempt is refused without even comparing the PIN. A correct PIN clears the counter.
const pinFails = new Map();   // ip -> { fails, until }
const FREE_TRIES = 5, MAX_LOCK = 5 * 60000;
function pinGate(key) { const g = pinFails.get(key); return g && g.until > now() ? g.until - now() : 0; }
function pinFail(key) {
  const g = pinFails.get(key) || { fails: 0, until: 0 }; g.fails++;
  if (g.fails >= FREE_TRIES) g.until = now() + Math.min(MAX_LOCK, 1000 * 2 ** (g.fails - FREE_TRIES));
  pinFails.set(key, g);
}
function pinCheck(ip, sockKey, pin) {
  if (!PIN) return { ok: true };
  const wait = Math.max(pinGate('ip:' + ip), pinGate(sockKey));
  if (wait) return { ok: false, wait, error: `Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} s` };
  const a = Buffer.from(String(pin == null ? '' : pin)), b = Buffer.from(PIN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { pinFails.delete('ip:' + ip); pinFails.delete(sockKey); return { ok: true }; }
  pinFail('ip:' + ip); pinFail(sockKey);
  if (pinFails.get('ip:' + ip).fails === FREE_TRIES) console.warn(`  Several wrong PINs from ${ip}: slowing down further attempts.`);
  return { ok: false, error: 'Wrong PIN' };
}
function checkPin(c, pin) {
  const r = pinCheck(c.ip, 'sock:' + c.id, pin);
  c.authed = r.ok; c.authError = r.ok ? undefined : r.error; c.retryIn = r.wait;
}
setInterval(() => { const t = now(); for (const [k, g] of pinFails) if (g.until < t - 15 * 60000) pinFails.delete(k); }, 60000).unref();
const clamp01 = v => Math.max(0, Math.min(1, Number(v)));
const refuse = (text, code, info) => { const e = new Error(text); if (code) e.code = code; if (info) e.info = info; throw e; };
let lastStep = null;
const clockTxt = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
async function runCommand(msg, c) {
  const t = now();
  const m = store.match, sch = store.schedule;
  switch (msg.cmd) {
    // ----- timer -----
    case 'start': {
      if (timer.kind === 'match' && timer.status === 'running') refuse('The match is already running');
      // Don't start more than aheadMin ahead of schedule without the Head Ref confirming.
      // ...and, once referee pages are in use, not before every table in the match is READY. Both are one confirm (force).
      if (timer.status !== 'paused' && !msg.force && sch) {
        const idx = upcomingIdx();
        const nm = sch.matches[idx], lim = (+store.breaks.aheadMin || 0) * 60000;
        const info = { n: nm && nm.n, time: nm && nm.time, practice: !!(nm && nm.practice), aheadMin: store.breaks.aheadMin, ahead: false, notReady: [] };
        if (nm && nm.time != null && store.breaks.aheadMin != null && nm.time - t > lim) {
          const ahead = nm.time - t, mins = Math.round(ahead / 60000);
          const txt = mins > store.breaks.aheadMin ? mins + ' min' : Math.floor(ahead / 60000) + ':' + String(Math.floor(ahead / 1000) % 60).padStart(2, '0');
          Object.assign(info, { ahead: true, aheadMs: ahead, text: txt });
        }
        if (nm && store.refs.used && store.refs.confirm !== false) {
          const r = store.refs.ready[idx] || {};
          info.notReady = Object.keys(nm.teams).sort((a, b) => a - b).filter(x => !r[x]);
        }
        if (info.ahead || info.notReady.length) {
          const parts = [];
          if (info.notReady.length) parts.push(`Table${info.notReady.length > 1 ? 's' : ''} ${info.notReady.join(', ')} ${info.notReady.length > 1 ? "aren't" : "isn't"} ready`);
          if (info.ahead) parts.push(`${info.text} ahead of schedule`);
          refuse(parts.join('; '), info.ahead ? 'ahead' : 'notready', info);
        }
      }
      if (timer.kind === 'break') { advancePastDone(); endBreak('breakEnd'); }
      if (timer.status === 'paused') timer.startAt = t + START_LEAD_MS - (timer.duration - timer.remainingAtPause);
      else {
        timer.startAt = t + START_LEAD_MS;
        if (sch && sch.matches[m.current]) { m.live = m.current; m.actualStarts[sch.matches[m.current].n] = timer.startAt; }
        else m.live = null;
        timer.runId = (timer.runId || 0) + 1;
      }
      timer.status = 'running'; timer.remainingAtPause = null; timer.lastAction = 'start'; timer.ready = false;
      break;
    }
    case 'pause':
      if (timer.kind === 'break') refuse("A field break can't be paused (START begins the match, END BREAK cancels the break)");
      if (timer.status !== 'running') refuse('Nothing to pause: the timer is not running');
      timer.remainingAtPause = Math.min(timer.duration, Math.max(0, timer.duration - (t - timer.startAt)));
      timer.status = 'paused'; timer.startAt = null; timer.lastAction = 'pause';
      break;
    case 'reset': {
      if (timer.kind === 'break') { endBreak('breakEnd'); break; }
      const aborted = timer.status === 'running' || timer.status === 'paused';
      clearReady(aborted ? m.live : upcomingIdx());   // abort / reset: the refs re-confirm for the replay
      if (aborted && m.live != null && sch && sch.matches[m.live]) delete m.actualStarts[sch.matches[m.live].n];
      timer.status = 'idle'; timer.startAt = null; timer.remainingAtPause = null; timer.lastAction = aborted ? 'abort' : 'reset'; timer.ready = false;
      if (aborted) { timer.abortId = (timer.abortId || 0) + 1; timer.abortAt = t; }   // one-shot: screens play the foghorn for a new abortId only
      m.live = null;
      break;
    }
    case 'set': {
      const d = Math.round(Number(msg.duration));
      if (!(d >= 1000 && d <= 99 * 60000)) refuse('Time must be between 0:01 and 99:00');
      if (timer.status === 'running' || timer.status === 'paused') m.live = null;
      timer.kind = 'match'; timer.breakUntil = null; timer.breakFor = null; timer.matchDuration = d;
      timer.duration = d; timer.status = 'idle'; timer.startAt = null; timer.remainingAtPause = null; timer.lastAction = 'set'; timer.ready = false;
      if (msg.label) timer.label = String(msg.label).slice(0, 30);
      break;
    }
    // ----- matches -----
    case 'goto': {
      if (!sch) refuse('No schedule loaded');
      if (timer.kind === 'match' && (timer.status === 'running' || timer.status === 'paused')) refuse('Stop the running timer before changing match');
      const N = sch.matches.length;
      let i;
      if (msg.index != null) {
        i = Number(msg.index);
        if (!Number.isInteger(i) || i < 0 || i >= N) refuse(`No such match (pick 1–${N})`);
      } else {
        const d = Number(msg.delta);
        if (!Number.isInteger(d) || Math.abs(d) > N) refuse('Bad match step');
        // NEXT / PREV are relative, so a double-click or two refs pressing together used to skip a match.
        // The control page sends the match it was looking at (from): a press based on an old view is refused.
        if (msg.from != null && Number(msg.from) !== m.current) {
          const cur = sch.matches[m.current];
          refuse(`Already moved to ${cur ? (cur.practice ? 'Practice ' : 'Match ') + cur.n : 'another match'} (two presses arrived together). Press again to move on.`, 'stale', { current: m.current });
        }
        // Clients that don't send `from` (scripts, old pages): steps arriving together (within 40 ms) count as one press.
        if (msg.from == null && lastStep && t - lastStep.at < 40 && Math.sign(d) === Math.sign(lastStep.d)) refuse('Ignored a duplicate NEXT/PREV press (two arrived at the same moment)', 'stale', { current: m.current });
        lastStep = { at: t, d };
        i = m.current + d;
      }
      timer.ready = false;
      const was = upcomingIdx();
      m.current = Math.max(0, Math.min(N - 1, i));
      if (m.current !== was) clearReady(was);   // navigating away resets the ready marks of the match we were on
      if (timer.status === 'done') { timer.status = 'idle'; timer.lastAction = 'reset'; m.live = null; }
      break;
    }
    case 'autoAdvance': m.autoAdvance = !!msg.on; break;
    // ----- table referees (Head Ref side) -----
    case 'callAck': {
      const R = store.refs, keys = msg.table != null ? [String(msg.table)] : Object.keys(R.calls);
      for (const k of keys) if (R.calls[k] && !R.calls[k].ackAt) R.calls[k].ackAt = t;
      save(); broadcastCalls(); return;
    }
    case 'refConfig': if (msg.confirm != null) store.refs.confirm = !!msg.confirm; if (msg.used != null) store.refs.used = !!msg.used; break;
    case 'refClear': store.refs.ready = {}; break;
    // ----- field break -----
    case 'endSession': {
      clearTimeout(autoSessionT);
      const r = endSession();
      c.send({ t: 'notice', text: r === 'break' ? 'Field break until ' + new Date(timer.breakUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : r === 'behind' ? 'Behind schedule: no break, ready for the next match' : 'Ready for the next match' });
      break;
    }
    case 'breakStart': {
      if (timer.kind === 'match' && (timer.status === 'running' || timer.status === 'paused')) throw new Error('Stop the match before starting a break');
      clearTimeout(autoSessionT);
      if (msg.until === 'next') {
        advancePastDone();
        const next = sch && sch.matches[m.current];
        if (!next || next.time == null) throw new Error('No scheduled next match');
        const target = next.time - (+store.breaks.aheadMin || 0) * 60000;
        if (target - t < 5000) refuse(`No break needed: you're on time or behind (the next match should start at ${clockTxt(target)})`);
        startBreak(target - t, target, m.current);
      } else {
        const d = Math.round(Number(msg.duration));
        if (!(d >= 5000 && d <= 4 * 3600000)) throw new Error('Break length must be 0:05 to 4:00:00');
        advancePastDone();
        startBreak(d, t + d, sch ? m.current : null);
      }
      break;
    }
    case 'breakEnd': if (timer.kind !== 'break') refuse('No field break is running'); endBreak('breakEnd'); break;
    case 'breakConfig': {
      const b = store.breaks;
      if (msg.aheadMin != null) b.aheadMin = Math.max(0, Math.min(30, Number(msg.aheadMin) || 0));
      if (msg.minBreakSec != null) b.minBreakSec = Math.max(0, Math.min(1800, Number(msg.minBreakSec) || 0));
      if (msg.auto != null) b.auto = !!msg.auto;
      if (msg.autoDelaySec != null) b.autoDelaySec = Math.max(0, Math.min(120, Number(msg.autoDelaySec) || 0));
      save(); broadcastConfig(); return;
    }
    case 'displayConfig': {
      if (msg.theme) store.display.theme = msg.theme === 'plain' ? 'plain' : 'nature';
      if (msg.queueCount != null) store.display.queueCount = Math.max(0, Math.min(8, Math.round(+msg.queueCount) || 0));
      save(); broadcastConfig(); return;
    }
    case 'soundPack': store.sound.pack = msg.pack === 'classic' ? 'classic' : 'nature'; save(); broadcastConfig(); return;
    case 'clearActuals': m.actualStarts = {}; break;
    // ----- schedule -----
    case 'scheduleCSV': {
      const s = Sched.parseCSV(String(msg.text || ''), { date: msg.date || null, name: msg.name || 'Uploaded schedule', source: msg.source || 'csv' });
      setSchedule(s, true); c.send({ t: 'notice', text: `Loaded ${s.matches.length} matches` });
      return;
    }
    case 'nexusFetch': {
      store.nexus.url = String(msg.url || store.nexus.url || '');
      await nexusRefresh(true);
      if (store.nexus.error) throw new Error('Nexus: ' + store.nexus.error);
      c.send({ t: 'notice', text: `Loaded ${store.schedule.matches.length} matches from Nexus` });
      return;
    }
    case 'nexusAuto': store.nexus.auto = !!msg.on; save(); broadcastConfig(); return;
    case 'scheduleShift': { // move the whole schedule so match #index starts at msg.time (epoch ms)
      if (!sch) refuse('No schedule loaded');
      const ref = sch.matches[+msg.index || 0]; if (!ref || ref.time == null) refuse('That match has no scheduled time');
      const delta = +msg.time - ref.time; if (!isFinite(delta)) refuse('Pick a valid time');
      sch.matches.forEach(x => { if (x.time != null) x.time += delta; });
      sch.shiftedBy = (sch.shiftedBy || 0) + delta;
      save(); broadcast(scheduleMsg()); return;
    }
    case 'scheduleClear': store.refs.ready = {}; timer.ready = false; store.schedule = null; m.current = 0; m.live = null; m.actualStarts = {}; save(); broadcast(scheduleMsg()); break;
    case 'layout': {
      const pairs = (msg.pairs || []).map(p => ({ id: String(p.id || '').trim().slice(0, 12), tables: (p.tables || []).map(x => String(x).trim()).filter(Boolean).slice(0, 8) }))
        .filter(p => p.id && p.tables.length).slice(0, 12);
      if (!pairs.length) throw new Error('Layout needs at least one pair');
      store.layout = { pairs }; save(); broadcastConfig(); return;
    }
    // ----- sound -----
    case 'volume': {
      if (msg.cue === 'master') store.sound.master = clamp01(msg.value);
      else if (msg.cue === 'callMain') store.sound.callMain = clamp01(msg.value);
      else if (store.sound.cues[msg.cue]) store.sound.cues[msg.cue].vol = Math.max(0, Math.min(2, Number(msg.value) || 0));
      save(); broadcastConfig(); return;
    }
    case 'displayPref': {
      const d = validDeviceId(msg.deviceId) && Object.prototype.hasOwnProperty.call(store.displays, msg.deviceId) ? store.displays[msg.deviceId] : null; if (!d) refuse('Unknown display');
      if (msg.vol != null) d.vol = clamp01(msg.vol);
      if (msg.muted != null) d.muted = !!msg.muted;
      save(); for (const x of clients.values()) if (x.deviceId === msg.deviceId) x.send(configMsg(x));
      broadcastClients(); return;
    }
    case 'testSound': {
      if (!CUES.includes(msg.cue) && msg.cue !== 'callSoft') refuse('Unknown sound');
      // callSoft (the projector's call chime) only ever plays on main displays
      for (const x of clients.values()) if (x.role === 'display' && (!msg.deviceId || x.deviceId === msg.deviceId) && (msg.cue !== 'callSoft' || x.view === 'main')) x.send({ t: 'play', cue: msg.cue });
      return;
    }
    case 'soundDelete': {
      const cue = store.sound.cues[msg.cue]; if (!cue || !cue.file) refuse('No uploaded file for that sound');
      fs.unlink(path.join(SOUND_DIR, cue.file.stored), () => {});
      cue.file = null; save(); broadcastConfig(); return;
    }
    default: refuse('Unknown command: ' + msg.cmd);
  }
  timer.seq++;
  pruneReady(); scheduleDone(); save(); broadcastState();
}

function setSchedule(s, resetProgress) {
  const prev = store.schedule;
  // Keep progress if it's the same event being refreshed and the match count is unchanged.
  const same = prev && !resetProgress && prev.matches.length === s.matches.length;
  if (same && prev.shiftedBy) { s.shiftedBy = prev.shiftedBy; s.matches.forEach(x => { if (x.time != null) x.time += prev.shiftedBy; }); }
  store.schedule = s;
  if (!same) { store.match.current = 0; store.match.live = null; store.match.actualStarts = {}; store.refs.ready = {}; }
  save(); broadcast(scheduleMsg()); broadcastState();
}

let nexusTimer = null;
async function nexusRefresh(manual) {
  if (!store.nexus.url) return;
  try {
    const s = await Sched.fetchNexus(store.nexus.url);
    s.fetchedAt = now();
    if (!s.matches.length) throw new Error(`"${s.event.name || s.event.key}" has no robot-game matches published yet (auto-refresh will pick them up once they are)`);
    const changed = !store.schedule || store.schedule.source !== 'nexus' || JSON.stringify(store.schedule.matches.map(x => x.teams)) !== JSON.stringify(s.matches.map(x => x.teams))
      || (store.schedule.event || {}).key !== s.event.key;
    store.nexus.error = null; store.nexus.lastFetch = now();
    if (changed || manual) setSchedule(s, manual && (!store.schedule || (store.schedule.event || {}).key !== s.event.key));
  } catch (e) {
    store.nexus.error = String(e.message || e);
  }
  save(); broadcastConfig();
}
nexusTimer = setInterval(() => { if (store.nexus.auto && store.nexus.url && (timer.status !== 'running' || timer.kind === 'break')) nexusRefresh(false); }, 60000);

function broadcast(m) { for (const c of clients.values()) c.send(m); }
function broadcastState() { broadcast(stateMsg()); }
function broadcastConfig() { for (const c of clients.values()) c.send(configMsg(c)); }
function broadcastClients() {
  const list = [...clients.values()].map(c => ({
    id: c.id, role: c.role, view: c.view, deviceId: c.deviceId, name: c.name, ip: c.ip, rtt: c.rtt, offset: c.offset,
    lastSeenAgo: now() - c.lastSeen, audio: c.audio, wake: c.wake, pref: c.deviceId ? store.displays[c.deviceId] : null,
  }));
  for (const c of clients.values()) if (c.role === 'control' && c.authed) c.send({ t: 'clients', list });   // IPs + device ids: Head Ref only
}
setInterval(broadcastClients, 1000);
// Heartbeat: every socket gets a WebSocket ping every 5 s (browsers answer with a pong automatically) and is
// dropped hard (destroy, no closing handshake) after 20 s without any frame: a half-open Wi-Fi link can't linger.
setInterval(() => {
  for (const c of clients.values()) { if (now() - c.lastSeen > 20000) c.kill(); else c.ping(); }
}, 5000);

// ---------- minimal WebSocket (RFC 6455) ----------
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true); try { socket.setKeepAlive(true, 5000); } catch (e) {}
  const c = {
    id: nextId++, role: 'display', name: '', ip: (req.socket.remoteAddress || '').replace('::ffff:', ''),
    rtt: null, offset: null, lastSeen: now(), authed: !PIN, alive: true,
    send(obj) { if (c.alive) try { socket.write(frame(Buffer.from(JSON.stringify(obj)), 1)); } catch (e) {} },
    close() { if (!c.alive) return; c.alive = false; clients.delete(c.id); try { socket.end(frame(Buffer.alloc(0), 8)); } catch (e) {} setTimeout(() => socket.destroy(), 2000).unref(); broadcastClients(); },
    kill() { c.alive = false; clients.delete(c.id); socket.destroy(); broadcastClients(); },
    ping() { if (c.alive) try { socket.write(frame(Buffer.alloc(0), 9)); } catch (e) {} },
  };
  clients.set(c.id, c);
  // Strict RFC 6455 reading: client frames must be masked, no reserved bits, known opcodes only, control frames short and
  // unfragmented, continuation only inside a message, and a hard cap on one message (all fragments) and on unread input.
  const MAX_MSG = 2 << 20;   // 2 MB: the largest legit message is a schedule CSV (capped at 1 MB)
  let buf = Buffer.alloc(0), fragments = [], fragLen = 0, inMsg = false;
  const fail = code => { if (!c.alive) return; c.alive = false; clients.delete(c.id);
    try { const b = Buffer.alloc(2); b.writeUInt16BE(code, 0); socket.end(frame(b, 8)); } catch (e) {} setTimeout(() => socket.destroy(), 1000).unref(); broadcastClients(); };
  socket.on('data', d => {
    if (!c.alive) return;
    c.lastSeen = now();
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (buf.length > MAX_MSG + 16) return fail(1009);
    while (c.alive) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, rsv = buf[0] & 0x70, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      if (rsv) return fail(1002);
      if (!masked) return fail(1002);
      if (![0, 1, 2, 8, 9, 10].includes(op)) return fail(1002);
      const control = op >= 8;
      let len = buf[1] & 0x7f, off = 2;
      if (control && (len > 125 || !fin)) return fail(1002);
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return fail(1009); len = Number(big); off = 10; }
      if (!control && fragLen + len > MAX_MSG) return fail(1009);
      const need = off + 4 + len;
      if (buf.length < need) return;
      const mk = buf.slice(off, off + 4), payload = Buffer.from(buf.slice(off + 4, need));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
      buf = buf.slice(need);
      if (op === 8) return c.close();
      if (op === 9) { try { socket.write(frame(payload, 10)); } catch (e) {} continue; }
      if (op === 10) continue;
      if (op === 0 && !inMsg) return fail(1002);
      if (op !== 0 && inMsg) return fail(1002);
      if (op === 2) { if (!fin) { inMsg = 'bin'; fragLen += len; } continue; }   // binary: not used, ignored
      if (inMsg === 'bin') { fragLen += len; if (fin) { inMsg = false; fragLen = 0; } continue; }
      fragments.push(payload); fragLen += len;
      if (!fin) { inMsg = 'text'; continue; }
      const text = Buffer.concat(fragments).toString('utf8'); fragments = []; fragLen = 0; inMsg = false;
      let msg; try { msg = JSON.parse(text); } catch (e) { continue; }
      try { handleMessage(c, msg); } catch (e) { c.send({ t: 'error', error: String(e.message || e) }); }
    }
  });
  socket.on('close', () => { c.alive = false; clients.delete(c.id); broadcastClients(); });
  socket.on('error', () => { c.alive = false; clients.delete(c.id); socket.destroy(); });
}
function frame(payload, op) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.csv': 'text/csv' };
const ROUTES = { '/': '/index.html', '/display': '/display.html', '/control': '/control.html', '/ref': '/ref.html' };
const SOUND_EXT = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm', 'audio/flac': '.flac' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Never let one odd request take the server down: bad URLs/headers get a 400, anything unexpected a 500.
function parseUrl(raw) { try { return new URL(raw, 'http://x'); } catch (e) { return null; } }
function badRequest(res, why) { try { if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad request' + (why ? ': ' + why : '')); } catch (e) {} }
const server = http.createServer((req, res) => {
  try { handleHttp(req, res); }
  catch (e) { console.error('  HTTP handler error:', e && e.stack || e); try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (e2) {} }
});
function handleHttp(req, res) {
  const u = parseUrl(req.url);
  if (!u) return badRequest(res, 'invalid URL');
  if (u.pathname === '/api/info') return json(res, 200, { urls: lanUrls(), pinRequired: !!PIN, port: PORT });
  if (u.pathname === '/api/tables') return json(res, 200, { tables: allTables().sort((a, b) => a - b) });
  if (u.pathname === '/api/time') return json(res, 200, { s: now(), ...timer });
  if (u.pathname === '/api/schedule.csv') {
    if (!store.schedule) { res.writeHead(404); return res.end('No schedule'); }
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="schedule.csv"' });
    return res.end(Sched.toCSV(store.schedule));
  }
  let mm = u.pathname.match(/^\/api\/sound\/(start|warn|end|abort|call)$/);
  if (mm && req.method === 'POST') {
    if (PIN) {
      const ip = (req.socket.remoteAddress || '').replace('::ffff:', ''), r = pinCheck(ip, 'http:' + ip, req.headers['x-fll-pin']);
      if (!r.ok) return json(res, r.wait ? 429 : 403, { error: r.wait ? r.error : 'PIN required' });
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let name;
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'sound')).slice(0, 80); }
    catch (e) { return json(res, 400, { error: 'Bad X-File-Name header (invalid %-encoding)' }); }
    const ext = SOUND_EXT[type] || (path.extname(name).toLowerCase().match(/^\.(mp3|wav|ogg|m4a|aac|webm|flac)$/) || [''])[0];
    if (!ext) return json(res, 415, { error: 'Unsupported audio type: ' + (type || 'unknown') });
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', d => { size += d.length; if (size > MAX_SOUND) { tooBig = true; req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (tooBig) return;
      const cue = store.sound.cues[mm[1]];
      if (cue.file) fs.unlink(path.join(SOUND_DIR, cue.file.stored), () => {});
      const stored = mm[1] + '-' + now() + ext;
      fs.writeFile(path.join(SOUND_DIR, stored), Buffer.concat(chunks), err => {
        if (err) return json(res, 500, { error: String(err) });
        cue.file = { name, type: type || 'audio/' + ext.slice(1), size, stored, v: now() };
        save(); broadcastConfig(); json(res, 200, { ok: true, file: cue.file });
      });
    });
    return;
  }
  mm = u.pathname.match(/^\/sounds\/(start|warn|end|abort|call)$/);
  if (mm) {
    const f = store.sound.cues[mm[1]].file;
    if (!f) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(SOUND_DIR, f.stored), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'max-age=31536000' }); res.end(data);
    });
  }
  let p = ROUTES[u.pathname] || u.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
server.on('upgrade', (req, socket) => {
  try {
    socket.on('error', () => socket.destroy());
    const u = parseUrl(req.url);
    if (!u) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (u.pathname !== '/ws') return socket.destroy();
    wsAccept(req, socket);
  } catch (e) { console.error('  WebSocket upgrade error:', e && e.message); try { socket.destroy(); } catch (e2) {} }
});
server.on('clientError', (err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch (e) {} });
// Last line of defence: log, keep running. A tournament must not lose every screen because of one bad packet.
process.on('uncaughtException', e => console.error('  [kept running] unexpected error:', e && e.stack || e));
process.on('unhandledRejection', e => console.error('  [kept running] unhandled promise rejection:', e && e.stack || e));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); console.log('\n  State saved. Bye.'); process.exit(0); });

function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces()))
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, url: `http://${a.address}:${PORT}` });
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log('\n  FLL Synced Match Timer is running\n');
  console.log(`  This computer:   http://localhost:${PORT}/control`);
  if (!urls.length) console.log('  (No LAN interface found - connect this laptop to the venue Wi-Fi/router.)');
  for (const u of urls) {
    console.log(`\n  [${u.iface}]`);
    console.log(`    Head Ref control:   ${u.url}/control`);
    console.log(`    Projector (main):   ${u.url}/display?role=main`);
    console.log(`    Pair screens:       ${u.url}/display?pair=A   (B, C …)`);
    console.log(`    Queuing screen:     ${u.url}/display?role=queue`);
    console.log(`    Table referees:     ${u.url}/ref?table=1   (2, 3 …)`);
  }
  console.log(PIN ? `\n  Control PIN is set (${PIN.length} digits).` : '\n  No control PIN set. Use  npm start -- --pin 1234  to lock the control page.');
  console.log(`  Settings, schedule and uploaded sounds are saved in ${DATA_DIR}`);
  if (urls[0]) {
    try { const qr = require('qrcode-terminal'); console.log(`\n  Scan to pick a display (${urls[0].url}/display):\n`); qr.generate(urls[0].url + '/display', { small: true }); }
    catch (e) { console.log('\n  Tip: the control page shows a QR code for the display URL.'); }
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});
