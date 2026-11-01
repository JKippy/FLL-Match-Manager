// Head Ref simple mode for phones (#63): narrow screens default to it, the per-device choice survives a reload,
// the essentials stay visible (START/PAUSE/RESET, match + on deck, field break, READY chips, START-anyway prompt,
// Call Head Ref banner) and everything else is hidden. Wide screens keep the full page.   node test/simple-mode-test.js
//   PWBROWSER=webkit|firefox node test/simple-mode-test.js   (default: Chrome via CHROME= or /usr/bin/google-chrome)
const pw = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const PIN = '4321';
const BROWSER = process.env.PWBROWSER || 'chromium';
const SAMPLE = path.join(__dirname, '..', 'public', 'sample-schedule-6tables.csv');
const { SHOTS } = require('./shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
function check(name, ok, detail) { ok ? passed++ : failed++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
// Firefox has no isMobile emulation; the narrow viewport is what matters for the default.
const PHONE = Object.assign({ viewport: { width: 390, height: 844 }, hasTouch: true },
  BROWSER === 'firefox' ? {} : { deviceScaleFactor: 2, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
const LAPTOP = { viewport: { width: 1366, height: 900 } };
const ESSENTIAL = ['modeBtn', 'time', 'status', 'startBtn', 'resetBtn', 'matchPanel', 'mTitle', 'mTeams', 'mOnDeck', 'prevBtn', 'nextBtn', 'endSession', 'breakNext', 'breakLen', 'breakCustom'];
const EXTRA = ['presets', 'customTime', 'brkAhead', 'brkAuto', 'brkMin', 'autoAdv', 'clients', 'nexusUrl', 'schedTable', 'volGrid', 'refGrid', 'refRegen', 'pairsEd', 'qr'];
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const PORT = await freePort(), BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fll-simple-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(PORT), '--pin', PIN, '--data', DATA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { srv.stdout.on('data', d => { if (/Control/.test(d)) res(); }); setTimeout(() => rej(new Error('server start timeout')), 8000); });
  const browser = BROWSER === 'chromium'
    ? await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] })
    : await pw[BROWSER].launch();
  console.log('browser:', BROWSER);
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(120); } return false; };
  // A context per device: localStorage is per device, like a real phone. The PIN is pre-saved so no unlock step.
  async function device(opts, url = '/control') {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(pin => { try { if (location.pathname === '/control') localStorage.setItem('fll.pin', pin); } catch (e) {}
      // Record the mode at first parse, so a phone never flashes the full page before switching.
      document.addEventListener('DOMContentLoaded', () => { window.__simpleAtLoad = document.documentElement.classList.contains('simple'); }); }, PIN);
    const p = await ctx.newPage();
    p.on('pageerror', e => { console.log('PAGE ERROR', e.message); failed++; });
    p.on('console', m => { if (m.type() === 'error' && /Content Security Policy|CSP/i.test(m.text())) { console.log('CSP', m.text()); failed++; } });
    p.on('dialog', d => d.accept());
    await p.goto(BASE + url); return p;
  }
  const simple = p => p.evaluate(() => document.documentElement.classList.contains('simple'));
  const shown = (p, ids) => p.evaluate(ids => ids.filter(id => { const e = document.getElementById(id); return e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }), ids);
  const ready = p => waitFor(() => p.evaluate(() => !!(FLL.state && FLL.authed)));
  try {
    // ---------- wide screen: full page, unchanged ----------
    const lap = await device(LAPTOP); await ready(lap);
    await lap.evaluate(t => FLL.cmd('scheduleCSV', { text: t, date: null, name: 'Sample' }), fs.readFileSync(SAMPLE, 'utf8'));
    await waitFor(() => lap.evaluate(() => FLL.schedule && FLL.schedule.matches.length === 24));
    await lap.evaluate(() => FLL.cmd('scheduleShift', { index: 0, time: Date.now() + 30000 }));
    check('laptop (1366 px): full page by default', !(await simple(lap)) && (await lap.evaluate(() => window.__simpleAtLoad)) === false);
    const lapExtra = await shown(lap, EXTRA);
    check('laptop: every extra control is visible', lapExtra.length === EXTRA.length, EXTRA.filter(x => !lapExtra.includes(x)));
    check('laptop: toggle offers "Simple mode"', (await lap.textContent('#modeBtn')) === 'Simple mode');

    // ---------- phone: simple by default ----------
    const ph = await device(PHONE); await ready(ph);
    check('phone (390 px): simple mode by default, already at first parse (no flash of the full page)', (await simple(ph)) && (await ph.evaluate(() => window.__simpleAtLoad)) === true);
    await waitFor(async () => (await shown(ph, ['matchPanel'])).length === 1);
    const ess = await shown(ph, ESSENTIAL), ext = await shown(ph, EXTRA);
    check('phone simple: essentials visible (start/pause/reset, match + on deck, prev/next, field break)', ess.length === ESSENTIAL.length, ESSENTIAL.filter(x => !ess.includes(x)));
    check('phone simple: extra controls hidden', ext.length === 0, ext);
    check('phone simple: Lunch checkbox (#62) visible in the field-break box', (await shown(ph, ['brkLunch'])).length === 1);
    check('phone simple: visible toggle "Show all controls", aria-pressed=true', await ph.evaluate(() => { const b = document.getElementById('modeBtn'); return b.textContent === 'Show all controls' && b.getAttribute('aria-pressed') === 'true'; }));
    check('phone simple: no sideways scrolling', await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), await ph.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    check('phone simple: no saved choice yet (default follows the screen)', (await ph.evaluate(() => localStorage.getItem('fll.simple'))) === null);

    // ---------- READY chips + START-anyway prompt + START / PAUSE / RESET in simple mode ----------
    const refUrl = await (async () => { await waitFor(() => lap.evaluate(() => !!(FLL.refKeys || {})['1'])); return lap.evaluate(() => document.querySelector('#refGrid .rc[data-table="1"] a').href); })();
    const ref = await device(PHONE, (u => u.pathname + u.search)(new URL(refUrl))); await sleep(1200);
    await ref.click('#readyBtn'); await sleep(700);
    await waitFor(() => ph.evaluate(() => /1\/4 ready/.test(document.getElementById('mReady').textContent)));
    check('phone simple: READY pill + chips for the tables in the match', await ph.evaluate(() => {
      const c = t => document.querySelector(`#mTeams .chip[data-table="${t}"]`).className, pill = document.getElementById('mReady');
      return /rdy/.test(c(1)) && /wait/.test(c(2)) && pill.textContent === '1/4 ready' && !!pill.offsetWidth;
    }));
    // START/PAUSE must not move when the match starts (document position, so a page scroll doesn't count).
    const btnTop = p => p.evaluate(() => { const r = document.getElementById('startBtn').getBoundingClientRect(); return Math.round((r.top + window.scrollY) * 10) / 10; });
    const top0 = { phone: await btnTop(ph), laptop: await btnTop(lap) };
    await ph.click('#startBtn'); await sleep(500);
    const modal = await ph.evaluate(() => { const m = document.getElementById('confirmModal'); return m.classList.contains('hidden') ? null : document.getElementById('confirmMsg').textContent; });
    check("phone simple: START with tables not ready still asks 'Start anyway?'", !!modal && /aren't ready\. Start anyway\?/.test(modal) && (await lap.evaluate(() => FLL.state.status)) === 'idle', modal);
    await ph.screenshot({ path: path.join(SHOTS, 'v6_control_simple_phone_confirm.png') });
    await ph.click('#confirmYes'); await sleep(900);
    check('phone simple: "Start anyway" runs the match', (await ph.evaluate(() => FLL.state.status)) === 'running');
    await sleep(1200);   // past "starting…": status, "started" time, chips without ready labels
    const top1 = { phone: await btnTop(ph), laptop: await btnTop(lap) };
    check('START/PAUSE button top unchanged by START: 390 px phone (simple) and 1366 px laptop (full)', top0.phone === top1.phone && top0.laptop === top1.laptop,
      { before: top0, after: top1, sched: await ph.textContent('#mSched') });
    await ph.click('#startBtn'); await sleep(700);
    check('phone simple: PAUSE', (await ph.evaluate(() => FLL.state.status)) === 'paused' && (await ph.textContent('#startBtn')) === 'RESUME');
    await ph.click('#resetBtn'); await sleep(700);
    check('phone simple: RESET (abort) after a confirm', (await ph.evaluate(() => FLL.state.status)) === 'idle');

    // ---------- field break ----------
    await ph.fill('#breakLen', '5:00'); await ph.click('#breakCustom'); await sleep(600);
    check('phone simple: start a field break; END BREAK visible', (await ph.evaluate(() => FLL.isBreak())) && (await shown(ph, ['breakEndBtn'])).length === 1);
    await ph.click('#breakEndBtn'); await sleep(600);
    check('phone simple: end the break', !(await ph.evaluate(() => FLL.isBreak())));

    // ---------- Call Head Ref ----------
    await ref.click('#callBtn'); await sleep(800);
    check('phone simple: Call Head Ref banner shows', /Table 1 is calling the Head Ref/.test(await ph.evaluate(() => document.getElementById('callBanner').innerText)));
    await ph.screenshot({ path: path.join(SHOTS, 'v6_control_simple_phone_call.png') });
    await ph.click('#callBanner button[data-ack="1"]'); await sleep(600);
    check('phone simple: "On my way ✓" acknowledges', (await ph.evaluate(() => document.getElementById('callBanner').children.length)) === 0);

    // ---------- toggle + persistence ----------
    await ph.click('#modeBtn'); await sleep(200);
    const extOn = await shown(ph, EXTRA);
    check('phone: toggle off shows every control', !(await simple(ph)) && extOn.length === EXTRA.length, EXTRA.filter(x => !extOn.includes(x)));
    check('phone: choice saved on this device', (await ph.evaluate(() => localStorage.getItem('fll.simple'))) === '0');
    await ph.reload(); await ready(ph);
    check('phone: full page survives a reload', !(await simple(ph)) && (await ph.evaluate(() => window.__simpleAtLoad)) === false && (await ph.textContent('#modeBtn')) === 'Simple mode');
    await ph.click('#modeBtn'); await ph.reload(); await ready(ph);
    check('phone: simple mode back on, survives a reload', (await simple(ph)) && (await ph.evaluate(() => localStorage.getItem('fll.simple'))) === '1' && (await shown(ph, EXTRA)).length === 0);
    await ph.screenshot({ path: path.join(SHOTS, 'v6_control_simple_phone.png') });

    // ---------- per device: the laptop is not affected; a laptop can opt in ----------
    await lap.reload(); await ready(lap);
    check('laptop unaffected by the phone\'s choice', !(await simple(lap)));
    await lap.click('#modeBtn'); await lap.reload(); await ready(lap);
    check('laptop: simple mode chosen, survives a reload', await simple(lap) && (await shown(lap, EXTRA)).length === 0 && (await shown(lap, ['startBtn', 'endSession'])).length === 2);
    await lap.click('#modeBtn'); await sleep(200);
    check('laptop: back to the full page', !(await simple(lap)) && (await lap.evaluate(() => localStorage.getItem('fll.simple'))) === '0');

    // ---------- storage blocked (private mode / storage off): no errors, PIN prompt, simple by default, toggle works ----------
    const ctx = await browser.newContext(PHONE);
    await ctx.addInitScript(() => { const bad = () => { throw new Error('SecurityError'); }; try { Object.defineProperty(window, 'localStorage', { get: bad }); } catch (e) {} });
    const nostore = await ctx.newPage(); const errs = []; nostore.on('pageerror', e => errs.push(e.message)); nostore.on('dialog', d => d.accept());
    await nostore.goto(BASE + '/control');
    await waitFor(() => nostore.evaluate(() => !document.getElementById('pinModal').classList.contains('hidden')));
    check('storage blocked: page loads without errors and asks for the PIN', errs.length === 0 && (await nostore.isVisible('#pinInput')), errs);
    check('storage blocked: phone defaults to simple mode', await simple(nostore));
    await nostore.fill('#pinInput', PIN); await nostore.click('#pinBtn');
    await waitFor(() => nostore.evaluate(() => FLL.authed && document.getElementById('pinModal').classList.contains('hidden')));
    check('storage blocked: PIN unlocks (nothing saved, no error)', (await nostore.evaluate(() => FLL.authed)) && errs.length === 0, errs);
    await nostore.click('#modeBtn'); await sleep(200);
    const offNs = !(await simple(nostore)) && (await shown(nostore, EXTRA)).length === EXTRA.length;
    await nostore.click('#modeBtn'); await sleep(200);
    check('storage blocked: toggle still works within the session', offNs && (await simple(nostore)) && (await shown(nostore, EXTRA)).length === 0 && errs.length === 0, errs);
    await ctx.close();
  } catch (e) { console.log('TEST CRASH', e); failed++; }
  finally {
    await browser.close(); srv.kill();
    console.log(`\n${passed} passed, ${failed} failed`); console.log(failed ? 'FAIL' : 'PASS');
    process.exit(failed ? 1 : 0);
  }
})();
