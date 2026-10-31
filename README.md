# FLL Synced Match Timer

One **Head Referee** device starts, pauses and resets a match timer that shows on **every screen** around the
competition area, all on the same second. It knows the **match schedule** (from FLL Nexus or a CSV): the projector
shows the match, teams and how far ahead or behind you are, and each table-pair screen shows its own match timer
or, while another pair plays, the teams that are **up next** on its tables.

- Zero dependencies: just Node.js 18+ (`node server.js`). No CDN assets. Everything works offline except the optional Nexus fetch.
- Works in iPhone Safari, Android Chrome, and desktop browsers.

## Run it

```bash
cd fll-timer
npm start -- --pin 2468          # port 8080, control page locked with PIN 2468
npm start -- --port 80 --pin 2468
# or: PORT=8080 PIN=2468 node server.js      (--data DIR / DATA_DIR = where state + uploaded sounds are saved, default ./data)
# screens normally use the laptop's IP address; if they use a DNS name (other than a short LAN name or *.local), add  --allow-host timer.example.org
```

The console prints the LAN addresses, for example:

```
  [Wi-Fi]
    Head Ref control:  http://192.168.8.20:8080/control
    Main projector:    http://192.168.8.20:8080/display?role=main
    Pair screens:      http://192.168.8.20:8080/display?pair=A   (B, C …)
    Queuing screen:    http://192.168.8.20:8080/display?role=queue
    Table referees:    http://192.168.8.20:8080/ref?table=1   (2, 3 …)
```

To try it without a schedule from Nexus, load `public/sample-schedule-6tables.csv` (24 matches from 9:30 AM, tables 1–4 then 5–6, with a gap and a lunch break) from the control page. Use *Shift times* to move it to now.

## Screens (roles)

Open `/display` on any screen and tap a role, or use the direct links / the QR code on the control page.
Then **tap once** to enable sound and keep the screen awake.

| URL | Shows |
|---|---|
| `/display?role=main` | **Projector.** Always the timer, plus match number, the teams on every active table (grouped by pair), ahead/behind, and the match on deck. |
| `/display?pair=A` | **Pair screen** (tables 1 & 2). During its own match: the big timer with its two team numbers. Otherwise: **UP NEXT**, the match number, time and big team numbers per table. It switches to the next match as soon as its match ends ("Match N over" shows for 10 s). |
| `/display?pair=B`, `?pair=C` | Tables 3 & 4, tables 5 & 6 |
| `/display?role=queue` | **Queuing screen** (silent). Big **Next** and **Then** cards (the next two matches: tables, team numbers, team names, scheduled time), a compact **Now playing** line with the live clock (or the field-break countdown), and a **Should be queued** list of the matches after that (2 by default, set on the control page). Shows ahead/behind and updates live. |
| `/display?role=timer` | Plain countdown only (no schedule) |

Pair screens only play sounds for their own matches. The projector plays them for every match. The queuing screen never plays match sounds (▶ test chimes still work).
Without a schedule, every screen is a plain synced timer.

**Table pairs** are set on the control page (default A = 1,2 · B = 3,4 · C = 5,6). The alternation
(A+B together, then C) is *not* hard-coded: each match is assigned to whichever pairs have teams on its tables in the schedule,
so any layout works.

## Head Ref control (`/control`)

- START / PAUSE / RESUME / RESET (clicking the big time digits also starts/pauses), presets (2:30 Match, 2:00, 1:00, 5:00), custom `m:ss`. Keyboard: `Space` start/pause, `R` reset, `←`/`→` previous/next match.
- **Match bar:** current match, its teams, scheduled time, ahead/behind pill, on-deck match, and ◀ ▶ to move between matches.
  Pressing START records the match's **actual start**. When the match runs to 0:00 the schedule **auto-advances** (can be turned off).
  RESET during a match = **abort**: plays the foghorn, clears that match's actual start, and stays on the same match so you can replay it.
- **Ahead/behind** = actual start − scheduled start while a match runs. Between matches it is now − the next match's scheduled time.
  "On schedule" within ±1 min, then "+N min behind" (yellow, red from 5 min) or "N min ahead" (green).
- **Schedule table:** every match with time, pairs, teams per table, actual start and Δ minutes. Click a row to jump to it.
  *Shift times* moves the whole schedule so match N starts at a given clock time (handy if the event starts late, or to rehearse).
  *Download CSV* exports the loaded schedule.
- **Displays table:** every connected screen with its role, latency, a per-screen **volume** slider, **mute** and a ▶ test chime.
- **Sounds & volume:** master slider plus a slider per cue (start, end game, end, abort, 0–200 %), ▶ Test (all screens),
  Here (this device), Upload / ✕ per cue. Settings are saved on the laptop and pushed live to every screen.
