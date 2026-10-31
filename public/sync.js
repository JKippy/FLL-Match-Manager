// Shared client: WebSocket connection, NTP-style clock sync, timer math, schedule helpers, FIRST-style sounds.
(function () {
  'use strict';
  const SKEW = window.__SKEW || 0;              // test hook: fake clock error (ms)
  const SIM = window.__SIM_DELAY || 0;          // test hook: random one-way delay up to N ms
  const perfNow = () => performance.timeOrigin + performance.now();
  const localNow = () => perfNow() + SKEW;

  let deviceId = null;
  try { deviceId = localStorage.getItem('fll.device'); if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('fll.device', deviceId); } } catch (e) { deviceId = 'x' + Math.random().toString(36).slice(2); }
  if (window.__DEVICE_ID) deviceId = window.__DEVICE_ID;

  const S = {
    role: 'display', view: '', name: '', pin: '', deviceId,
    ws: null, connected: false, id: null, pinRequired: false, authed: false,
    offset: 0, rtt: null, synced: false, samples: [],
    // haveClock: the clock offset has been measured at least once (it stays valid while disconnected).
    // stale: the link died without a close (heartbeat timeout), so the state we hold may be wrong: no cues until fresh state arrives.
    haveClock: false, stale: false,
    // offline: the link dropped while the device itself reported no network (Wi-Fi off). The match may have been paused
    // meanwhile, so the local clock keeps showing time but never plays END or shows "Time!" on its own (#54). Cleared by fresh state.
    offline: false,
    isOffline() { return this.offline || (!this.connected && navigator.onLine === false); },
    state: null, config: null, schedule: null, calls: {}, listeners: {},
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    emit(ev, d, d2) { (this.listeners[ev] || []).forEach(f => { try { f(d, d2); } catch (e) { console.error(e); } }); },
    serverNow() { return localNow() + this.offset; },
    remaining() {
      const st = this.state; if (!st) return null;
      if (st.status === 'running') return Math.max(0, Math.min(st.duration, st.duration - (this.serverNow() - st.startAt)));
      if (st.status === 'paused') return st.remainingAtPause;
      if (st.status === 'done') return 0;
      return st.duration;
    },
    send(obj) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      const go = () => { try { this.ws.send(JSON.stringify(obj)); } catch (e) {} };
      if (SIM) setTimeout(go, Math.random() * SIM); else go();
      return true;
    },
    // Commands resolve with the server's ack ({ok, error, code}). A refused or unsent command is never silent:
    // it is logged to the console and emitted as 'error' (the control page shows a toast), except 'ahead' which
    // is emitted as 'ahead' so the control page can ask "Start anyway?".
    // Each tap gets one unique id (uid): the server applies a uid at most once and answers a repeat with the first ack.
    // Commands are never resent automatically. If the reply is lost we say so and let the Head Ref / referee check the screen.
    cmd(cmd, extra) {
      const id = ++cmdSeq, uid = PAGE + '.' + id;
      return new Promise(resolve => {
        if (!this.send(Object.assign({ t: 'cmd', cmd, id, uid }, extra || {}))) {
          const r = { ok: false, cmd, error: 'Not connected to the timer server (reconnecting…). Check the Wi-Fi and try again.' };
          S.refused(r); return resolve(r);
        }
        const timer = setTimeout(() => { if (pending.delete(id)) { const r = { ok: false, cmd, error: 'No reply from the timer server for “' + label(cmd) + '”. It may still have gone through: check the screen before tapping again.' }; S.refused(r); resolve(r); } }, 4000);
        pending.set(id, { cmd, done: r => { clearTimeout(timer); resolve(r); } });
      });
    },
    refused(r) {
      console.warn('[FLL] command refused:', r.cmd, '-', r.error);
      // 'ahead' (too early) and 'notready' (a table referee hasn't tapped READY) both become a "Start anyway?" prompt.
      if ((r.code === 'ahead' || r.code === 'notready') && (this.listeners.ahead || []).length) this.emit('ahead', r); else this.emit('error', r.error);
    },
    hello() { return this.send({ t: 'hello', role: this.role, view: this.view, name: this.name, pin: this.pin, deviceId: this.deviceId, ua: navigator.userAgent, table: this.table, key: this.key }); },
  };

  let cmdSeq = 0; const pending = new Map();
  // This page load's random tag (crypto, works on plain-HTTP LAN pages too): tap uids stay unique across devices and reloads.
  const PAGE = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  const LABELS = { start: 'START', pause: 'PAUSE', reset: 'RESET / ABORT', breakEnd: 'END BREAK', breakStart: 'START BREAK', goto: 'change match', refReady: 'READY', refCall: 'Call Head Ref', refCancel: 'Cancel call', callAck: 'acknowledge call' };
  const label = c => LABELS[c] || c;
  let pingTimer = null, burstLeft = 0, backoff = 500, retryT = null, openT = null;
  // Heartbeat: we ping every second; if a ping goes unanswered for HB_MS (no frame at all from the server), the link is
  // dead even though TCP hasn't noticed (half-open Wi-Fi). Drop the socket, mark the state stale and reconnect.
  const HB_MS = window.__HB_MS || 2500, PING_MS = 1000, OPEN_MS = 5000;
  let pingOutAt = null;
  const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  S.connect = function (opts) { Object.assign(S, opts || {}); open(); };
  function open() {
    clearTimeout(retryT); retryT = null;
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { return retry(); }
    S.ws = ws; pingOutAt = null;
    clearTimeout(openT); openT = setTimeout(() => { if (S.ws === ws && ws.readyState !== 1) lost(ws, S.stale); }, OPEN_MS);   // a connect that hangs (frozen link)
    ws.onopen = () => { if (S.ws !== ws) return; clearTimeout(openT); S.connected = true; backoff = 500; S.samples = []; S.hello(); burstLeft = 12; ping(); S.emit('status'); };
    ws.onmessage = ev => {
      if (S.ws !== ws) return;
      const recv = localNow(); pingOutAt = null;
      const handle = () => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m, SIM ? localNow() : recv); };
      if (SIM) setTimeout(handle, Math.random() * SIM); else handle();
    };
    ws.onclose = () => { if (S.ws === ws) lost(ws, false); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  // The connection is gone. stale=false: it closed (server stopped / restarted), we still trust the local clock, so a running
  // match still ends with its END cue. stale=true: heartbeat timeout, the server may be fine and the match paused: suppress cues.
  function lost(ws, stale) {
    if (S.ws !== ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch (e) {}
    S.ws = null; clearTimeout(openT); clearTimeout(pingTimer); pingOutAt = null;
    // A command sent but not answered may or may not have been applied: never resend it, tell the user to check (#46).
    for (const [id, p] of pending) {
      pending.delete(id);
      const r = { ok: false, cmd: p.cmd, error: 'Connection dropped: “' + label(p.cmd) + '” may not have gone through. Check the screen once reconnected, then tap again only if needed.' };
      S.refused(r); p.done(r);
    }
    // The device itself reports it is offline (Wi-Fi dropped): keep counting on the local clock (not stale, so the time stays on
    // screen), but mark it offline: END is held at 0:00 until the server confirms (#54). Only a silent link on a "working" network is stale.
    if (navigator.onLine === false) { S.offline = true; stale = false; }
    if (stale && !S.stale) console.warn('[FLL] no reply from the timer server for ' + HB_MS + ' ms: reconnecting, sounds paused until the state is fresh');
    if (stale) S.stale = true;
    S.connected = false; S.synced = false;
    S.emit('status'); retry();
  }
  S._lost = stale => S.ws && lost(S.ws, !!stale);   // test hook
  // The device lost its network: until fresh state arrives, the server may have paused the match without us knowing (#54).
  window.addEventListener('offline', () => { if (!S.connected && !S.offline) { S.offline = true; S.emit('status'); } });
  window.addEventListener('online', () => S.checkLink());   // network back: reconnect now instead of waiting out the backoff
  function retry() { if (retryT) return; retryT = setTimeout(open, backoff); backoff = Math.min(5000, backoff * 1.6); }
  function ping() {
    clearTimeout(pingTimer);
    if (!S.connected) return;
    if (pingOutAt == null) pingOutAt = perfNow();
    S.send({ t: 'ping', c0: localNow() });
    pingTimer = setTimeout(ping, burstLeft > 0 ? (burstLeft--, 80) : PING_MS);
  }
  setInterval(() => { if (S.ws && S.connected && pingOutAt != null && perfNow() - pingOutAt > HB_MS) lost(S.ws, true); }, 250);
  // Back from the background (iOS lock screen, tab switch): check the link right away instead of waiting for the next ping.
  S.checkLink = function () { if (S.connected) { burstLeft = Math.max(burstLeft, 3); ping(); } else if (retryT) { clearTimeout(retryT); retryT = null; open(); } };
  function onMsg(m, recv) {
    switch (m.t) {
      case 'pong': {
        const rtt = recv - m.c0;
        const offset = m.s - (m.c0 + rtt / 2);          // assume symmetric path
        S.samples.push({ rtt, offset, at: recv });
        if (S.samples.length > 30) S.samples.shift();
        const best = S.samples.slice().sort((a, b) => a.rtt - b.rtt).slice(0, 5).map(s => s.offset).sort((a, b) => a - b);
        S.offset = best[Math.floor(best.length / 2)];
        S.rtt = Math.min(...S.samples.map(s => s.rtt));
        S.synced = S.samples.length >= 4; if (S.synced) S.haveClock = true;
        S.emit('sync');
        if (S.role === 'display') S.send({ t: 'report', rtt: Math.round(S.rtt), offset: Math.round(S.offset), name: S.name, audio: Sound.enabled(), wake: S.wake || '' });
        break;
      }
      case 'welcome': S.id = m.id; S.pinRequired = m.pinRequired; S.authed = m.authed; S.authError = m.error || ''; if (m.refOk !== undefined) S.refOk = m.refOk; S.emit('status'); break;
      case 'refLink': S.refOk = !!m.ok; S.emit('status'); break;   // referee link replaced by the Head Ref
      case 'refKeys': S.refKeys = m.keys || {}; S.emit('refKeys', S.refKeys); break;   // control page only (PIN)
      case 'auth': S.authed = m.authed; S.authError = m.error || ''; S.emit('auth', m.authed, m); S.emit('status'); break;
      case 'state': { const prev = S.state; S.state = m; if (S.stale || S.offline) { S.stale = false; S.offline = false; S.emit('status'); } S.emit('state', { prev, state: m }); break; }
      case 'config': S.config = m; Sound.applyConfig(m); S.emit('config', m); break;
      case 'schedule': S.schedule = m.schedule; S.emit('schedule', m.schedule); break;
      case 'play': Sound.play(m.cue, true); break;
      case 'clients': S.emit('clients', m.list); break;
      case 'error': console.warn('[FLL] server error:', m.error); S.emit('error', m.error); break;
      case 'ack': { const p = pending.get(m.id); pending.delete(m.id); if (!m.ok) S.refused(m); if (p) p.done(m); break; }
      case 'notice': S.emit('notice', m.text); break;
      case 'calls': S.calls = m.calls || {}; S.emit('calls', S.calls); break;
      case 'chime': S.emit('chime', m); break;   // projector only: a referee called the Head Ref (no table info)
    }
  }

  S.fmt = function (ms) {
    if (ms == null) return '-:--';
    const total = Math.ceil(ms / 1000 - 1e-6);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };
  S.clock = t => t == null ? '' : new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // ---------- schedule helpers ----------
  S.pairsOf = function (match) {
    if (!match || !S.config) return [];
    const t = Object.keys(match.teams);
    return S.config.layout.pairs.filter(p => p.tables.some(x => t.includes(String(x)))).map(p => p.id);
  };
  S.pairById = id => S.config && S.config.layout.pairs.find(p => String(p.id).toLowerCase() === String(id).toLowerCase());
  S.matchLabel = m => m ? (m.practice ? 'Practice ' : 'Match ') + m.n : '';
  S.tableName = t => (S.schedule && S.schedule.tableNames && S.schedule.tableNames[t]) || ('Table ' + t);
  S.teamName = n => (S.schedule && S.schedule.teamNames && S.schedule.teamNames[n]) || '';
  // What is going on right now, from the schedule's point of view.
  S.matchInfo = function () {
    const sch = S.schedule, st = S.state;
    if (!sch || !st || !st.match || !sch.matches.length) return null;
    const mm = st.match, list = sch.matches;
    const liveIdx = (st.kind !== 'break' && (st.status === 'running' || st.status === 'paused')) ? mm.live : null;
    const doneIdx = st.status === 'done' ? mm.live : null;
    const current = list[mm.current] || null;
    const focusIdx = liveIdx != null ? liveIdx : doneIdx != null ? doneIdx : mm.current;
    const focus = list[focusIdx] || null;
    const nextIdx = (doneIdx != null && mm.current !== doneIdx) ? mm.current : focusIdx + 1;
    const next = list[nextIdx] || null;
    // Schedule delta, positive = behind. Live match: actual start vs scheduled.
    // Otherwise: now vs the scheduled start of the next match to be played.
    let delta = null;
    const actual = liveIdx != null && focus && mm.actualStarts ? mm.actualStarts[focus.n] : null;
    if (actual && focus.time != null) delta = actual - focus.time;
    else if (liveIdx == null && current && current.time != null && !(doneIdx != null && mm.current === doneIdx)) delta = S.serverNow() - current.time;
    // first match nobody has started yet
    const upIdx = liveIdx != null ? liveIdx + 1 : (doneIdx != null && mm.current === doneIdx) ? doneIdx + 1 : mm.current;
    return { list, current, currentIdx: mm.current, liveIdx, doneIdx, focus, focusIdx, next, nextIdx, upIdx, delta };
  };
  // Table-referee READY marks: ready[matchIndex][table] = time tapped. Only meaningful before the match starts.
  S.readyOf = idx => (idx != null && S.state && S.state.refs && S.state.refs.ready && S.state.refs.ready[idx]) || {};
  S.isReady = (idx, table) => !!S.readyOf(idx)[String(table)];
  // One tap at a time for buttons whose action depends on what the page shows (START/PAUSE, READY, Call Head Ref).
  // shown() returns the server state the page last painted. run(fn) is ignored while a tap is pending, for quietMs after
  // it settles (ack, refusal or the 4 s timeout), and, unless the server answered "no", until the page has painted a newer
  // server state (at most waitMs more). fn sends the command; nothing is ever resent.
  S.tapGuard = (shown, quietMs = 600, waitMs = 1000) => {
    let tap = null;
    const blocked = () => {
      if (!tap) return false;
      if (tap.pending) return true;
      const t = performance.now();
      if (t < tap.until || (tap.needState && shown() === tap.seen && t < tap.until + waitMs)) return true;
      tap = null; return false;
    };
    return {
      blocked,
      run(fn) {
        if (blocked()) return false;
        const t = tap = { seen: shown(), pending: true, until: 0, needState: true };
        const settle = r => { t.pending = false; t.until = performance.now() + quietMs; if (r && r.ok === false && r.id != null) t.needState = false; return r; };
        Promise.resolve().then(fn).then(settle, e => { settle(null); throw e; });
        return true;
      },
    };
  };
  // The match START would begin next (mirrors the server's upcomingIdx).
  S.upcomingIdx = function () {
    const st = S.state, sch = S.schedule; if (!st || !sch || !sch.matches.length) return null;
    const m = st.match; return st.kind !== 'break' && st.status === 'done' && m.live != null && m.current === m.live && m.current < sch.matches.length - 1 ? m.current + 1 : m.current;
  };
  // A table's next match: the live one if it's playing, else the first at/after the upcoming match.
  S.nextForTable = function (table) {
    const sch = S.schedule, st = S.state; if (!sch || !st) return null; table = String(table);
    const info = S.matchInfo();
    if (info && info.liveIdx != null && sch.matches[info.liveIdx] && sch.matches[info.liveIdx].teams[table]) return { m: sch.matches[info.liveIdx], i: info.liveIdx, live: true };
    const from = info && info.liveIdx != null ? info.liveIdx + 1 : S.upcomingIdx();
    for (let i = Math.max(0, from || 0); i < sch.matches.length; i++) if (sch.matches[i].teams[table]) return { m: sch.matches[i], i, live: false };
    return null;
  };
  S.isBreak = () => !!(S.state && S.state.kind === 'break' && S.state.status === 'running');
  // First match at/after index `from` that uses pair `pid`.
  S.nextForPair = function (pid, from) {
    const sch = S.schedule; if (!sch) return null;
    for (let i = Math.max(0, from); i < sch.matches.length; i++) if (S.pairsOf(sch.matches[i]).includes(pid)) return { m: sch.matches[i], i };
    return null;
  };
  S.deltaText = function (d) {
    if (d == null) return { text: '', cls: '' };
    const min = Math.round(Math.abs(d) / 60000);
    if (min < 1) return { text: 'On schedule', cls: 'ok' };
    return d > 0 ? { text: `+${min} min behind`, cls: min >= 5 ? 'bad' : 'meh' } : { text: `${min} min ahead`, cls: 'ok' };
  };

  // ---------- Sounds ----------
  // Two synthesized packs: "nature" (default, gentle) and "classic" (FIRST-style). Uploaded files override either.
  const Sound = {
    ctx: null, buffers: {}, raw: {}, versions: {}, cfg: null, pref: { vol: 1, muted: false },
    wanted: false,   // the user enabled sound on this page (a tap): from then on we keep it alive and hint if it drops
    ensureCtx() {
      if (!this.ctx) {
        // iOS 17+: "playback" so the ringer/silent switch doesn't mute the match sounds.
        try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { this.ctx = new AC(); try { this.ctx.onstatechange = () => { S.emit('audio', this.ctx.state); updateHint(); }; } catch (e) {} }
      }
      return this.ctx;
    },
    enabled() { return !!(this.ctx && this.ctx.state === 'running'); },
    // resume() rejects on some browsers (no audio device, not allowed yet): always caught, never an unhandled rejection.
    resume() {
      const c = this.ctx; if (!c || c.state === 'running' || c.state === 'closed') return Promise.resolve(this.enabled());
      let p; try { p = c.resume(); } catch (e) { p = null; }
      return Promise.resolve(p).catch(() => {}).then(() => { updateHint(); return this.enabled(); });
    },
    unlock() {
      this.wanted = true;
      try {
        const c = this.ensureCtx(); if (!c) return false;
        this.resume();
        const b = c.createBuffer(1, 1, 22050), src = c.createBufferSource();
        src.buffer = b; src.connect(c.destination); src.start(0);
        this.decodeAll();
      } catch (e) {}
      return this.enabled();
    },
    // Run fn once audio is actually running (resume() is async on Safari); dropped if it can't start.
    whenEnabled(fn) { if (this.enabled()) return fn(); this.resume().then(ok => { if (ok) fn(); }); },
    applyConfig(m) {
      this.cfg = m.sound; this.pref = m.pref || { vol: 1, muted: false };
      for (const [cue, c] of Object.entries(m.sound.cues)) {
        const v = c.file ? c.file.v : null;
        if (this.versions[cue] === v) continue;
        this.versions[cue] = v; delete this.buffers[cue]; delete this.raw[cue];
        if (v) fetch('/sounds/' + cue + '?v=' + v).then(r => r.arrayBuffer()).then(ab => { this.raw[cue] = ab; this.decode(cue); }).catch(() => {});
      }
    },
    decode(cue) {
      const c = this.ensureCtx(); const ab = this.raw[cue]; if (!c || !ab) return;
      const copy = ab.slice(0);
      const done = buf => { this.buffers[cue] = buf; S.emit('soundsLoaded', cue); };
      try { const p = c.decodeAudioData(copy, done, () => {}); if (p && p.then) p.then(done).catch(() => {}); } catch (e) {}
    },
    decodeAll() { for (const cue of Object.keys(this.raw)) if (!this.buffers[cue]) this.decode(cue); },
    gainFor(cue) {
      if (!this.cfg) return 1;
      if (this.pref && this.pref.muted) return 0;
      const pv = this.pref && this.pref.vol != null ? this.pref.vol : 1, mv = this.cfg.master == null ? 1 : this.cfg.master;
      if (cue === 'callSoft') return mv * (this.cfg.callMain == null ? 0.35 : this.cfg.callMain) * pv;
      const cv = this.cfg.cues[cue] ? this.cfg.cues[cue].vol : 1;
      return (this.cfg.master == null ? 1 : this.cfg.master) * cv * (this.pref && this.pref.vol != null ? this.pref.vol : 1);
    },
    play(cue, isTest) {
      const g = this.gainFor(cue);
      const src = this.buffers[cue] ? 'file' : 'synth';
      (window.__plays = window.__plays || []).push({ cue, gain: +g.toFixed(3), src, pack: this.pack(), test: !!isTest, at: perfNow() });
      if (!this.enabled() || g <= 0) return;
      const c = this.ctx, out = c.createGain(); out.gain.value = g; out.connect(c.destination);
      if (this.buffers[cue]) { const s = c.createBufferSource(); s.buffer = this.buffers[cue]; s.connect(out); s.start(); return; }
      this.synth(cue, out);
    },
    tone(out, freq, start, dur, type, vol, opt) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, start);
      if (opt && opt.glideTo) o.frequency.linearRampToValueAtTime(opt.glideTo, start + dur);
      if (opt && opt.vibrato) { const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = opt.vibrato; lg.gain.value = freq * 0.012; l.connect(lg); lg.connect(o.frequency); l.start(start); l.stop(start + dur + .05); }
      let node = o;
      if (opt && opt.lowpass) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opt.lowpass; o.connect(f); node = f; }
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(vol, start + (opt && opt.attack || 0.02));
      g.gain.setValueAtTime(vol, start + Math.max(0.03, dur - 0.08));
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      node.connect(g); g.connect(out); o.start(start); o.stop(start + dur + 0.05);
    },
    noise(out, start, dur, vol, freq) {
      const c = this.ctx, len = Math.floor(c.sampleRate * dur), b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = b; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 2;
      g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(vol, start + .05); g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      s.connect(f); f.connect(g); g.connect(out); s.start(start); s.stop(start + dur);
    },
    pack() { return (this.cfg && this.cfg.pack) || 'nature'; },
    // Percussive "struck" note: sum of sine partials [ratio, level, decay seconds].
    strike(out, f, start, vol, partials) {
      const c = this.ctx;
      for (const [ratio, lvl, dec] of partials) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(f * ratio, start);
        g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(vol * lvl, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dec);
        o.connect(g); g.connect(out); o.start(start); o.stop(start + dec + 0.05);
      }
    },
    marimba(out, f, t, vol) { this.strike(out, f, t, vol, [[1, 1, .9], [4, .35, .18], [10, .08, .05]]); },
    bell(out, f, t, vol, len) { const L = len || 2.4; this.strike(out, f, t, vol, [[1, 1, L], [2, .5, L * .7], [2.76, .35, L * .5], [5.4, .18, L * .3], [8.9, .06, L * .15]]); },
    chirp(out, t, f0, f1, d, vol) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + d * .3); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + d + .02);
    },
    swell(out, t, dur, vol) { // soft filtered-noise "ocean wave"
      const c = this.ctx, len = Math.floor(c.sampleRate * dur), b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      let last = 0; for (let i = 0; i < len; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 6; }
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = b; f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(1400, t + dur * .45); f.frequency.linearRampToValueAtTime(250, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * .45); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + dur);
    },
    synth(cue, out) {
      if (cue === 'callSoft') {   // projector "check your tablet" chime: two soft, low-ish bells, same in both packs
        const t = this.ctx.currentTime + 0.02;
        this.bell(out, 659.25, t, .22, 1.8); this.bell(out, 987.77, t + .32, .18, 2.2);
        return;
      }
      return this.pack() === 'classic' ? this.synthClassic(cue, out) : this.synthNature(cue, out); },
    // "Nature" pack (default): gentle, cheerful cues for a biodiversity-themed kids event.
    synthNature(cue, out) {
      const t = this.ctx.currentTime + 0.02;
      if (cue === 'start') {        // rising marimba arpeggio + a little bird-song flourish
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.marimba(out, f, t + i * .11, .5));
        this.marimba(out, 1567.98, t + .55, .45); this.marimba(out, 1046.5, t + .55, .3);
        [[.75, 2600, 4200, .09], [.86, 2800, 4600, .08], [.97, 3000, 5000, .1], [1.15, 4400, 2900, .14], [1.32, 3200, 5200, .09]].forEach(([d, a, b, l]) => this.chirp(out, t + d, a, b, l, .16));
      } else if (cue === 'warn') {  // wind chimes (pentatonic) + two soft woodblock knocks
        [[0, 1760], [.13, 2093], [.24, 2349.3], [.37, 2637], [.46, 3136], [.6, 2349.3], [.72, 2793.8], [.86, 2093]].forEach(([d, f]) => this.bell(out, f, t + d, .16, 1.6));
        [1.15, 1.4].forEach(d => this.strike(out, 820, t + d, .42, [[1, 1, .09], [2.3, .4, .05]]));
      } else if (cue === 'end') {   // "time's up": bright bell trio, twice, into a full chord over an ocean swell
        [[0, 523.25], [.2, 659.25], [.4, 783.99], [.75, 523.25], [.95, 659.25], [1.15, 783.99]].forEach(([d, f]) => this.bell(out, f, t + d, .42, 1.8));
        [523.25, 659.25, 783.99, 1046.5].forEach(f => this.bell(out, f, t + 1.55, .3, 3));
        [261.63, 392].forEach(f => this.tone(out, f, t + 1.5, 2.2, 'triangle', .16, { attack: .3 }));
        this.swell(out, t + 1.3, 2.8, .35);
      } else if (cue === 'call') {  // "Call Head Ref": a friendly two-note wood-thrush whistle + soft marimba, no alarm
        [[0, 783.99], [.16, 1046.5]].forEach(([d, f]) => this.marimba(out, f, t + d, .45));
        [[.38, 2200, 3300, .16], [.58, 3300, 2600, .18], [.86, 2200, 3300, .16], [1.06, 3300, 2600, .18]].forEach(([d, a, b, l]) => this.chirp(out, t + d, a, b, l, .2));
        this.bell(out, 1318.5, t + 1.35, .22, 1.4);
      } else if (cue === 'abort') { // gentle descending tones (no alarm)
        [[0, 783.99], [.32, 659.25], [.64, 523.25], [.96, 392]].forEach(([d, f]) => { this.tone(out, f, t + d, .55, 'triangle', .24, { attack: .03 }); this.tone(out, f / 2, t + d, .55, 'sine', .14, { attack: .03 }); });
      } else {
        this.marimba(out, 1046.5, t, .45); this.marimba(out, 1318.5, t + .12, .35);
      }
    },
    // "Classic" pack: the earlier FIRST-style cues (bugle charge, steam whistle, buzzer, foghorn).
    synthClassic(cue, out) {
      const t = this.ctx.currentTime + 0.01;
      const brass = (f, d, l) => { this.tone(out, f, t + d, l, 'sawtooth', 0.22, { lowpass: 2400, vibrato: 5.5, attack: .03 }); this.tone(out, f, t + d, l, 'square', 0.06, { lowpass: 1800 }); };
      if (cue === 'start') {        // "Cavalry Charge" bugle call: G C E G . E G~
        [[392, 0, .16], [523, .18, .16], [659, .36, .16], [784, .54, .3], [659, .9, .16], [784, 1.08, .9]].forEach(([f, d, l]) => brass(f, d, l));
      } else if (cue === 'warn') {  // end-game "steam whistle"
        [[0, 1.1]].forEach(([d, l]) => {
          this.tone(out, 740, t + d, l, 'triangle', .22, { glideTo: 780, attack: .08 });
          this.tone(out, 932, t + d, l, 'triangle', .16, { glideTo: 980, attack: .08 });
          this.tone(out, 1108, t + d, l, 'sine', .1, { glideTo: 1170, attack: .08 });
          this.noise(out, t + d, l, .08, 900);
        });
      } else if (cue === 'end') {   // "Buzzer"
        this.tone(out, 110, t, 1.6, 'sawtooth', .35); this.tone(out, 116, t, 1.6, 'square', .2); this.tone(out, 220, t, 1.6, 'sawtooth', .1);
      } else if (cue === 'call') {  // doorbell "ding-dong"
        this.bell(out, 659.25, t, .4, 1.4); this.bell(out, 523.25, t + .45, .4, 1.8);
      } else if (cue === 'abort') { // "Foghorn" (match stopped)
        this.tone(out, 82, t, 2.2, 'sawtooth', .45, { glideTo: 74, lowpass: 600, attack: .15 });
        this.tone(out, 164, t, 2.2, 'sawtooth', .2, { glideTo: 148, lowpass: 600, attack: .15 });
      } else {
        this.tone(out, 880, t, .25, 'sine', .3);
      }
    },
  };

  // Cues are one-shot events. start/warn/end are keyed by the run id (a new id on every fresh START) and only fire
  // when the moment is crossed live; abort fires only for a NEW abortId that happened in the last 3 s.
  // Nothing is ever derived from "state looks like X", so rebroadcasts, match navigation, reconnects and late
  // joins never replay a sound. `onCue` can still veto (pair displays).
  // While the server is unreachable (socket closed) the local clock keeps going and END still fires once, keyed by runId,
  // so it can't double-fire when the server comes back. Exception (#54): if the device itself is OFFLINE (no network), the
  // match may have been paused meanwhile, so END is held at 0:00; it plays once only if fresh state then says the run ended
  // (within 10 s), and not at all if the server says paused / still running. While the state is STALE (heartbeat timeout, the match may have
  // been paused meanwhile) nothing fires; if END came due during a short stall, it is played once when the fresh "done"
  // state arrives within 2 s of the end (only for a run this page watched running, so a late join never replays it).
  S.cueWatcher = function (onCue) {
    let last = null, lastSeq = null, seenAbort;
    const played = new Set(), watched = new Set(), held = new Set();
    const fire = (key, name) => { if (played.has(key)) return; played.add(key); onCue(name); };
    return function check() {
      const st = S.state; if (!st || S.stale || !S.haveClock) { last = null; return; }
      const aid = st.abortId || 0;
      if (seenAbort === undefined) seenAbort = aid;              // whatever happened before we joined is history
      else if (aid !== seenAbort) { seenAbort = aid; if (st.abortAt && S.serverNow() - st.abortAt < 3000) fire('abort:' + aid, 'abort'); }
      const r = S.remaining(), run = st.runId || 0;
      if (st.kind === 'break') { lastSeq = st.seq; last = Infinity; return; }   // field breaks are silent
      if (st.seq !== lastSeq) {
        lastSeq = st.seq;
        if (st.status !== 'running') {
          if (st.status === 'done' && last != null && last > 0 && last < 1500) fire(run + ':end', 'end');
          else if (st.status === 'done' && st.kind !== 'break' && watched.has(run) && st.match && st.match.endedAt && S.serverNow() - st.match.endedAt < (held.has(run) ? 10000 : 2000)) fire(run + ':end', 'end');
          last = r; return;
        }
      }
      if (st.status === 'running') watched.add(run);
      if (st.status === 'running' && last != null) {
        const dur = st.duration;
        const crossed = x => last > x && r <= x && last - r < 1500;
        if (last >= dur && r < dur && (S.serverNow() - st.startAt) < 1500) fire(run + ':start', 'start');
        if (dur > 30000 && crossed(30000)) fire(run + ':warn', 'warn');
        if (crossed(0)) { if (S.isOffline()) held.add(run); else fire(run + ':end', 'end'); }
      }
      last = r;
    };
  };

  // ---------- Keep the screen awake ----------
  // Wake Lock needs a secure context (https / localhost); on plain LAN http (the usual setup) we loop a tiny muted video.
  // iOS pauses that video (and releases a wake lock, and suspends audio) on lock screen / tab switch, so everything is
  // re-armed on visibilitychange / pageshow / focus. One set of listeners per page, however often keepAwake is called.
  const Wake = { want: false, lock: null, video: null };
  async function acquireWake() {
    if (!Wake.want) return S.wake || '';
    let mode = '';
    if ('wakeLock' in navigator && window.isSecureContext) {
      try { if (!Wake.lock || Wake.lock.released) Wake.lock = await navigator.wakeLock.request('screen'); mode = 'wakelock'; } catch (e) {}
    }
    if (!mode) {
      let v = Wake.video;
      if (!v) {
        v = Wake.video = document.createElement('video');
        v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.loop = true; v.src = '/keepawake.mp4';
        v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;bottom:0;left:0';
        document.body.appendChild(v);
      }
      try { if (v.paused) await v.play(); mode = 'video'; } catch (e) { mode = 'none'; }
    }
    if (S.wake !== mode) { S.wake = mode; S.emit('wake', mode); }
    return mode;
  }
  S.keepAwake = function () { Wake.want = true; return acquireWake(); };
  let reviveT = null;
  function revive() {
    if (document.visibilityState === 'hidden') return;
    clearTimeout(reviveT);
    reviveT = setTimeout(() => {
      (window.__revives = window.__revives || []).push(Date.now());
      acquireWake().then(() => S.emit('status'));
      if (Sound.wanted) Sound.resume();
      S.checkLink();
      setTimeout(updateHint, 600);
    }, 50);
  }
  document.addEventListener('visibilitychange', revive);
  window.addEventListener('pageshow', revive);
  window.addEventListener('focus', revive);
  // "Tap to re-enable sound": shown only when this page had sound on and the browser has suspended it (iOS after a lock,
  // a phone call, Siri…). Any tap anywhere resumes it. Written only on change (no per-frame DOM writes).
  let hintEl = null, hintShown = false;
  function updateHint() {
    const show = !!(Sound.wanted && Sound.ctx && Sound.ctx.state !== 'running' && Sound.ctx.state !== 'closed' && !S.noSoundHint && document.visibilityState !== 'hidden');
    if (show === hintShown) return;
    hintShown = show;
    if (show && !hintEl && document.body) {
      hintEl = document.createElement('div'); hintEl.id = 'soundHint';   // pointer-events:none: it never steals a click; any tap on the page re-enables sound
      hintEl.textContent = '🔇 Tap to re-enable sound';
      hintEl.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;background:#ffb020;color:#111;font:600 15px/1.2 system-ui,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 4px 18px #0008;pointer-events:none';
      document.body.appendChild(hintEl);
    }
    if (hintEl) hintEl.style.display = show ? 'block' : 'none';
    S.emit('audio', Sound.ctx && Sound.ctx.state);
  }
  S.updateSoundHint = updateHint;
  document.addEventListener('pointerdown', () => { if (Sound.wanted && !Sound.enabled()) { Sound.unlock(); if (Wake.want) acquireWake(); } }, { capture: true, passive: true });
  setInterval(updateHint, 2000);

  window.FLL = S; window.FLLSound = Sound; S.localNow = localNow; S.perfNow = perfNow;
})();
