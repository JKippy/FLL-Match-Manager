// Schedule import + match math. Normalized schedule:
// { source, event:{name,key,region,date}, teamNames:{num:name}, tableNames:{n:name},
//   matches:[{ n, time (epoch ms|null), teams:{ "1":"938", "2":"2596" }, practice }] }
'use strict';

const NEXUS_DB = process.env.NEXUS_DB || 'https://nexus-fll-prod-default-rtdb.firebaseio.com';

// ---------- Nexus for FLL ----------
// Accepts: "https://fll.nexus/fll/mm26", "fll.nexus/region/wisconsin/event/wipws/schedule", "wisconsin/wipws", "mm26"
function parseNexusRef(input) {
  const s = String(input || '').trim().replace(/^https?:\/\//, '').replace(/^(www\.)?fll\.nexus\/?/, '').replace(/[?#].*$/, '');
  let m = s.match(/region\/([^/]+)\/event\/([^/]+)/);
  if (m) return { region: m[1], event: m[2] };
  m = s.match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { region: m[1], event: m[2] };
  m = s.match(/^([A-Za-z0-9_-]+)\/?$/);
  if (m) return { region: null, event: m[1] };
  return null;
}

// Mirrors how the Nexus web app derives session times: sessions are ordered by key; a session with `time`
// pins the clock, later ones add (duration + resetDuration) / ceil(count / maxConcurrentCount).
function fromNexus(sessions, config, teams, meta) {
  const c = config || {};
  const cfg = {
    count: c.count || 4, duration: c.duration || 150000, resetDuration: c.resetDuration || 450000,
    maxConcurrentCount: c.maxConcurrentCount || c.count || 4, locationNames: c.locationNames || null,
  };
  const step = (cfg.duration + cfg.resetDuration) / (cfg.maxConcurrentCount ? Math.ceil(cfg.count / cfg.maxConcurrentCount) : 1);
  const keys = Object.keys(sessions || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const matches = []; let t = null;
  for (const k of keys) {
    const s = sessions[k] || {};
    if (t != null) t += step;
    if (s.time) t = s.time;
    const tm = {};
    const src = s.teams || {};
    for (const [loc, team] of Object.entries(src)) if (team != null && team !== '') tm[String(loc)] = String(team);
    if (!Object.keys(tm).length) continue;
    matches.push({ n: matches.length + 1, time: t, teams: tm, practice: !!s.practice, key: k });
  }
  const teamNames = {};
  for (const [num, v] of Object.entries(teams || {})) if (v && v.name) teamNames[num] = v.name;
  const tableNames = {};
  if (cfg.locationNames) for (const [k, v] of Object.entries(cfg.locationNames)) if (v) tableNames[k] = String(v);
  return { source: 'nexus', event: meta || {}, teamNames, tableNames, matches, config: cfg };
}

async function fetchJSON(url) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'Accept': 'application/json' } });
    const j = await r.json();
    if (j && j.error) throw new Error(`${j.error} (${url.replace(NEXUS_DB, '')})`);
    return j;
  } finally { clearTimeout(to); }
}

async function fetchNexus(input) {
  const ref = parseNexusRef(input);
  if (!ref) throw new Error('Could not read that Nexus link. Use e.g. https://fll.nexus/fll/mm26');
  const summaries = await fetchJSON(`${NEXUS_DB}/regionSummaries.json`).catch(() => null);
  if (!ref.region || (summaries && !(summaries[ref.region] && summaries[ref.region].events && summaries[ref.region].events[ref.event]))) {
    // short links like fll.nexus/fll/mm26: find which region owns this event key
    let found = null;
    for (const [r, v] of Object.entries(summaries || {})) if (v && v.events && v.events[ref.event]) found = r;
    if (found) ref.region = found;
    else if (!ref.region) throw new Error(`Event "${ref.event}" not found on Nexus`);
  }
  const base = `${NEXUS_DB}/regions/${encodeURIComponent(ref.region)}/events/${encodeURIComponent(ref.event)}`;
  const [sessions, config, teams] = await Promise.all([
    fetchJSON(`${base}/games/sessions.json`),
    fetchJSON(`${base}/games/config.json`).catch(() => null),
    fetchJSON(`${base}/teams.json`).catch(() => null),
  ]);
  const summary = summaries && summaries[ref.region] && summaries[ref.region].events && summaries[ref.region].events[ref.event] || {};
  const sched = fromNexus(sessions, config, teams, { key: ref.event, region: ref.region, name: summary.name || ref.event, date: summary.date || null,
    url: `https://fll.nexus/region/${ref.region}/event/${ref.event}/schedule` });
  return sched;
}

