# Fire TV Universal Remote — Plan

## Context
Goal: a phone-friendly remote for the Fire TV (later: any device on the same WiFi), hosted on Vercel.

**Hard constraint:** a website on Vercel cannot talk to a Fire TV directly. Fire TV is controlled over ADB (TCP 5555) on the LAN; browsers can't open raw TCP, and an HTTPS page can't call a plain-HTTP LAN address (mixed content). So we need a tiny **local bridge** on the same WiFi.

## Architecture
1. **Vercel site (Next.js, App Router)** — the remote UI (PWA, installable on phone home screen): D-pad, OK, Back, Home, Menu, Play/Pause, Rew/FF, Vol +/-/Mute, Power, app launchers (Netflix, YouTube, Prime, Disney+, Hulu), text-send keyboard. Also a Setup page with the bridge install steps + a device list/"add device" screen (designed for multiple device types: Fire TV now, Roku/Android TV/Chromecast adapters later).
2. **Local bridge (Bun + TypeScript, ~100 lines)** — runs on the user's Mac (or any always-on box on the WiFi). Endpoints: `GET /devices` (scan LAN), `POST /key {device,key}`, `POST /launch`, `POST /text`. Uses `adb` (`adb connect <ip>:5555`, `adb shell input keyevent <code>`). Adapter interface so other devices plug in later.
3. **Connection:** bridge exposes HTTPS via `localhost` (Chrome allows) for desktop, and via a Cloudflare quick tunnel (`cloudflared tunnel`) URL for phone → the Vercel page stores the bridge URL in localStorage. Fallback: bridge also serves the same UI at `http://<mac-ip>:8787` so phone works with zero tunnel.

## Files (new, in /Users/taboost/Fire_Tv)
- `web/` — Next.js app (`app/page.tsx` remote, `app/setup/page.tsx`, `app/manifest.ts`, components `Remote.tsx`, `DevicePicker.tsx`)
- `bridge/server.ts`, `bridge/adapters/firetv.ts`, `bridge/adapters/types.ts`
- `README.md` — 3-step setup

## One-time user steps (can't be automated)
- Fire TV: Settings → My Fire TV → Developer Options → turn on **ADB debugging** (enable Developer Options by tapping About → device name 7×); accept the "Allow debugging" prompt on TV once.
- Mac: `brew install android-platform-tools` and run `bun bridge/server.ts`.

## Deploy
Vercel MCP connector (`mcp__plugin_vercel_vercel`, needs auth) / `vercel deploy --prod` from `web/`. Dev branch → preview first per dev-branch workflow if repo uses it; this repo is new so deploy straight to production.

## Verification
- `bun bridge/server.ts` + `curl -X POST localhost:8787/key -d '{"key":"HOME"}'` → TV goes Home (real device check; needs TV on).
- Open deployed URL with Interceptor: UI renders, no console errors, buttons call bridge and return 200.
- Phone test: open link on phone on same WiFi, press D-pad, TV responds.
- If TV is unavailable, I'll say so explicitly rather than claim it works.
