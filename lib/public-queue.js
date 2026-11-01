// Public queue snapshot. Callers pass the whole timer state; only the fields listed
// below are copied. Anything else (PIN, device ids, referee keys, commands) is dropped.
'use strict';

const TIMER_STATUS = new Set(['idle', 'running', 'paused', 'done']);

function str(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
}
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}
function int(v) {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}
function strMap(obj, keyMax, valMax) {
  const out = Object.create(null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const key = str(k, keyMax);
    const val = str(obj[k], valMax);
    if (!key || !val) continue;
    out[key] = val;
  }
  return out;
}

function toPublicQueue(state, nowMs) {
  const src = state && typeof state === 'object' ? state : {};
  const timer = src.timer && typeof src.timer === 'object' ? src.timer : {};
  const match = src.match && typeof src.match === 'object' ? src.match : {};
  const display = src.display && typeof src.display === 'object' ? src.display : {};
  const layout = src.layout && typeof src.layout === 'object' ? src.layout : {};
  const sch = src.schedule && typeof src.schedule === 'object' && !Array.isArray(src.schedule) ? src.schedule : null;

  const actualStarts = Object.create(null);
  const rawA = match.actualStarts;
  if (rawA && typeof rawA === 'object' && !Array.isArray(rawA)) {
    for (const k of Object.keys(rawA)) {
      if (!/^\d{1,6}$/.test(k)) continue;
      const v = num(rawA[k]);
      if (v != null) actualStarts[k] = v;
    }
  }

  const pairs = [];
  for (const p of (Array.isArray(layout.pairs) ? layout.pairs : [])) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.id, 12);
    if (!id) continue;
    const tables = [];
    for (const t of (Array.isArray(p.tables) ? p.tables : [])) {
      const s = str(t, 12);
      if (s) tables.push(s);
    }
    if (tables.length) pairs.push({ id, tables });
  }

  let schedule = null;
  if (sch && Array.isArray(sch.matches)) {
    const matches = [];
    for (const m of sch.matches.slice(0, 2000)) {
      if (!m || typeof m !== 'object') continue;
      const n = int(m.n);
      if (n == null) continue;
      matches.push({ n, time: num(m.time), teams: strMap(m.teams, 12, 20), practice: m.practice === true });
    }
    schedule = { tableNames: strMap(sch.tableNames, 40, 40), teamNames: strMap(sch.teamNames, 20, 80), matches };
  }

  const qc = int(display.queueCount);
  const duration = num(timer.duration);
  const current = int(match.current);
  return {
    serverNow: typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now(),
    timer: {
      status: TIMER_STATUS.has(timer.status) ? timer.status : 'idle',
      kind: timer.kind === 'break' ? 'break' : 'match',
      duration: duration == null ? 0 : duration,
      startAt: num(timer.startAt),
      remainingAtPause: num(timer.remainingAtPause),
      breakUntil: num(timer.breakUntil),
      lunch: timer.lunch === true,
    },
    match: {
      current: current == null ? 0 : Math.max(0, current),
      live: int(match.live),
      actualStarts,
    },
    display: {
      queueCount: qc == null ? 2 : Math.max(0, Math.min(8, qc)),
      theme: display.theme === 'plain' ? 'plain' : 'nature',
    },
    layout: { pairs },
    schedule,
  };
}

module.exports = { toPublicQueue };