// ---------- CSV / pasted text ----------
const unquoteFormula = c => c.replace(/^'(?=[=+\-@])/, '');   // undo toCSV's formula guard
function splitRows(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const sample = lines.slice(0, 10).join('\n');
  const delim = (sample.match(/\t/g) || []).length >= lines.slice(0, 10).length ? '\t'
    : (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ';' : ',';
  // RFC4180-ish parser (quotes, doubled quotes, newlines inside quotes)
  const rows = []; let row = [], cell = '', q = false;
  const s = lines.join('\n') + '\n';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell.trim() === '') { q = true; cell = ''; continue; }
    if (ch === delim) { row.push(unquoteFormula(cell.trim())); cell = ''; continue; }
    if (ch === '\n') { row.push(unquoteFormula(cell.trim())); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  return rows.filter(r => r.some(c => c !== ''));
}

function parseTime(v, dateStr) {
  v = String(v || '').trim(); if (!v) return null;
  if (/^\d{12,14}$/.test(v)) return +v;                       // epoch ms
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(v)) {         // ISO-ish date + time
    const d = new Date(v.replace(' ', 'T')); if (!isNaN(d)) return d.getTime();
  }
  const m = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?\s*[Mm]?\.?/);
  if (!m) return null;
  let h = +m[1]; const min = +m[2], sec = +(m[3] || 0);
  if (m[4]) { const pm = /p/i.test(m[4]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  let base = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(dateStr + 'T00:00:00') : new Date();
  base.setHours(h, min, sec, 0);
  return base.getTime();
}

function teamCell(v) {
  v = String(v || '').trim(); if (!v || v === '-' || /^(none|empty|bye)$/i.test(v)) return null;
  const m = v.match(/^#?\s*(\d{1,6})\b\s*[-–:|]?\s*(.*)$/);
  if (m) return { num: m[1], name: m[2] || '' };
  return { num: v, name: '' };
}

// Wide: Time, [Match], Table 1..N   (Nexus public schedule page / likely export)
// Long: Match, Time, Table, Team    (one row per team)
// Limits keep one upload from freezing the server (every screen's clock runs on the same event loop).
const MAX_CSV_BYTES = 1024 * 1024, MAX_MATCHES = 2000, MAX_ROWS = 20000;
function parseCSV(text, opts = {}) {
  text = String(text || '');
  if (text.length > MAX_CSV_BYTES) throw new Error(`Schedule file too large (${Math.round(text.length / 1024)} KB, max ${MAX_CSV_BYTES / 1024} KB)`);
  let lines = 0; for (let i = text.indexOf('\n'); i >= 0 && lines <= MAX_ROWS; i = text.indexOf('\n', i + 1)) lines++;
  if (lines > MAX_ROWS) throw new Error(`Schedule file too large (more than ${MAX_ROWS} rows)`);
  const rows = splitRows(text);
  const isTimeH = h => /^(time|start|start time|scheduled|begin|session time)$/i.test(h);
  let hi = rows.findIndex(r => r.some(isTimeH) && r.length >= 2);
  if (hi < 0) throw new Error('No header row with a "Time" column found');
  const head = rows[hi].map(h => h.trim());
  const body = rows.slice(hi + 1);
  const col = re => head.findIndex(h => re.test(h));
  const timeC = head.findIndex(isTimeH);
  const matchC = col(/^(match|match ?#|match number|#|session|game|round ?#)$/i);
  const typeC = col(/^(type|round|stage|practice|match type)$/i);
  const tableC = col(/^(table|location|field|table #|table number)$/i);
  const teamC = col(/^(team|team #|team number|team no\.?)$/i);
  const teamNames = {}, tableNames = {};
  // A team that lands on a table another team already holds in the same match is dropped. That shouldn't happen silently:
  // the result lists every such team so the control page can warn (parsing ambiguities themselves are FLL-025).
  const dropped = [];
  const put = (m, table, num, row) => { const had = m.teams[table]; if (had != null && had !== num) dropped.push({ row, table, team: had, keptTeam: num }); m.teams[table] = num; };
  const matches = [], byKey = new Map();   // Map lookup: a big file used to be O(n²) (matches.find per row)
  const add = (key, time, practice) => {
    let m = byKey.get(key);
    if (!m) {
      if (matches.length >= MAX_MATCHES) throw new Error(`Schedule too large: more than ${MAX_MATCHES} matches`);
      m = { _key: key, time, teams: {}, practice }; matches.push(m); byKey.set(key, m);
    }
    return m;
  };
  if (tableC >= 0 && teamC >= 0) { // long format
    for (const r of body) {
      const tc = teamCell(r[teamC]); if (!tc) continue;
      const tableNum = (String(r[tableC]).match(/\d+/) || [r[tableC]])[0];
      const time = parseTime(r[timeC], opts.date);
      const key = matchC >= 0 && r[matchC] ? 'm' + r[matchC] : 't' + time;
      const m = add(key, time, typeC >= 0 && /practice/i.test(r[typeC] || ''));
      put(m, String(tableNum), tc.num, body.indexOf(r) + hi + 2);
      if (!/^\d+$/.test(String(r[tableC]))) tableNames[String(tableNum)] = String(r[tableC]);
      if (tc.name) teamNames[tc.num] = tc.name;
    }
  } else { // wide format: every other column that looks like a table/location
    const locCols = [];
    head.forEach((h, i) => {
      if (i === timeC || i === matchC || i === typeC || !h) return;
      if (/^(end|end time|notes?|comment|duration)$/i.test(h)) return;
      const num = (h.match(/(\d+)/) || [])[1];
      locCols.push({ i, table: num || String(locCols.length + 1), name: h });
    });
    if (!locCols.length) throw new Error('No table columns found (expected headers like "Table 1", "Table 2", …)');
    for (const lc of locCols) if (!/^table\s*\d+$/i.test(lc.name)) tableNames[lc.table] = lc.name;
    if (body.length > MAX_MATCHES * 2) throw new Error(`Schedule too large: ${body.length} rows (max ${MAX_MATCHES} matches)`);
    body.forEach((r, ri) => {
      const time = parseTime(r[timeC], opts.date);
      if (time == null && !(matchC >= 0 && r[matchC])) return;
      const m = add('r' + ri, time, typeC >= 0 && /practice/i.test(r[typeC] || ''));
      for (const lc of locCols) { const tc = teamCell(r[lc.i]); if (tc) { put(m, lc.table, tc.num, ri + hi + 2); if (tc.name) teamNames[tc.num] = tc.name; } }
    });
  }
  const out = matches.filter(m => Object.keys(m.teams).length);
  out.forEach((m, i) => { m.n = i + 1; delete m._key; });
  if (!out.length) throw new Error('No matches with team numbers found');
  const res = { source: opts.source || 'csv', event: { name: opts.name || 'Uploaded schedule', date: opts.date || null }, teamNames, tableNames, matches: out };
  if (dropped.length) res.dropped = dropped.slice(0, 200);
  return res;
}

// Spreadsheet apps treat a cell starting with = + - @ (or tab / CR) as a formula: such cells get a leading apostrophe, and
// cells with a comma, quote or line break are quoted. splitRows drops that apostrophe again on import.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(sched) {
  const tables = [...new Set(sched.matches.flatMap(m => Object.keys(m.teams)))].sort((a, b) => a - b);
  const fmt = t => { if (t == null) return ''; const d = new Date(t); return d.toTimeString().slice(0, 5); };
  const lines = [['Match', 'Time', ...tables.map(t => 'Table ' + t)].map(csvCell).join(',')];
  for (const m of sched.matches) lines.push([m.n, fmt(m.time), ...tables.map(t => m.teams[t] || '')].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// ---------- pairs / layout ----------
const DEFAULT_LAYOUT = { pairs: [{ id: 'A', tables: ['1', '2'] }, { id: 'B', tables: ['3', '4'] }, { id: 'C', tables: ['5', '6'] }] };
function pairsFor(match, layout) {
  if (!match) return [];
  const t = Object.keys(match.teams);
  return (layout || DEFAULT_LAYOUT).pairs.filter(p => p.tables.some(x => t.includes(String(x)))).map(p => p.id);
}

module.exports = { MAX_MATCHES, MAX_CSV_BYTES, parseNexusRef, fromNexus, fetchNexus, parseCSV, parseTime, toCSV, pairsFor, DEFAULT_LAYOUT, NEXUS_DB };
