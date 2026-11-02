# Mustang Madness runbook

Nov 14, 2026. Northville HS. One event. Read this on a phone.

## 1. Hallway queue (once)

The hallway screen is `https://queue.kippykiyay.com`, on the owner's Cloudflare domain `kippykiyay.com`. The timer, Head Ref page, and referee pages stay on the gym LAN. cloudflared is the only process that faces the internet.

Install cloudflared on the event laptop:

- macOS: `brew install cloudflared`
- Linux: the `.deb` or `.rpm` from the cloudflared GitHub releases, then install it with `dpkg` or `rpm`.

1. `cloudflared tunnel login`  
   The owner signs in in the browser, on the Cloudflare account that owns `kippykiyay.com`.
2. `cloudflared tunnel create fll-queue`
3. `cloudflared tunnel route dns fll-queue queue.kippykiyay.com`
4. Copy `cloudflared/config.sample.yml` to `cloudflared/config.yml` (that copy is gitignored). Set `tunnel` to the UUID from step 2. Set `credentials-file` to the JSON path cloudflared printed, usually `~/.cloudflared/<uuid>.json`. The sample already sends only `queue.kippykiyay.com` to `http://127.0.0.1:8081`, then a catch-all `http_status:404`.
5. Leave `QUEUE_HOSTNAME` unset. `queue.kippykiyay.com` is the default. Set `QUEUE_HOSTNAME` only if you change the hostname, and put that same name in `cloudflared/config.yml`. If you change `QUEUE_PORT` (default 8081), change the port in that file too.

The tunnel credential stays in cloudflared's own file. That path is the only thing that goes in `config.yml`. Leave the JSON out of the repo, this runbook, and chat.

Test from a phone on cellular (gym Wi-Fi off): `npm run queue`, then `npm run tunnel`, then open `https://queue.kippykiyay.com`. The Head Ref page shows that URL.

**Quick tunnel, if the named tunnel is not set up.** With no `cloudflared/config.yml` and no `CLOUDFLARED_CONFIG`, `npm run tunnel` starts a quick tunnel (`trycloudflare`) to `http://127.0.0.1:8081`. The Head Ref page shows the `https://….trycloudflare.com` URL. That URL is new every run and dies when cloudflared stops. Practice only. Use the named tunnel on Nov 14.

## 2. Before Nov 14

- Travel router for the gym LAN. The timer laptop and every field display join it.
- Phone hotspot as backup internet for the laptop.
- 5-minute tunnel test on the Northville school network. From a phone on cellular, open `https://queue.kippykiyay.com`.
- Real iPhone check: Head Ref at `/control` (your PIN), wake-lock, sound, and the field-display offline badge (`📡 OFFLINE – time may be off`). Table phones use the keyed link from that page, `/ref?table=N&k=…`.
- 10-minute Raspberry Pi Firefox field-display run, including a real network-cable or Wi-Fi pull.

## 3. Event morning

From the repo folder. Choose the PIN at the terminal. Leave it out of this file, the projector, and shared docs.

```bash
npm start -- --pin <pin>
npm run queue
npm run tunnel
```

Or one terminal: `npm run event -- --pin <pin>`.

The field keeps running if the queue or the tunnel stops.

- The phone opens simple mode on its own (narrow screen, up to 760 px). Break setup stays on the laptop.
- On the phone: Lunch, End match session, End break, START, and PAUSE.
- Two tables. Pair A is tables 1 and 2.
- Projector: `/display?role=main`
- Field screens: `/display?pair=A`
- Tap each screen once for sound.
- Hallway: `https://queue.kippykiyay.com`. Gym queue page: `/display?role=queue`.

The laptop prints the LAN addresses at startup (port 8080).

## 4. During the event

**End match session automatically** is off. Leave it off. (That checkbox is on the laptop.)

Before the long gap: tick Lunch, then press End match session. The break runs until 2 minutes before the next match.

End break, and END BREAK on the reset button, cancel the break and leave the next match ready. START starts that match. During a break the phone labels that button START MATCH. Further than 2 minutes early, confirm Start anyway.

**Laptop crash or restart.** Leave the screens and the phone alone. They reconnect once the timer is running. If the process is down, use the morning commands, then leave the screens alone.

- Mid-match: the countdown continues.
- Between matches: you stay on that match.
- During Lunch: Lunch continues. If the laptop was off past the break's end, Lunch is over and the next match is ready.
- If the laptop was off when a match hit 0:00: that match is marked done and the schedule advances. Glance at the match number once.

**Field display drops Wi-Fi and comes back.** It resyncs on its own. Leave the page open. No false END.

**Queue server or cloudflared dies.** Keep running the field. Restart only the one that died: `npm run queue` or `npm run tunnel`. Leave the timer process that is already running. The hallway keeps the last list and shows Last updated.

**Match timer down, queue process still up.** The hallway keeps the last list. Last updated stops advancing and keeps its normal color.

**Phone was locked.** Wait until it says `connected`, then tap. A tap during reconnect can miss. Check the screens, then tap again only if the first tap did not land. Leave the page open.
