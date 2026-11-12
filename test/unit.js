// Unit tests for schedule import + pair mapping (no browser needed): node test/unit.js
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const S = require('../lib/schedule');
const fx = n => require('./fixtures/' + n);
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log('  ✓', name); };
const hm = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

const nexus = S.fromNexus(fx('wipws-sessions.json'), fx('wipws-config.json'), fx('wipws-teams.json'), { key: 'wipws' });
t('Nexus wipws: 42 matches, 5-min spacing from session.time (Nexus dynamicTime rule)', () => {
  assert.strictEqual(nexus.matches.length, 42);
  for (let i = 1; i < 42; i++) assert.strictEqual(nexus.matches[i].time - nexus.matches[i - 1].time, 300000);
  assert.strictEqual(nexus.matches[0].time, 1793453400000);
});
t('Nexus wipws: tables and teams match the public page', () => {
  assert.deepStrictEqual(nexus.matches[0].teams, { 1: '77354', 2: '38663', 3: '54448', 4: '74194' });
  assert.deepStrictEqual(nexus.matches[1].teams, { 5: '72268', 6: '60861' });
  assert.deepStrictEqual(nexus.matches[41].teams, { 5: '40007', 6: '55696' });
  assert.strictEqual(nexus.teamNames['938'], 'Elemental Robots');
});
t('Pairs derived from tables: A+B then C, alternating, for all 42 matches', () => {
  nexus.matches.forEach((m, i) => assert.deepStrictEqual(S.pairsFor(m, S.DEFAULT_LAYOUT), i % 2 ? ['C'] : ['A', 'B']));
});
t('Custom layout changes mapping (no hard-coded alternation)', () => {
  const L = { pairs: [{ id: 'X', tables: ['1', '2', '3', '4'] }, { id: 'Y', tables: ['5', '6'] }] };
  assert.deepStrictEqual(S.pairsFor(nexus.matches[0], L), ['X']);
  assert.deepStrictEqual(S.pairsFor({ teams: { 2: '1', 5: '2' } }, S.DEFAULT_LAYOUT), ['A', 'C']);
});
t('CSV round trip (wide format, Match + Time + Table N)', () => {
  const csv = S.toCSV(nexus);
  const p = S.parseCSV(csv, { date: '2026-10-31' });
  assert.strictEqual(p.matches.length, 42);
  p.matches.forEach((m, i) => { assert.deepStrictEqual(m.teams, nexus.matches[i].teams); assert.strictEqual(hm(m.time), hm(nexus.matches[i].time)); });
});
t('Pasted Nexus page table (tab-separated, AM/PM, "Robot game" heading)', () => {
  const txt = 'Robot game\nTime\tTable 1\tTable 2\tTable 3\tTable 4\tTable 5\tTable 6\n9:30 AM\t77354\t38663\t54448\t74194\t\t\n9:35 AM\t\t\t\t\t72268\t60861\n12:55 PM\t\t\t\t\t40007\t55696\n';
  const p = S.parseCSV(txt, { date: '2026-10-31' });
  assert.strictEqual(p.matches.length, 3);
  assert.deepStrictEqual(p.matches[1].teams, { 5: '72268', 6: '60861' });
  assert.strictEqual(hm(p.matches[2].time), 12 * 60 + 55);
});
t('Long format (one row per team) with team names and practice rounds', () => {
  const txt = 'Match,Type,Time,Table,Team\n1,Practice,09:00,Table 1,938 - Elemental Robots\n1,Practice,09:00,Table 2,2596\n2,Ranking,9:05 AM,Table 5,"44199"\n2,Ranking,9:05 AM,Table 6,40007\n';
  const p = S.parseCSV(txt, { date: '2026-11-14' });
  assert.strictEqual(p.matches.length, 2);
  assert.ok(p.matches[0].practice); assert.ok(!p.matches[1].practice);
  assert.deepStrictEqual(p.matches[0].teams, { 1: '938', 2: '2596' });
  assert.strictEqual(p.teamNames['938'], 'Elemental Robots');
  assert.strictEqual(new Date(p.matches[1].time).getDate(), 14);
});
t('Semicolon CSV: Table N, T2 and a bare number are tables', () => {
  const p = S.parseCSV('Start;Table 1;T2\n10:00;11;12\n', {});
  assert.deepStrictEqual(p.matches[0].teams, { 1: '11', 2: '12' });
  assert.strictEqual(p.tableNames['2'], 'T2');
  assert.deepStrictEqual(S.parseCSV('Time,1,2\n10:00,11,12\n').matches[0].teams, { 1: '11', 2: '12' });
});
t('Nexus link parsing', () => {
  assert.deepStrictEqual(S.parseNexusRef('https://fll.nexus/fll/mm26'), { region: 'fll', event: 'mm26' });
  assert.deepStrictEqual(S.parseNexusRef('https://fll.nexus/region/wisconsin/event/wipws/schedule'), { region: 'wisconsin', event: 'wipws' });
  assert.deepStrictEqual(S.parseNexusRef('mm26'), { region: null, event: 'mm26' });
});
t('Bad CSV gives a clear error', () => { assert.throws(() => S.parseCSV('foo,bar\n1,2'), /Time/); });
t('Mustang Madness export: Practice? TRUE/FALSE, AM/PM, tables 1-4 or 5-6, lunch 11:55 AM to 1:00 PM', () => {
  const txt = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'mustang-madness-example-schedule.csv'), 'utf8');
  const p = S.parseCSV(txt, { date: '2026-11-14', name: 'Mustang Madness' });
  assert.strictEqual(p.dropped, undefined);
  assert.strictEqual(p.matches.length, 6);
  assert.deepStrictEqual(p.matches.map(m => m.practice), [true, true, false, false, false, false]);
  assert.deepStrictEqual(p.matches.map(m => hm(m.time)), [10 * 60 + 30, 10 * 60 + 35, 10 * 60 + 40, 11 * 60 + 55, 13 * 60, 13 * 60 + 5]);
  assert.strictEqual(p.matches[4].time - p.matches[3].time, 65 * 60 * 1000);
  assert.deepStrictEqual(p.matches.map(m => m.teams), [
    { 1: '9101', 2: '9102', 3: '9103', 4: '9104' },
    { 5: '9205', 6: '9206' },
    { 1: '9301', 2: '9302', 3: '9303', 4: '9304' },
    { 5: '9405', 6: '9406' },
    { 1: '9501', 2: '9502', 3: '9503', 4: '9504' },
    { 5: '9605', 6: '9606' },
  ]);
  const teams = new Set(p.matches.flatMap(m => Object.values(m.teams)));
  assert.ok(!teams.has('TRUE') && !teams.has('FALSE') && !teams.has(''));
  p.matches.forEach((m, i) => assert.deepStrictEqual(S.pairsFor(m, S.DEFAULT_LAYOUT), i % 2 ? ['C'] : ['A', 'B']));
  assert.strictEqual(new Date(p.matches[4].time).getDate(), 14);
  const yes = S.parseCSV('Time,Practice?,Table 1\n8:45 AM,Yes,100\n8:50 AM,No,200\n', { date: '2026-11-14' });
  assert.strictEqual(yes.matches[0].practice, true);
  assert.strictEqual(yes.matches[1].practice, false);
  assert.deepStrictEqual(yes.matches[0].teams, { 1: '100' });
});
t('Sample 6-table schedule: 24 matches, names, 5-min spacing with breaks, A+B / C alternation', () => {
  const txt = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sample-schedule-6tables.csv'), 'utf8');
  const p = S.parseCSV(txt, { date: '2026-11-14' });
  assert.strictEqual(p.matches.length, 24);
  assert.strictEqual(hm(p.matches[0].time), 9 * 60 + 30);
  assert.deepStrictEqual(p.matches[0].teams, { 1: '32778', 2: '27469', 3: '87440', 4: '66894' });
  assert.strictEqual(p.teamNames['32778'], 'Servo Stars');
  assert.strictEqual(hm(p.matches[8].time) - hm(p.matches[7].time), 15);      // 10:05 -> 10:20 gap
  assert.strictEqual(hm(p.matches[16].time) - hm(p.matches[15].time), 50);    // lunch 10:55 -> 11:45
  p.matches.forEach((m, i) => assert.deepStrictEqual(S.pairsFor(m, S.DEFAULT_LAYOUT), i % 2 ? ['C'] : ['A', 'B']));
});
t('CSV export: cells are quoted for spreadsheets and import back unchanged', () => {
  const p = S.parseCSV('Match,Time,Table 1,Table 2,Table 3\n1,9:30 AM,=A1 - One,"+2, Two",@x - Three\n2,9:35 AM,-4 - Four,"Say ""hi""",5555\n');
  const out = S.toCSV(p), cells = out.split('\n').slice(1).join(',');
  assert.ok(!/(^|,)"?[=+\-@]/.test(cells), out);
  assert.deepStrictEqual(S.parseCSV(out).matches.map(m => m.teams), p.matches.map(m => m.teams));
});
t('CSV import lists teams that two real table headers share', () => {
  const p = S.parseCSV('Match,Time,Table 1,Table 2,T2\n1,9:30,111,222,333\n');
  assert.deepStrictEqual(p.dropped, [{ row: 2, table: '2', team: '222', keptTeam: '333' }]);
  assert.strictEqual(S.parseCSV('Match,Time,Table 1,Table 2\n1,9:30,111,222\n').dropped, undefined);
});
t('wide CSV: blank, Red, and Unnamed: 2 columns warn and do not move teams (#27)', () => {
  const txt = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'mustang-madness-example-schedule.csv'), 'utf8');
  const ok = S.parseCSV(txt, { date: '2026-11-14' });
  assert.strictEqual(ok.unknownColumns, undefined);
  assert.strictEqual(ok.dropped, undefined);
  assert.strictEqual(ok.matches.length, 6);
  const p = S.parseCSV('Time,Practice?,Table 1,Red,Table 2,Table 5,Table 6\n10:30 AM,FALSE,111,222,333,,\n10:35 AM,TRUE,,,,9205,9206\n');
  assert.deepStrictEqual(p.matches[0].teams, { 1: '111', 2: '333' });
  assert.deepStrictEqual(p.matches[1].teams, { 5: '9205', 6: '9206' });
  assert.strictEqual(p.matches[1].practice, true);
  assert.deepStrictEqual(p.unknownColumns, [{ column: 'Red', teams: 1 }]);
  assert.strictEqual(p.dropped, undefined);
  const blank = S.parseCSV('Time,Table 1,,Table 2\n10:30,111,222,333\n10:35,444,555,666\n');
  assert.deepStrictEqual(blank.matches[0].teams, { 1: '111', 2: '333' });
  assert.deepStrictEqual(blank.unknownColumns, [{ column: '(blank column 3)', teams: 2 }]);
  const unnamed = S.parseCSV('Time,Table 1,Unnamed: 2,Table 2\n10:30,111,222,333\n10:35,444,555,666\n10:40,777,888,999\n');
  assert.deepStrictEqual(unnamed.matches[0].teams, { 1: '111', 2: '333' });
  assert.deepStrictEqual(unnamed.matches.map(m => m.teams['2']), ['333', '666', '999']);
  assert.deepStrictEqual(unnamed.unknownColumns, [{ column: 'Unnamed: 2', teams: 3 }]);
  assert.strictEqual(unnamed.dropped, undefined);
  assert.ok(!unnamed.matches.some(m => Object.values(m.teams).includes('222')));
});
const ODD_NAMES = ['=HYPERLINK("x")', '+1', '-x', '@x', "'quoted", "''double", 'Servo Stars', 'Bolts, Nuts & "Gears"', 'Robôts 🤖 ñandú 机器人', '<img onerror=x>'];
t('Formula guard: guardFormula / unquoteFormula are exact inverses', () => {
  for (const n of [...ODD_NAMES, '\tTab', '\rCR', "'", "'=", '', 'plain']) {
    assert.strictEqual(S.unquoteFormula(S.guardFormula(n)), n, JSON.stringify(n));
    assert.strictEqual(/^[=+\-@\t\r']/.test(n), S.guardFormula(n) === "'" + n, 'prefix only when the first char is = + - @ tab CR or apostrophe');
  }
  assert.strictEqual(S.guardFormula('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.strictEqual(S.guardFormula("'quoted"), "''quoted");
  assert.strictEqual(S.guardFormula("''double"), "'''double");
  assert.strictEqual(S.guardFormula('Servo Stars'), 'Servo Stars');
  assert.strictEqual(S.unquoteFormula("'plain"), "'plain");          // apostrophe not followed by a guarded char stays
  assert.strictEqual(S.unquoteFormula("''x"), "'x");                 // strips exactly one
  assert.strictEqual(S.csvCell('Bolts, "Gears"'), '"Bolts, ""Gears"""');
});
t('CSV round trip keeps team names exactly (export → re-import), incl. formula-, quote- and HTML-looking names', () => {
  const rows = ODD_NAMES.map((n, i) => `${i + 1},9:${String(30 + i).padStart(2, '0')} AM,"${1001 + i} - ${n.replace(/"/g, '""')}",${2001 + i}`);
  const p = S.parseCSV('Match,Time,Table 1,Table 2\n' + rows.join('\n') + '\n', { date: '2026-11-14' });
  ODD_NAMES.forEach((n, i) => assert.strictEqual(p.teamNames[String(1001 + i)], n));
  const out = S.toCSV(p);
  assert.ok(out.includes('1001 - =HYPERLINK'), out);                   // names are written, not just numbers
  const q = S.parseCSV(out, { date: '2026-11-14' });
  assert.deepStrictEqual(q.teamNames, p.teamNames);
  assert.deepStrictEqual(q.matches.map(m => m.teams), p.matches.map(m => m.teams));
  assert.strictEqual(q.teamNames['1010'], '<img onerror=x>');          // HTML-looking name survives as text
  assert.deepStrictEqual(S.parseCSV(S.toCSV(q), { date: '2026-11-14' }).teamNames, p.teamNames);   // stable on a second trip
});
t('CSV round trip keeps Nexus and sample-schedule names', () => {
  const used = Object.fromEntries(Object.entries(nexus.teamNames).filter(([n]) => nexus.matches.some(m => Object.values(m.teams).includes(n))));
  assert.deepStrictEqual(S.parseCSV(S.toCSV(nexus), { date: '2026-10-31' }).teamNames, used);
  const txt = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sample-schedule-6tables.csv'), 'utf8');
  const p = S.parseCSV(txt, { date: '2026-11-14' }), q = S.parseCSV(S.toCSV(p), { date: '2026-11-14' });
  assert.deepStrictEqual(q.teamNames, p.teamNames);
  assert.deepStrictEqual(q.matches.map(m => m.teams), p.matches.map(m => m.teams));
});
t('CSV export writes a line break inside a team name as one space, so re-import keeps the team', () => {
  const sched = { teamNames: { '1003': 'Bio\nGlow', '1004': 'Two\r\nLines\rHere', '3101': 'Line\u2028Sep', '3102': 'Para\u2029Sep' }, matches: [
    { n: 1, time: null, teams: { '1': '1003', '2': '1004' } },
    { n: 2, time: null, teams: { '1': '3101', '2': '3102' }, practice: true },
  ] };
  const out = S.toCSV(sched);
  assert.strictEqual(out.split('\n').filter(Boolean).length, 3, out);   // header + two match rows, no raw line break inside a name
  assert.ok(!/[\u2028\u2029]/.test(out), out);
  const q = S.parseCSV(out, { date: '2026-11-14' });
  assert.deepStrictEqual(q.matches.map(m => m.teams), [{ '1': '1003', '2': '1004' }, { '1': '3101', '2': '3102' }]);
  assert.deepStrictEqual(q.teamNames, { '1003': 'Bio Glow', '1004': 'Two Lines Here', '3101': 'Line Sep', '3102': 'Para Sep' });
  assert.strictEqual(q.matches[1].practice, true);
});
t('quoted line breaks in a team cell import as that team, including a blank line inside the quotes (#52)', () => {
  const txt = 'Time,Table 1,Table 2\n10:00 AM,"1003 - Line one\nLine two",2000\n10:05 AM,"3101 - Line\u2028Sep","3102 - Para\u2029Sep"\n10:10 AM,"1004 - Line one\n\nLine two",2001\n';
  const p = S.parseCSV(txt, { date: '2026-11-14' });
  assert.strictEqual(p.problems, undefined);
  assert.deepStrictEqual(p.matches.map(m => m.teams), [
    { '1': '1003', '2': '2000' },
    { '1': '3101', '2': '3102' },
    { '1': '1004', '2': '2001' },
  ]);
  assert.strictEqual(p.teamNames['1003'], 'Line one Line two');
  assert.strictEqual(p.teamNames['3101'], 'Line Sep');
  assert.strictEqual(p.teamNames['3102'], 'Para Sep');
  assert.strictEqual(p.teamNames['1004'], 'Line one Line two');
});
t('parseTime rejects impossible clocks and an invalid date, and keeps Mustang AM/PM (#28)', () => {
  assert.strictEqual(S.parseTime('25:99', '2026-11-14'), null);
  assert.strictEqual(S.parseTime('13:00 PM', '2026-11-14'), null);
  assert.strictEqual(S.parseTime('9:75', '2026-11-14'), null);
  assert.strictEqual(S.parseTime('10:30:60', '2026-11-14'), null);
  assert.strictEqual(S.parseTime('10:00', '2026-13-40'), null);
  assert.ok(!Number.isNaN(S.parseTime('10:00', '2026-13-40')));
  const am = new Date(S.parseTime('10:30 AM', '2026-11-14'));
  const pm = new Date(S.parseTime('01:00 PM', '2026-11-14'));
  assert.strictEqual(am.getHours() * 60 + am.getMinutes(), 10 * 60 + 30);
  assert.strictEqual(pm.getHours() * 60 + pm.getMinutes(), 13 * 60);
  assert.strictEqual(am.getDate(), 14);
  const sec = new Date(S.parseTime('10:00:15', '2026-11-14'));
  assert.strictEqual(sec.getSeconds(), 15);
});
t('a blank long-format table is not table "" and a bad time is reported (#28)', () => {
  const p = S.parseCSV('Match,Time,Table,Team\n1,10:00,,1003 - Name\n1,10:00,Table 2,2000\n2,25:99,Table 1,3000\n', { date: '2026-11-14' });
  assert.deepStrictEqual(p.matches[0].teams, { '2': '2000' });
  assert.ok(!Object.prototype.hasOwnProperty.call(p.matches[0].teams, ''));
  assert.ok(p.problems.some(x => /1003/.test(x.message) && /no table/.test(x.message)));
  assert.ok(p.problems.some(x => /25:99/.test(x.message)));
  assert.ok(!p.matches.some(m => Object.values(m.teams).includes('3000')));
});
t('CSV export keeps seconds, the date, practice, and a table name that is still a table number (#28)', () => {
  const when = new Date(2026, 10, 14, 10, 0, 15).getTime();
  const sched = {
    event: { date: '2026-11-14' }, teamNames: { '1': 'Alpha' }, tableNames: { '1': 'T1', '2': 'Red' },
    matches: [{ n: 1, time: when, teams: { '1': '1', '2': '2' }, practice: true }],
  };
  const out = S.toCSV(sched);
  assert.ok(out.startsWith('Match,Time,Practice?,'), out);
  assert.ok(out.includes('2026-11-14 10:00:15'), out);
  assert.ok(out.includes('TRUE'), out);
  assert.ok(out.includes('T1'), out);
  assert.ok(!out.includes(',Red'), out);
  const q = S.parseCSV(out, { date: '2026-11-14' });
  assert.strictEqual(q.unknownColumns, undefined);
  assert.strictEqual(q.problems, undefined);
  assert.strictEqual(q.matches[0].practice, true);
  assert.deepStrictEqual(q.matches[0].teams, { '1': '1', '2': '2' });
  assert.strictEqual(q.teamNames['1'], 'Alpha');
  assert.strictEqual(q.tableNames['1'], 'T1');
  assert.strictEqual(new Date(q.matches[0].time).getSeconds(), 15);
  assert.strictEqual(new Date(q.matches[0].time).getDate(), 14);
});
t('Nexus import does not concatenate a string time, accept [] as a time, or turn an object into [object Object] (#28)', () => {
  const step = 150000 + 450000;
  const s = S.fromNexus(
    { a: { time: '1000', teams: { '1': '10' } }, b: { teams: { '1': '11' } } },
    { duration: 150000, resetDuration: 450000, count: 1, maxConcurrentCount: 1 }, {}, {});
  assert.strictEqual(s.matches[0].time, 1000);
  assert.strictEqual(s.matches[1].time, 1000 + step);
  assert.strictEqual(typeof s.matches[1].time, 'number');
  const badDur = S.fromNexus(
    { a: { time: 1000, teams: { '1': '10' } }, b: { teams: { '1': '11' } } },
    { duration: 'nope', resetDuration: 0, count: 1, maxConcurrentCount: 1 }, {}, {});
  assert.ok(badDur.matches.every(m => Number.isFinite(m.time)));
  assert.strictEqual(badDur.matches[1].time - badDur.matches[0].time, step);
  const obj = S.fromNexus({ a: { time: 1000, teams: { '1': { name: 'X' }, '2': '22' } } }, {}, {}, {});
  assert.deepStrictEqual(obj.matches[0].teams, { '2': '22' });
  assert.ok(obj.problems.some(p => /not a team number/.test(p.message)));
  const arr = S.fromNexus(
    { a: { time: [], teams: { '1': '10' } }, b: { time: 5000, teams: { '1': '11' } } },
    { duration: 150000, resetDuration: 450000, count: 1, maxConcurrentCount: 1 }, {}, {});
  assert.strictEqual(arr.matches[0].time, null);
  assert.strictEqual(arr.matches[1].time, 5000);
  assert.ok(arr.problems.some(p => /time is not a number/.test(p.message)));
});
t('startup easy-PIN warning covers repeated digits and ascending or descending runs of any length (#53)', () => {
  const server = path.join(__dirname, '..', 'server.js');
  const warn = pin => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-pin-'));
    const r = spawnSync(process.execPath, [server, '--port', '0', '--pin', pin, '--data', dir], { encoding: 'utf8', timeout: 500 });
    fs.rmSync(dir, { recursive: true, force: true });
    return /easy to guess/.test((r.stdout || '') + (r.stderr || ''));
  };
  for (const pin of ['1234', '0000', '1111', '4321', '12345', '123456', '00000', '987654', '0123456789']) assert.strictEqual(warn(pin), true, pin);
  for (const pin of ['918273', '2468', '13579', '123']) assert.strictEqual(warn(pin), false, pin);
});
console.log(`\n${pass} unit tests passed`);
