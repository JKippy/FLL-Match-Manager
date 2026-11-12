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
// A number, or a string of one. Arrays and objects are not numbers: Number([]) is 0, and a string time must not be concatenated.
function finiteNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
// 0 and anything that is not a positive number keep the usual default, including a non-numeric duration ("nope" must not become NaN).
function orDefault(v, d) { const n = finiteNum(v); return n != null && n > 0 ? n : d; }
function fromNexus(sessions, config, teams, meta) {
  const c = config || {};
  const cfg = {
    count: orDefault(c.count, 4), duration: orDefault(c.duration, 150000), resetDuration: orDefault(c.resetDuration, 450000),
    maxConcurrentCount: orDefault(c.maxConcurrentCount, orDefault(c.count, 4)), locationNames: c.locationNames || null,
  };
  const step = (cfg.duration + cfg.resetDuration) / (cfg.maxConcurrentCount ? Math.ceil(cfg.count / cfg.maxConcurrentCount) : 1);
  const keys = Object.keys(sessions || {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const matches = []; let t = null;
  const problems = [];
  for (const k of keys) {
    const s = sessions[k] || {};
    if (t != null) t += step;
    const pinned = finiteNum(s.time);
    if (pinned != null) t = pinned;
    else if (s.time != null && s.time !== '') problems.push({ message: `Session ${k}: time is not a number` });
    const tm = {};
    const src = s.teams || {};
    for (const [loc, team] of Object.entries(src)) {
      if (team == null || team === '') continue;
      if (typeof team === 'object') { problems.push({ message: `Session ${k}: table ${loc} team is not a team number` }); continue; }
      tm[String(loc)] = String(team);
    }
    if (!Object.keys(tm).length) continue;
    matches.push({ n: matches.length + 1, time: t, teams: tm, practice: !!s.practice, key: k });
  }
  const teamNames = {};
  for (const [num, v] of Object.entries(teams || {})) if (v && v.name) teamNames[num] = v.name;
  const tableNames = {};
  if (cfg.locationNames) for (const [k, v] of Object.entries(cfg.locationNames)) if (v) tableNames[k] = String(v);
  const res = { source: 'nexus', event: meta || {}, teamNames, tableNames, matches, config: cfg };
  if (problems.length) res.problems = problems.slice(0, 200);
  return res;
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
// Formula guard (#32): a cell starting with = + - @ tab CR or ' gets one leading apostrophe on export; import strips exactly
// one apostrophe when the next character is in that same set, so guardFormula/unquoteFormula are exact inverses.
const FORMULA_START = /^[=+\-@\t\r']/;
const guardFormula = s => FORMULA_START.test(s) ? "'" + s : s;
const unquoteFormula = c => c.replace(/^'(?=[=+\-@\t\r'])/, '');
function splitRows(text) {
  // Keep blank lines. Dropping them first used to delete a blank line inside a quoted cell before the quotes were read (#28).
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const sampleLines = raw.split('\n').filter(l => l.trim() !== '').slice(0, 10);
  if (!sampleLines.length) return [];
  const sample = sampleLines.join('\n');
  const delim = (sample.match(/\t/g) || []).length >= sampleLines.length ? '\t'
    : (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ';' : ',';
  // RFC4180-ish parser (quotes, doubled quotes, newlines inside quotes)
  const rows = []; let row = [], cell = '', q = false;
  const s = raw.endsWith('\n') ? raw : raw + '\n';
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
  if (/^\d{12,14}$/.test(v)) { const n = +v; return Number.isFinite(n) ? n : null; }   // epoch ms
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(v)) {         // ISO-ish date + time
    const d = new Date(v.replace(' ', 'T')); return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  const m = v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?\s*[Mm]?\.?/);
  if (!m) return null;
  let h = +m[1]; const min = +m[2], sec = +(m[3] || 0);
  // 25:99, 9:75 and 13:00 PM used to overflow into the next day. Those are not times.
  if (min > 59 || sec > 59) return null;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    const pm = /p/i.test(m[4]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  } else if (h > 23) return null;
  let base;
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    base = new Date(dateStr + 'T00:00:00');
    if (!Number.isFinite(base.getTime())) return null;   // 2026-13-40 matched the shape and used to return NaN
  } else base = new Date();
  base.setHours(h, min, sec, 0);
  const t = base.getTime();
  return Number.isFinite(t) ? t : null;
}

// CR, LF, CRLF, U+2028 and U+2029 become one space, so a name stays one cell and one team (#52).
function flattenBreaks(s) { return String(s || '').replace(/(?:\r\n|[\n\r\u2028\u2029])+/g, ' '); }
function teamCell(v) {
  v = flattenBreaks(v).trim(); if (!v || v === '-' || /^(none|empty|bye)$/i.test(v)) return null;
  const m = v.match(/^#?\s*(\d{1,6})\b\s*[-–:|]?\s*(.*)$/);
  if (m) return { num: m[1], name: m[2] || '' };
  return { num: v, name: '' };
}
// Practice column: Nexus writes TRUE/FALSE (the blank template uses Yes). A cell that says "Practice" still counts.
function isPracticeCell(v) {
  const s = String(v || '').trim();
  if (/^(y|yes|t|true)$/i.test(s)) return true;
  if (/^(n|no|false)$/i.test(s)) return false;
  return /practice/i.test(s);
}
// A wide-format column is a table only when the header clearly says so: "Table 2", "T2", or "2".
// "Unnamed: 2" and "Red 1" contain a digit but are not table names (#27).
function tableNumberFromHeader(h) {
  const s = String(h || '').trim();
  const named = s.match(/^(?:table|t)\s*(\d+)$/i);
  if (named) return named[1];
  const bare = s.match(/^(\d+)$/);
  return bare ? bare[1] : null;
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
  const typeC = col(/^(type|round|stage|practice\s*\??|match type)$/i);
  const tableC = col(/^(table|location|field|table #|table number)$/i);
  const teamC = col(/^(team|team #|team number|team no\.?)$/i);
  const teamNames = {}, tableNames = {};
  // A team that lands on a table another team already holds in the same match is dropped. That shouldn't happen silently:
  // the result lists every such team so the control page can warn (parsing ambiguities themselves are FLL-025).
  const dropped = [];
  const problems = [];
  const put = (m, table, num, row) => { const had = m.teams[table]; if (had != null && had !== num) dropped.push({ row, table, team: had, keptTeam: num }); m.teams[table] = num; };
  const noteTime = (r, row) => {
    const raw = String(r[timeC] == null ? '' : r[timeC]).trim();
    const time = parseTime(r[timeC], opts.date);
    if (raw && time == null) problems.push({ row, message: `Row ${row}: "${raw}" is not a valid time` });
    return time;
  };
  const matches = [], byKey = new Map();   // Map lookup: a big file used to be O(n²) (matches.find per row)
  const add = (key, time, practice) => {
    let m = byKey.get(key);
    if (!m) {
      if (matches.length >= MAX_MATCHES) throw new Error(`Schedule too large: more than ${MAX_MATCHES} matches`);
      m = { _key: key, time, teams: {}, practice }; matches.push(m); byKey.set(key, m);
    }
    return m;
  };
  let unknownColumns = [];
  if (tableC >= 0 && teamC >= 0) { // long format
    body.forEach((r, ri) => {
      const row = ri + hi + 2;
      const tc = teamCell(r[teamC]); if (!tc) return;
      const time = noteTime(r, row);
      if (time == null && String(r[timeC] == null ? '' : r[timeC]).trim()) return;
      const rawTable = String(r[tableC] == null ? '' : r[tableC]).trim();
      const tableNum = (rawTable.match(/\d+/) || [null])[0];
      // A blank Table cell used to land the team on table "" (#28).
      if (!tableNum) { problems.push({ row, message: `Row ${row}: team ${tc.num} has no table number` }); return; }
      const key = matchC >= 0 && r[matchC] ? 'm' + r[matchC] : 't' + time;
      const m = add(key, time, typeC >= 0 && isPracticeCell(r[typeC]));
      put(m, String(tableNum), tc.num, row);
      if (!/^\d+$/.test(rawTable)) tableNames[String(tableNum)] = rawTable;
      if (tc.name) teamNames[tc.num] = tc.name;
    });
  } else { // wide format: every other column that looks like a table/location
    const locCols = [];
    head.forEach((h, i) => {
      if (i === timeC || i === matchC || i === typeC) return;
      if (h && /^(end|end time|notes?|comment|duration)$/i.test(h)) return;
      const num = tableNumberFromHeader(h);
      // Blank headers and names that merely contain a digit ("Unnamed: 2", "Red") are not tables.
      // Their teams stay unplaced and the warning names the column or its position (#27).
      if (!num) { unknownColumns.push({ column: h ? h : `(blank column ${i + 1})`, teams: 0, i }); return; }
      locCols.push({ i, table: num, name: h });
    });
    if (!locCols.length) throw new Error('No table columns found (expected headers like "Table 1", "Table 2", …)');
    for (const lc of locCols) if (!/^table\s*\d+$/i.test(lc.name)) tableNames[lc.table] = lc.name;
    if (body.length > MAX_MATCHES * 2) throw new Error(`Schedule too large: ${body.length} rows (max ${MAX_MATCHES} matches)`);
    body.forEach((r, ri) => {
      const time = noteTime(r, ri + hi + 2);
      if (time == null && String(r[timeC] == null ? '' : r[timeC]).trim()) return;
      if (time == null && !(matchC >= 0 && r[matchC])) return;
      for (const u of unknownColumns) if (teamCell(r[u.i])) u.teams++;
      const m = add('r' + ri, time, typeC >= 0 && isPracticeCell(r[typeC]));
      for (const lc of locCols) { const tc = teamCell(r[lc.i]); if (tc) { put(m, lc.table, tc.num, ri + hi + 2); if (tc.name) teamNames[tc.num] = tc.name; } }
    });
  }
  const out = matches.filter(m => Object.keys(m.teams).length);
  out.forEach((m, i) => { m.n = i + 1; delete m._key; });
  if (!out.length) throw new Error('No matches with team numbers found');
  const res = { source: opts.source || 'csv', event: { name: opts.name || 'Uploaded schedule', date: opts.date || null }, teamNames, tableNames, matches: out };
  if (dropped.length) res.dropped = dropped.slice(0, 200);
  const unknown = unknownColumns.filter(c => c.teams > 0).map(({ column, teams }) => ({ column, teams }));
  if (unknown.length) res.unknownColumns = unknown;
  if (problems.length) res.problems = problems.slice(0, 200);
  return res;
}

// Spreadsheet apps treat a cell starting with = + - @ (or tab / CR) as a formula: such cells get a leading apostrophe (see
// guardFormula), and cells with a comma, quote or line break are quoted. splitRows drops that apostrophe again on import.
function csvCell(v) {
  const s = guardFormula(v == null ? '' : String(v));
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function fmtWhen(t) {
  if (t == null || !Number.isFinite(+t)) return '';
  const d = new Date(+t), p = n => String(n).padStart(2, '0'), sec = d.getSeconds();
  // Date and seconds used to be dropped, so a re-import landed on "today" at the minute (#28).
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (sec ? ':' + p(sec) : '');
}
function tableHeader(sched, t) {
  const name = sched.tableNames && sched.tableNames[t];
  // Only a name that still means this table ("T1", "Table 1"). "Red" would be an unknown column and drop the teams.
  if (name && tableNumberFromHeader(name) === String(t)) return name;
  return 'Table ' + t;
}
function toCSV(sched) {
  const tables = [...new Set(sched.matches.flatMap(m => Object.keys(m.teams)))].sort((a, b) => a - b);
  const lines = [['Match', 'Time', 'Practice?', ...tables.map(t => tableHeader(sched, t))].map(csvCell).join(',')];
  // Team cells carry the name ("1001 - Name", the form teamCell reads) so export → re-import keeps team names.
  const names = sched.teamNames || {};
  // A line break inside a name (including U+2028 / U+2029) would split the row or the team number on re-import (#52).
  const oneLine = s => String(s).replace(/(?:\r\n|[\n\r\u2028\u2029])+/g, ' ');
  const team = n => n == null || n === '' ? '' : names[n] ? n + ' - ' + oneLine(names[n]) : n;
  for (const m of sched.matches) lines.push([m.n, fmtWhen(m.time), m.practice ? 'TRUE' : 'FALSE', ...tables.map(t => team(m.teams[t]))].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// ---------- pairs / layout ----------
const DEFAULT_LAYOUT = { pairs: [{ id: 'A', tables: ['1', '2'] }, { id: 'B', tables: ['3', '4'] }, { id: 'C', tables: ['5', '6'] }] };
function pairsFor(match, layout) {
  if (!match) return [];
  const t = Object.keys(match.teams);
  return (layout || DEFAULT_LAYOUT).pairs.filter(p => p.tables.some(x => t.includes(String(x)))).map(p => p.id);
}

module.exports = { MAX_MATCHES, MAX_CSV_BYTES, guardFormula, unquoteFormula, csvCell, parseNexusRef, fromNexus, fetchNexus, parseCSV, parseTime, toCSV, pairsFor, DEFAULT_LAYOUT, NEXUS_DB };
