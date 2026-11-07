# Fire TV + Mac Remote (free)

Phone site: https://web-woad-eight-46.vercel.app — talks to a bridge running on your Mac.

## One-time setup

1. **Fire TV:** Settings → My Fire TV → Developer Options → ADB debugging **ON**.
   (No Developer Options? Settings → My Fire TV → About → click the device name 7 times.)
2. **Mac:** `brew install android-platform-tools cloudflared` (already installed here), then in this folder `bun install`.
3. **Start the bridge at login (always on):** `bridge/install-autostart.sh`. Undo: `bridge/install-autostart.sh remove`.
4. **Allow the TV prompt:** when the TV shows "Allow USB debugging?", tick "Always allow" and press OK.
5. **Pair the phone:** `tail logs/bridge.log`, open the last `https://web-woad-eight-46.vercel.app/#b=...&t=...` link on your phone (or scan the QR if you ran `bun start` in a terminal). Then Share → Add to Home Screen.
6. **Alerts:** install the free **ntfy** app → + → topic = the line `Alerts: subscribe to ntfy topic ...` in `logs/bridge.log` (also in `.ntfy-topic`). Server: default ntfy.sh. Never use a short or guessable topic — anyone can read it.
7. **Wake a PC (optional):** Computer tab → enter the PC's MAC address → Save. The PC needs Wake-on-LAN enabled in BIOS/OS settings and must be on the same WiFi as the Mac.

## Daily use

- **TV tab:** D-pad, volume, app launchers, typing.
- **PC tab:** wake PC, keep Mac awake, lock, sleep, volume, arrows, type text, open apps.
- **Health tab:** CPU / memory / disk / battery, your LaunchAgent services (start ▶ restart ↻ stop ■), top processes (kill). Refreshes every 10 s.
- **Alerts** (to your phone via ntfy): CPU or memory > 90% for 3 min, disk > 90%, battery < 20% unplugged, a keep-alive service dies. A "recovered" message follows. 30-min cooldown per alert.

## Things to know

- The free Cloudflare quick-tunnel URL **changes whenever the bridge restarts**. Re-open the newest link from `logs/bridge.log`.
- The bridge only runs when the Mac is awake and online. Use "Keep this Mac awake".
- Port is 8788 (8787 is used by other projects). LAN page without a tunnel: `http://<mac-ip>:8788` (TV tab only; PC/Health need the token from the pairing link).
- Secrets stay local and are git-ignored: `.pc-token` (phone access), `.ntfy-topic` (alerts), `pc.json` (PC MAC). Delete `.pc-token` and restart to rotate the token, then re-pair.
- Thresholds: add `"th": {"cpu":80,"mem":85,"disk":90,"batt":25}` to `pc.json`, then restart the bridge.
- Redeploy the site after editing `web/`: `cd web && vercel deploy --prod`.

## Troubleshooting

- "bridge unreachable" → stale tunnel link; get the newest one from the log.
- "bad token" → re-open the pairing link.
- TV not connecting → check `logs/bridge.log` for "Allow debugging" and accept it on the TV; TV and Mac must be on the same WiFi.
- Restart bridge: `launchctl kickstart -k gui/$UID/com.firetv.bridge`.
