// Unit tests for schedule import + pair mapping (no browser needed): node test/unit.js
const assert = require('assert');
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
t('Semicolon CSV with custom location names', () => {
  const p = S.parseCSV('Start;Red 1;Red 2\n10:00;11;12\n', {});
  assert.deepStrictEqual(p.matches[0].teams, { 1: '11', 2: '12' });
  assert.strictEqual(p.tableNames['1'], 'Red 1');
});
t('Nexus link parsing', () => {
  assert.deepStrictEqual(S.parseNexusRef('https://fll.nexus/fll/mm26'), { region: 'fll', event: 'mm26' });
  assert.deepStrictEqual(S.parseNexusRef('https://fll.nexus/region/wisconsin/event/wipws/schedule'), { region: 'wisconsin', event: 'wipws' });
  assert.deepStrictEqual(S.parseNexusRef('mm26'), { region: null, event: 'mm26' });
});
t('Bad CSV gives a clear error', () => { assert.throws(() => S.parseCSV('foo,bar\n1,2'), /Time/); });
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
t('CSV import lists teams that two columns put on the same table', () => {
  const p = S.parseCSV('Match,Time,Table 1,Red,Table 2\n1,9:30,111,222,333\n');
  assert.deepStrictEqual(p.dropped, [{ row: 2, table: '2', team: '222', keptTeam: '333' }]);
  assert.strictEqual(S.parseCSV('Match,Time,Table 1,Table 2\n1,9:30,111,222\n').dropped, undefined);
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
  const sched = { teamNames: { '1003': 'Bio\nGlow', '1004': 'Two\r\nLines\rHere' }, matches: [{ n: 1, time: null, teams: { '1': '1003', '2': '1004' } }] };
  const out = S.toCSV(sched);
  assert.strictEqual(out.split('\n').filter(Boolean).length, 2, out);   // header + one match row
  const q = S.parseCSV(out, { date: '2026-11-14' });
  assert.deepStrictEqual(q.matches.map(m => m.teams), [{ '1': '1003', '2': '1004' }]);
  assert.deepStrictEqual(q.teamNames, { '1003': 'Bio Glow', '1004': 'Two Lines Here' });
});
console.log(`\n${pass} unit tests passed`);