- **Field break** (silent, orange timer). See below.
- **Ahead of schedule:** if START would begin a match more than the target (default **2 min**) before its scheduled time, the control page asks
  "You're 4 min ahead of schedule. Start anyway?". Start anyway goes ahead; Cancel leaves the match ready. Resuming a paused match never asks.
- **Nothing fails silently:** the server answers every command. If one is refused (no PIN, "Stop the running timer before changing match",
  "No field break is running", not connected / reconnecting, no reply), a red message appears at the bottom of the control page and it is logged to the console.
- **Sounds play once:** each start / 30 s / end cue belongs to one run of the timer, and each abort has its own id. Screens play an event once,
  when it happens, and never again on match navigation, reconnects or when a screen joins late.
- **Sound pack** (Nature / Classic) and **screen look** (Nature / Plain) toggles. Also the number of "should be queued" rows on the queuing screen.
- State (schedule, current match, actual starts, volumes, per-screen settings, uploaded sounds) survives a server restart.

## Table referees (`/ref`) — READY and Call Head Ref

Each table referee scans **their table's QR code** from the control page's **Table referees** card (iPhone Safari / Android Chrome, no PIN).
The link is `/ref?table=N&k=…`: the key belongs to that table, so a phone can only mark READY or call the Head Ref for its own table.
A link without the key (or an old one) opens read-only and asks the referee to scan again. **Regenerate ref links** on the card makes new keys
(for example between events); phones on the old links are told to rescan. A phone that has signed in to `/control` with the PIN can use any table's page.
`/ref` alone shows a table picker.
The home page (`/`) has a *Table referee (phone)* link with a button per table (for the Head Ref's own phone), and the control page has a **Table referees** card with a QR code + link per table
(tables come from the pairs setting; `/api/tables` lists them).

- **Screen stays on** — after the first tap anywhere, the ref page keeps the phone screen awake (wake lock on https/localhost, otherwise a tiny muted video), and re-arms it when the phone is unlocked or the tab comes back.
- **The ref page** shows the table and pair, the match that uses this table now or next (match number, scheduled time, big team number and name), and the live clock or a countdown to it.
- **READY** — a big toggle for *that table in that match*. The server holds the state, so every screen sees it, and it survives reloads and reconnects. Pair C refs can ready up while A+B are still playing, because marks belong to the match.
  It is locked while the match runs and after it is over.
- **Control** shows ✓ ready / … not ready on each team chip, an *x/y ready* or **✓ All ready** pill for the upcoming match, and a per-table status line in the Table referees card.
- **Audience screens** (projector, *Starting soon*, field-break layout, pair screens' match-ready and Up next) show a green **✓ READY** tag under each ready team, **only before the match starts**.
- **START with tables not ready** asks "Tables 3, 4 aren't ready. Start anyway?" (combined into one question with the *ahead of schedule* check; `Space` asks the same).
  The check only switches on once a ref page has been opened, so events without table refs work as before. Untick *Ask before START if tables aren't ready* to turn it off; *Clear ready marks* resets them.
- **Resets:** tags disappear the moment the match starts. Marks are cleared when the match ends, on abort / RESET, when you move to another match (◀ ▶, row click), and when the schedule is replaced or cleared.
- **Call Head Ref** — the ref taps it (tap again to cancel). Control shows a sticky orange banner "Table 3 is calling the Head Ref" with **On my way ✓** and plays a gentle one-shot
  *Head Ref call* sound (Nature: marimba + thrush whistle + bell · Classic: ding-dong), using the control page's volume and the per-cue slider; it can be replaced by an upload like the other cues.
  Each call has an id, so the sound plays once and never again on reconnect or reload. The ref page shows "Head Ref called…" until acknowledged, then "✓ Head Ref is on the way".
  Calls are **never** sent to audience screens.
  A table that cancels and calls again within 30 s does not chime the projector again until *On my way ✓* is pressed.

## Match schedule

### From FLL Nexus (needs internet on the laptop)
Paste the event link (e.g. `https://fll.nexus/fll/mm26` or `https://fll.nexus/region/wisconsin/event/wipws/schedule`)
and press **Fetch from Nexus**. Tick **auto-refresh** to re-check every minute, which picks up schedule edits. It never refreshes while a match is running,
and keeps your progress and time shift if the match count is unchanged. Short links like `fll/mm26` are resolved to their region automatically.

How it works: the public Nexus pages read their data from Nexus's Firebase Realtime Database
(`https://nexus-fll-prod-default-rtdb.firebaseio.com`), which allows anonymous read access. No account or API key is needed. The server reads
`regions/{region}/events/{event}/games/sessions.json`, `…/games/config.json` and `…/teams.json` (and `regionSummaries.json` for short links), and
works out match times the same way the page does: `step = (duration + reset) / ceil(tables / max concurrent)`. A session with a fixed `time` restarts the clock.
This is the same data anyone sees on the public schedule page, but it is **not a documented API** and Nexus could change it.
That is why CSV import exists, and why the laptop works fine offline once a schedule is loaded. Set `NEXUS_DB` to override the database URL.
Checked against the public sample event `wipws`: 42 matches, 9:30 AM–12:55 PM, matches exactly what its page shows.
Your event **mm26** ("Mustang Madness", Nov 14 2026, Northville HS) resolves (region `fll`). It has no matches published yet. Fetching it now shows "no robot-game matches published yet"; leave auto-refresh on and the schedule loads once it is posted.

### From a file or paste (offline)
Open *Upload or paste a schedule (CSV)* on the control page. Choose a `.csv`/`.tsv`/`.txt` file, or paste text and press *Load*.
Set *Event date* if the file only has times. Accepted (comma, tab or semicolon separated, header row required):

- **Wide** (one row per match): `Match,Time,Table 1,Table 2,…,Table 6`. `Match` is optional, `Time` can be `9:30 AM`, `09:30`, ISO or epoch ms.
  A team cell may be `938` or `938 - Elemental Robots`. Columns after Time/Match are table/location names, in order (any names work).
  See `public/schedule-template.csv`.
- **Long** (one row per team): `Match,Time,Table,Team` (optional `Type`/`Round` column; "practice" rows are labelled Practice N).
- **Copied from the Nexus web page:** select the Robot game schedule table on the public page, copy, and paste it. It's tab-separated wide format.

Nexus's own CSV/Excel export (organizer login) wasn't available to test. If its columns don't load, paste a sample and the parser can be adjusted,
or use the copy-from-page method.

## Field break (running ahead)

A field break is a **silent** countdown in **orange** that shows how long until the next match. It is not a match: no start, 30 s or end sounds, ever.

- **Target: start matches up to [2] min ahead of schedule** is the one setting. A break ends that long before the next match's scheduled time,
  and START asks to confirm if you'd be further ahead than that.
- **End match session ▸** (after a match reaches 0:00): the screens leave 0:00 and move to the next match, and a break counts down to
  *next match's scheduled time − target*. If you're on time or behind, there's nothing to wait for, so the break is skipped and the screens go straight to *Up next*.
  *Advanced:* "Don't bother showing a break shorter than [30] s" (default 30 s).
- **Break until next match** starts the same break by hand (refused, with the reason, if you're on time or behind). **Break m:ss** starts a fixed-length break (e.g. 3:00).
- **End match session automatically** (off by default) does it for you N s (default 5) after each match ends.
- When the break ends (by itself or **END BREAK**), every screen goes to **match-ready**: the projector shows the full 2:30 timer with the match and its teams,
  the pair screens playing that match show the 2:30 timer with their two teams ("Match N · ready"), and the other pair screens keep showing their up-next teams.
  **Matches are still started by the Head Ref.** START during a break ends it and starts the match (with the ahead-of-schedule confirm if needed).
- What the screens show during a break: **projector** = *Up next* with the next match's tables and big team numbers, and an orange strip underneath:
  "Field break · next match in 3:12 · scheduled 10:15 AM"; **pair screens** = *Up next* with their teams plus an orange "FIELD BREAK 3:12 · next match at …" strip;
  **queuing screen** = the break clock in its top line, with the Next/Then cards unchanged.

## Sounds

**Nature pack (default)**: friendly sounds for a kids' event (biodiversity theme), all still easy to tell apart and loud enough for a gym:
start = bright marimba run + bird chirps; 0:30 end game = wind chimes + woodblock; 0:00 end = a three-bell ring played twice with a chord and an ocean-wave swell;
abort = soft descending tones; Head Ref call (control page only) = marimba + thrush whistle + bell. **Classic pack** = the FIRST-style bugle / steam whistle / buzzer / foghorn below. Switch packs on the control page.
The **Nature look** (dark green background with faint leaf sprigs in the corners) can be switched to **Plain** under *Screens*.


FIRST does **not** publish its field sound files for download or reuse. They ship inside FIRST's own field software, and no
openly licensed official copies exist. So this app bundles **no FIRST audio**. Built-in sounds are synthesized live in the browser in the
style of the classic FIRST field cues (Classic pack): a **"charge"** bugle fanfare at start, a **steam-whistle** at 0:30 (end game), a **buzzer** at 0:00, and a **foghorn** on abort.
If your event has the official files (for example from your field kit / FTA / regional partner), upload them per cue on the control page
(mp3, wav, m4a, ogg, webm; max 8 MB). They are stored on the laptop in `data/sounds/` and served to every screen over the LAN.
✕ goes back to the synthesized sound. Use the per-cue sliders (up to 200 %) to even out files that are louder than others.

## How the sync works
- When you press START, the server picks a start moment ~0.6 s in the future (`--lead` ms) in **server time**
  and broadcasts it. Every screen counts down from that same moment, so message delay doesn't matter.
- Each screen measures its clock offset to the server with NTP-style ping/pong over the WebSocket
  (12-ping burst on connect, then every 2 s) and uses the median of the 5 lowest-round-trip samples.
- Screens that join or reconnect mid-match get the current state and show the right time straight away. They never play the start sound late.

## Network setups (Head Ref keeps internet)

The laptop running the server and all displays must be on the **same network**. Pick one:

### A. Router or travel router with an internet uplink (recommended)
Put a small travel router (for example a GL.iNet model; most have a "repeater" mode that uplinks to venue
Wi-Fi, or an Ethernet WAN port) at the field. The laptop, every display and the Head Ref phone join its Wi-Fi.
Everyone is on one LAN **and** the Head Ref phone still has internet through the router. Using your own
router also avoids venue/school Wi-Fi "client isolation", which often blocks device-to-device traffic.

### B. Offline router, Head Ref phone uses cellular for internet
If the router has no internet, join the Head Ref phone to its Wi-Fi anyway. Local addresses like
`http://192.168.8.20:8080` still go over Wi-Fi, while internet traffic can use cellular:
- **iPhone:** when iOS shows "No Internet Connection" under that Wi-Fi, **stay joined**. iOS normally sends internet
  traffic over cellular when the Wi-Fi has no internet. Keeping *Settings → Cellular → Wi-Fi Assist* **on** helps. If iOS drops the Wi-Fi, open *Settings → Wi-Fi →
  (network)* and turn **Auto-Join** on.
- **Android:** when asked "This network has no internet access. Stay connected?", tick **Don't ask again** and
  choose **Yes**. Turn on *Mobile data always active* or *Adaptive/Smart network switch* so internet uses cellular.
- Test before the event: with the phone on the router's Wi-Fi, load the control page **and** a website.

### C. Phone hotspot
The Head Ref phone makes a hotspot, and the laptop and displays join it. The phone keeps cellular internet and is on the same LAN.
Downsides: limited client count (often around 5-10), battery drain, and an iPhone
hotspot can switch off when nothing is connected. Keep the Personal Hotspot screen open while devices join. Fine for a practice table, but A or B is better for an event.

### Give the laptop a fixed address
Displays bookmark the laptop's IP, so make it stable: in the router's admin page, add a **DHCP reservation**
(static lease) for the laptop's MAC address, for example `192.168.8.20`. Also:
- Allow Node.js through the laptop firewall (Windows asks "Allow access?": tick **Private networks**).
- Keep the laptop plugged in, and set sleep to "never" while the event runs.
- Use `--port 80` (may need admin/sudo) so URLs don't need `:8080`.

## Display tips
- Set each device's **Auto-Lock / Screen timeout to Never** and keep it plugged in. The Wake Lock API only works on
  HTTPS or localhost, so on a plain-HTTP LAN the page falls back to a looping muted video. That fallback is best-effort, especially on iOS.
- iPhone/iPad: *Share → Add to Home Screen* opens the display full screen without browser bars.
- Guided Access (iOS) or screen pinning (Android) stops spectators from leaving the page.
- The dot in the corner is green when connected and synced, yellow while syncing, and red while reconnecting. Reconnects are automatic.

## Files
- `server.js`: HTTP + built-in WebSocket server, timer/match state, PIN, Nexus fetch, sound uploads, persistence
- `lib/schedule.js`: Nexus conversion, CSV/paste parsing, pair mapping
- `public/display.html`: all screen roles · `public/control.html`: Head Ref control · `public/ref.html`: table referee phone page · `public/sync.js`: clock sync, schedule helpers, sounds, keep-awake
- `public/vendor/qrcode.js`: QR generator (MIT, Kazuhiko Arase), bundled so it works offline
- `test/`: `unit.js` (schedule parsing), `sync-test.js` (timer sync), `event-test.js` (full event flow, live Nexus), `break-queue-test.js` (queuing screen + field breaks, using `public/sample-schedule-6tables.csv`), `v4-test.js` (one-shot sounds, refused-command messages, ahead confirm, match-ready after a break), `ref-test.js` (table referee page, READY, Call Head Ref). Run with `cd test && npm install && cd .. && npm run test:all` (needs Chrome; set `CHROME=` path). `webkit-click-test.js` holds a real mouse button down for 50–150 ms, 30 times per group, on START/PAUSE, the big time digits (including across a second change), reset / END BREAK, the break-end button, prev/next, the presets, and the ahead-of-schedule Yes/No buttons. Every click must change state as that control should. Every click except Cancel must also add a successful command acknowledgement; Cancel only closes the dialog and leaves the timer idle. Run it with `npm run test:webkit` after `npx --prefix test playwright-core install --with-deps webkit`. It is not part of `npm run test:all`: that suite drives the Chrome already on the machine, and WebKit is a separate browser download plus system libraries. `PWBROWSER=chromium` runs the same clicks in Chrome. `ROUNDS` (default 30) is the click count per group.

## Test results (headless Chrome on one box)
- **Unit:** 11/11, including the 6-table sample CSV (24 matches, 9:30 start, team names, the 10:05→10:20 gap and lunch), covering Nexus wipws conversion (42 matches, 5-min spacing, A+B/C alternation), CSV round trip, pasted page table, long format, links.
- **Sync** (control + 3 timer screens with fake clock errors of +4.0 s / −2.5 s / +0.8 s and 0–120 ms random network delay, plus a late joiner with a −9 s clock):
  offset error ≤ 13 ms, second-boundary spread ≤ 17 ms (one 60 Hz frame), start/30 s/end cues within ≤ 17 ms.
- **Event flow** (control + projector + pairs A, B, C, with the wipws schedule fetched live from Nexus): 30/30 checks.
  These cover the projector/pair views, up-next, ahead/behind, the auto-advance, abort and foghorn behaviour, cue routing per pair, volume push, per-screen mute/volume gains, sound upload (PIN-protected), the PIN lock, and restart persistence.
- **Queuing screen + field breaks** (control + projector + pairs A, B, C + queuing screen, sample 6-table CSV): 37/37 checks. Covers the Next/Then/should-be-queued
  cards, now playing, End match session → break of the right length (target = next match − 2 min), orange digits, **no sounds during breaks**, silent break expiry,
  break-until-next then START (start sound only on the right screens), the behind-schedule skip and refusal, auto end-session, the queue row count, and the pack/look toggles.
- **v4 regression tests** (control + projector + pairs A, C + late-joining screens): 45/45 checks. The abort sound plays exactly once and never again after arrow keys, ◀ ▶,
  other commands, a screen reconnecting, the control page reloading or a screen joining late; start/end cues once per match; START 4 min ahead asks and Cancel / Start anyway work;
  1.5 min ahead starts with no question; break ends 2 min before the match; projector break layout; match-ready after a break (projector, pair A ready, pair C up next, no sounds);
  clicking the big digits and Space with a checkbox focused start the timer; refused commands, disconnected START and a missing PIN all show the reason.
- **Table referees** (`ref-test.js`: control + projector + pairs A, C + 6 phone ref pages at 390×844, iPhone Safari UA): 63/63 checks. Table picker, team/match/time per table,
  READY toggle broadcast and kept across a ref-page reload, refused for other tables and while running, tags on projector / *Starting soon* after a break / pair screens and gone at START,
  marks reset on end, abort and match change, START not-ready confirm (Cancel / Start anyway, combined with ahead, Space), the confirm toggle, Call Head Ref banner + one-shot sound
  (no replay on reload or late join), cancel, acknowledge, ref page cannot use Head Ref commands, and no calls on audience screens.

## WebKit click regression
`npm run test:webkit` runs in Playwright WebKit (CI job `test (Node 22, WebKit)`). It is separate from the Chrome results above and from `npm run test:all`. A local run at the default 30 rounds: 12/12 groups, 0 missed clicks — START, START/PAUSE on the button (30) and on the big digits (30), a digit click held across a second change (15), abort (10), END BREAK on the reset button (10), the break-end button (10), START MATCH during a break (10), next and prev (15 each), presets (30), and the ahead-of-schedule confirm buttons (20). Cancel only closes the dialog, so that click is checked by the dialog closing and the timer staying idle. Every other click must add a successful command acknowledgement and the state change for that button. `PWBROWSER=chromium` runs the same script against Chrome.
