// Fire TV remote bridge. Run: bun start  — auto-discovers the TV, auto-opens a tunnel, prints a pairing QR.
import { networkInterfaces } from "node:os";
import { connect as tcp } from "node:net";
import { createSocket } from "node:dgram";
import { connect as sock, type Socket } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { cpus, loadavg, homedir } from "node:os";
import qr from "qrcode-terminal";

// ---- Computer tab: token-protected presets only (no arbitrary shell) ----
const TOKEN_FILE = new URL("../.pc-token", import.meta.url).pathname;
const CFG_FILE = new URL("../pc.json", import.meta.url).pathname;
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(18).toString("hex"), { mode: 0o600 });
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
const cfg: { mac?: string } = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, "utf8")) : {};
let awake: ReturnType<typeof Bun.spawn> | null = null;
const NTFY_FILE = new URL("../.ntfy-topic", import.meta.url).pathname;
if (!existsSync(NTFY_FILE)) writeFileSync(NTFY_FILE, "firetv-" + randomBytes(10).toString("hex"), { mode: 0o600 });
const TOPIC = readFileSync(NTFY_FILE, "utf8").trim();
const LA = `${homedir()}/Library/LaunchAgents`, UID_ = process.getuid!(), SELF = "com.firetv.bridge";
const TH = { cpu: 90, mem: 90, disk: 90, batt: 20, ...((cfg as any).th ?? {}) };
const labels = () => existsSync(LA) ? readdirSync(LA).filter((f) => f.endsWith(".plist") && !f.startsWith("com.apple.")).map((f) => f.slice(0, -6)) : [];

// Reference points: where "fine" turns into "busy" turns into "overloaded", and how long it has been at its current level.
const LEVELS: Record<string, [number, number]> = { cpu: [60, 90], mem: [75, 90], disk: [80, 90] };   // [busy from, overloaded from], in %
const levelOf = (k: string, v: number) => v >= LEVELS[k][1] ? "hot" : v >= LEVELS[k][0] ? "busy" : "ok";
const levelSince = new Map<string, { lvl: string; t: number }>();
const heldMin = (k: string, lvl: string) => { const e = levelSince.get(k); if (!e || e.lvl !== lvl) { levelSince.set(k, { lvl, t: Date.now() }); return 0; } return Math.round((Date.now() - e.t) / 6000) / 10; };
async function health() {
  const n = cpus().length, cpu = Math.round((loadavg()[0] / n) * 100);
  const vm = await run(["vm_stat"]), pg = (k: string) => Number(vm.match(new RegExp(k + ":\\s+(\\d+)"))?.[1] ?? 0);
  const total = (await run(["sysctl", "-n", "hw.memsize"])), tot = Number(total) / 16384;
  const mem = Math.round(((pg("Pages active") + pg("Pages wired down") + pg("Pages occupied by compressor")) / tot) * 100);
  const disk = Number((await run(["df", "-k", "/System/Volumes/Data"])).split("\n")[1]?.match(/(\d+)%/)?.[1] ?? 0);
  const b = await run(["pmset", "-g", "batt"]), bm = b.match(/(\d+)%/);
  const batt = bm ? Number(bm[1]) : null, charging = !/discharging/.test(b);
  const list = await run(["launchctl", "list"]); const rows = new Map(list.split("\n").slice(1).map((l) => { const [pid, st, lb] = l.split("\t"); return [lb, { pid: pid === "-" ? null : Number(pid), exit: Number(st) }] as const; }));
  // uptime per pid, so "running" can mean PROVEN running (alive for 30s+), not just "has a pid right now"
  const et = new Map<number, number>();
  for (const l of (await run(["ps", "-Ao", "pid=,etime="])).split("\n")) { const m = l.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/); if (m) et.set(+m[1], (+(m[2] ?? 0)) * 86400 + (+(m[3] ?? 0)) * 3600 + (+m[4]) * 60 + (+m[5])); }
  const services = labels().map((label) => {
    const loaded = rows.has(label), pid = rows.get(label)?.pid ?? null, exit = rows.get(label)?.exit ?? null, up = pid ? (et.get(pid) ?? 0) : 0;
    const state = pid ? (up >= 30 ? "running" : "starting") : !loaded ? "off" : exit ? "failing" : "idle";
    return { label, loaded, pid, exit, up, state };
  });
  const ps = (await run(["ps", "-U", String(UID_), "-Ao", "pid=,pcpu=,pmem=,comm="])).split("\n").map((l) => { const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/); return m ? { pid: +m[1], cpu: +m[2], mem: +m[3], name: m[4].split("/").pop()! } : null; }).filter(Boolean) as any[];
  const procs = ps.sort((a, b) => b.cpu - a.cpu).slice(0, 8);
  const lv = { cpu: levelOf("cpu", cpu), mem: levelOf("mem", mem), disk: levelOf("disk", disk) };
  const held = { cpu: heldMin("cpu", lv.cpu), mem: heldMin("mem", lv.mem), disk: heldMin("disk", lv.disk) };
  return { cpu, mem, disk, batt, charging, services, procs, managed: await managedState(), pinned: procCfg().pinned, th: TH, topic: TOPIC, load: loadavg().map((x) => Math.round(x * 10) / 10), cores: n, levels: LEVELS, lv, held };
}
const alertState = new Map<string, number>(); const strikes = new Map<string, number>();
// Alert budget: ntfy's free tier allows ~250 messages a day and one message per failing service used it all up.
// Now: services go out as ONE digest, only when the set of failing services changes (at most every 10 min),
// metric alerts repeat every 6h instead of 30 min, and everything stops at DAILY_CAP messages a day.
const DAILY_CAP = 40; let sentToday = 0, sentDay = "";
async function push(title: string, body: string, priority = "default") {
  const day = new Date().toDateString(); if (day !== sentDay) { sentDay = day; sentToday = 0; }
  if (sentToday >= DAILY_CAP) return; sentToday++;
  const extra = sentToday === DAILY_CAP ? "\n(alert limit for today reached; the rest are muted until tomorrow)" : "";
  await fetch("https://ntfy.sh/" + TOPIC, { method: "POST", headers: { Title: title, Priority: priority }, body: body + extra }).catch(() => {});
}
async function notify(key: string, bad: boolean, msg: string) {
  const was = alertState.has(key);
  if (bad && (!was || Date.now() - alertState.get(key)! > 6 * 3600_000)) { alertState.set(key, Date.now()); await push("Mac alert", msg, "high"); }
  else if (!bad && was) { alertState.delete(key); await push("Recovered", msg + " is back to normal"); }
}
let svcFailing = new Set<string>(), svcPrimed = false, lastDigest = 0;
const short = (l: string) => l.replace(/^(com|ai)\./, "");
async function svcDigest(failing: Set<string>) {
  if (!svcPrimed) { svcPrimed = true; svcFailing = failing; return; }   // first look after a restart is the baseline, not news
  const added = [...failing].filter((l) => !svcFailing.has(l)), fixed = [...svcFailing].filter((l) => !failing.has(l));
  if (!added.length && !fixed.length) return;
  if (Date.now() - lastDigest < 10 * 60_000) return;   // keep the change pending; it goes out in the next digest
  const list = (a: string[]) => a.slice(0, 8).map(short).join(", ") + (a.length > 8 ? ` +${a.length - 8} more` : "");
  const parts: string[] = [];
  if (added.length) parts.push(`Down (${added.length}): ${list(added)}`);
  if (fixed.length) parts.push(`Back (${fixed.length}): ${list(fixed)}`);
  parts.push(`${failing.size} failing now`);
  svcFailing = failing; lastDigest = Date.now();
  await push("Services", parts.join("\n"), added.length ? "high" : "default");
}
async function monitor() {
  try {
    const h = await health(); const hot = (k: string, bad: boolean) => { strikes.set(k, bad ? (strikes.get(k) ?? 0) + 1 : 0); return (strikes.get(k) ?? 0) >= 3; };
    await notify("cpu", hot("cpu", h.cpu > TH.cpu), `CPU ${h.cpu}%`);
    await notify("mem", hot("mem", h.mem > TH.mem), `Memory ${h.mem}%`);
    await notify("disk", h.disk > TH.disk, `Disk ${h.disk}% full`);
    await notify("batt", h.batt !== null && !h.charging && h.batt < TH.batt, `Battery ${h.batt}%`);
    await svcDigest(new Set(h.services.filter((sv) => sv.label !== SELF && hot("svc:" + sv.label, sv.state === "failing")).map((sv) => sv.label)));
  } catch (e) { console.error("monitor", e); }
}
setInterval(monitor, 30_000);
const PC_APPS = ["Safari", "Google Chrome", "Spotify", "Terminal", "Finder"];
function wol(mac: string) {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error("bad MAC");
  const m = Buffer.from(hex, "hex"), pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
  const sock = createSocket("udp4");
  sock.bind(() => { sock.setBroadcast(true); sock.send(pkt, 9, "255.255.255.255", () => sock.close()); });
}
const run = async (cmd: string[]) => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }); const o = await new Response(p.stdout).text(); await p.exited; return o.trim(); };
const osa = (script: string) => run(["osascript", "-e", script]);
async function svcOp(l: string, op: string) {
  if (!labels().includes(l)) throw new Error("unknown service");
  if (l === SELF && op !== "restart") throw new Error("won't stop the bridge itself");
  const t = `gui/${UID_}/${l}`;
  if (op === "restart") return { out: await run(["launchctl", "kickstart", "-k", t]) };
  if (op === "stop") return { out: await run(["launchctl", "bootout", t]) };
  if (op === "start") { const o = await run(["launchctl", "bootstrap", `gui/${UID_}`, `${LA}/${l}.plist`]); return { out: o + (await run(["launchctl", "kickstart", t])) }; }
  throw new Error("bad op");
}

// ---- Pinned + managed processes (processes.json). Long-running things that are not launchd services, e.g. live-agent.
// Clients send only an id; the command lines come from this file, never from the request.
type Managed = { id: string; name: string; cwd: string; start: string[]; stop?: string[]; match: string };
const PROCS_FILE = new URL("../processes.json", import.meta.url).pathname;
const procCfg = (): { pinned: string[]; managed: Managed[] } => { try { const j = JSON.parse(readFileSync(PROCS_FILE, "utf8")); return { pinned: j.pinned ?? [], managed: j.managed ?? [] }; } catch { return { pinned: [], managed: [] }; } };
const expand = (p: string) => p.replace(/^~/, homedir());
async function managedState() {
  const out = [];
  for (const m of procCfg().managed) {
    const pids = (await run(["pgrep", "-f", m.match])).split("\n").map(Number).filter((n) => n && n !== process.pid);
    let up = 0; if (pids[0]) { const e = (await run(["ps", "-o", "etime=", "-p", String(pids[0])])).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/); if (e) up = (+(e[1] ?? 0)) * 86400 + (+(e[2] ?? 0)) * 3600 + (+e[3]) * 60 + (+e[4]); }
    out.push({ id: m.id, name: m.name, state: pids.length ? (up >= 30 ? "running" : "starting") : "stopped", up });
  }
  return out;
}
async function procOp(id: string, op: string) {
  const m = procCfg().managed.find((x) => x.id === id); if (!m) throw new Error("unknown process");
  const job = "firetv.proc." + m.id;
  const stop = async () => { if (m.stop) await run(["/bin/sh", "-c", `cd ${JSON.stringify(expand(m.cwd))} && ${m.stop.map((x) => JSON.stringify(x)).join(" ")}`]); await run(["launchctl", "remove", job]); };
  const start = async () => {
    const log = `${new URL("../logs/", import.meta.url).pathname}proc-${m.id}.log`;
    // launchctl submit runs it outside the bridge's own process tree, so restarting the bridge does not kill it
    await run(["launchctl", "submit", "-l", job, "-o", log, "-e", log, "--", "/bin/sh", "-c", `cd ${JSON.stringify(expand(m.cwd))} && exec ${m.start.map((a) => JSON.stringify(a)).join(" ")}`]);
  };
  if (op === "stop") { await stop(); return { ok: true }; }
  if (op === "start") { if ((await managedState()).find((x) => x.id === id)?.state !== "stopped") return { ok: true, already: true }; await start(); return { ok: true }; }
  if (op === "restart") { await stop(); await Bun.sleep(800); await start(); return { ok: true }; }
  throw new Error("bad op");
}
async function pc(action: string, b: Record<string, string>) {
  switch (action) {
    case "status": return { awake: !!awake, mac: cfg.mac ?? null, apps: PC_APPS };
    case "config": { if (b.mac) wol(b.mac); cfg.mac = b.mac; writeFileSync(CFG_FILE, JSON.stringify(cfg)); return { mac: cfg.mac }; }
    case "wake": if (!cfg.mac) throw new Error("set the computer's MAC first"); wol(cfg.mac); return { sent: cfg.mac };
    case "health": return await health();
    case "svc": return await svcOp(String(b.label), String(b.op));
    case "proc": return await procOp(String(b.id), String(b.op));
    case "svcs": {   // a whole group at once
      const ls = (Array.isArray((b as any).labels) ? (b as any).labels : []).map(String).slice(0, 80);
      const out: Record<string, string> = {};
      for (const l of ls) { try { await svcOp(l, String(b.op)); out[l] = "ok"; } catch (e: any) { out[l] = String(e?.message ?? e); } }
      return { results: out };
    }
    case "kill": { const pid = Number(b.pid); const mine = (await run(["ps", "-U", String(UID_), "-o", "pid="])).split("\n").map(Number); if (!mine.includes(pid) || pid === process.pid) throw new Error("not allowed"); const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 15 && alive(); i++) await Bun.sleep(100);      // give it 1.5s to exit politely
      let forced = false; if (alive()) { process.kill(pid, "SIGKILL"); forced = true; for (let i = 0; i < 5 && alive(); i++) await Bun.sleep(100); }
      return { gone: !alive(), forced }; }
    case "testalert": await push("Test", "Alerts work"); return {};
    case "keepawake":
      if (awake) { awake.kill(); awake = null; } else awake = Bun.spawn(["caffeinate", "-dims"]);
      return { awake: !!awake };
    case "lock": await run(["pmset", "displaysleepnow"]); return {};
    case "sleep": await run(["pmset", "sleepnow"]); return {};
    case "vol": return { out: await osa(b.dir === "up" ? "set volume output volume ((output volume of (get volume settings)) + 8)" : b.dir === "down" ? "set volume output volume ((output volume of (get volume settings)) - 8)" : "set volume output muted not (output muted of (get volume settings))") };
    case "open": if (!PC_APPS.includes(b.app)) throw new Error("app not allowed"); await run(["open", "-a", b.app]); return {};
    case "type": return { out: await osa(`tell application "System Events" to keystroke "${String(b.text ?? "").replace(/[\\"]/g, "")}"`) };
    case "key": { const codes: Record<string, number> = { enter: 36, esc: 53, tab: 48, space: 49, up: 126, down: 125, left: 123, right: 124 }; if (!(b.key in codes)) throw new Error("bad key"); return { out: await osa(`tell application "System Events" to key code ${codes[b.key]}`) }; }
    default: throw new Error("unknown action");
  }
}


// ---- Screen tab: mirror the Mac to the phone and take touch input. Tailscale/localhost ONLY, never through the public tunnel. ----
const tailnetOnly = (req: Request) => {
  if (req.headers.get("cf-connecting-ip") || req.headers.get("cf-ray")) return false;   // arrived through the cloudflare tunnel
  const h = new URL(req.url).hostname;
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h === "localhost" || h === "127.0.0.1";
};
let dims: [number, number] | null = null;
async function dispSize(): Promise<[number, number]> {
  if (!dims) { const o = await run(["osascript", "-l", "JavaScript", "-e", 'ObjC.import("AppKit");const f=$.NSScreen.screens.objectAtIndex(0).frame;f.size.width+","+f.size.height']); const [w, h] = o.split(",").map(Number); dims = [w || 1440, h || 900]; }
  return dims;
}
const n = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) || 0));
const jxa = (body: string) => run(["osascript", "-l", "JavaScript", "-e", `ObjC.import("CoreGraphics");const P=(t,x,y,b,c)=>{const e=$.CGEventCreateMouseEvent(null,t,$.CGPointMake(x,y),b);if(c)$.CGEventSetIntegerValueField(e,1,c);$.CGEventPost($.kCGHIDEventTap,e)};${body}`]);
async function screen(action: string, req: Request): Promise<Response> {
  const [W, H] = await dispSize();
  if (action === "screen") {
    const raw = "/tmp/firetv-screen.png", out = "/tmp/firetv-screen.jpg";
    await run(["rm", "-f", raw, out]);   // never serve a stale frame if the capture fails
    await run(["screencapture", "-x", "-C", "-t", "png", raw]);
    await run(["sips", "-Z", "1100", "-s", "format", "jpeg", "-s", "formatOptions", "45", raw, "--out", out]);
    const f = Bun.file(out); if (!(await f.exists()) || f.size === 0) return json({ error: "no screenshot — allow Screen Recording for the bridge in System Settings > Privacy & Security" }, 500);
    return new Response(f, { headers: { ...cors, "content-type": "image/jpeg", "cache-control": "no-store" } });
  }
  if (action === "inputcheck") {   // can this process post clicks? (needs the Accessibility permission; without it taps silently do nothing)
    const ask = new URL(req.url).searchParams.get("prompt") === "1";   // ?prompt=1 makes macOS show its own "allow control" prompt and adds the entry to the list
    const o = await run(["osascript", "-l", "JavaScript", "-e", ask ? 'ObjC.import("ApplicationServices");$.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt:true}))' : 'ObjC.import("ApplicationServices");$.AXIsProcessTrusted()']);
    return json({ accessibility: o.trim() === "true" });
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (action === "tap") {
    const x = n(b.fx, 0, 1) * W, y = n(b.fy, 0, 1) * H, kind = String(b.kind);
    if (kind === "right") await jxa(`P(3,${x},${y},1,1);P(4,${x},${y},1,1)`);
    else if (kind === "double") await jxa(`P(1,${x},${y},0,1);P(2,${x},${y},0,1);P(1,${x},${y},0,2);P(2,${x},${y},0,2)`);
    else await jxa(`P(1,${x},${y},0,1);P(2,${x},${y},0,1)`);
    return json({ ok: true });
  }
  if (action === "drag") {
    const x1 = n(b.x1, 0, 1) * W, y1 = n(b.y1, 0, 1) * H, x2 = n(b.x2, 0, 1) * W, y2 = n(b.y2, 0, 1) * H;
    await jxa(`P(5,${x1},${y1},0);P(1,${x1},${y1},0,1);for(let i=1;i<=12;i++)P(6,${x1}+(${x2}-${x1})*i/12,${y1}+(${y2}-${y1})*i/12,0);P(2,${x2},${y2},0,1)`);
    return json({ ok: true });
  }
  if (action === "scroll") {
    const dy = Math.round(n(b.dy, -2000, 2000)), dx = Math.round(n(b.dx, -2000, 2000));
    await jxa(`$.CGEventPost($.kCGHIDEventTap,$.CGEventCreateScrollWheelEvent(null,0,2,${dy},${dx}))`);
    return json({ ok: true });
  }
  return json({ error: "unknown" }, 404);
}

let lastScreenLog = 0;
const PORT = Number(process.env.PORT ?? 8788);
const SITE = process.env.SITE_URL ?? "https://web-woad-eight-46.vercel.app";
const KEYS: Record<string, number> = {
  UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23, BACK: 4, HOME: 3, MENU: 82,
  NOOP: 0, PLAYPAUSE: 85, REWIND: 89, FF: 90, NEXT: 87, PREV: 88,
  VOLUP: 24, VOLDOWN: 25, MUTE: 164, POWER: 26, SLEEP: 223, WAKE: 224,
};
const APPS: Record<string, string> = {
  netflix: "com.netflix.ninja", youtube: "com.amazon.firetv.youtube",
  prime: "com.amazon.avod", disney: "com.disney.disneyplus",
  hulu: "com.hulu.plus", spotify: "com.spotify.tv.android",
};
const cors = {
  "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type,x-token",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Private-Network": "true",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...cors, "content-type": "application/json" } });

async function adb(args: string[]) {
  const p = Bun.spawn(["adb", ...args], { stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return (o + e).trim();
}

// ---- TV discovery: scan local /24 for open :5555, adb connect, keep alive ----
let tv: string | null = process.env.TV_IP ?? null;
let tvOk = false;
const open5555 = (ip: string) => new Promise<boolean>((res) => {
  const s = tcp({ host: ip, port: 5555, timeout: 600 });
  s.on("connect", () => { s.destroy(); res(true); });
  s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); });
});
function subnets() {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && !i.address.startsWith("100.")) out.push(i.address.split(".").slice(0, 3).join("."));
  return out;
}
// every host in each interface's real subnet (e.g. a /22 spans 4 x /24), capped at 1024
function scanHosts(): string[] {
  const hosts = new Set<string>();
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || i.address.startsWith("100.")) continue;
      const ip = i.address.split(".").reduce((a, o) => a * 256 + Number(o), 0), mask = i.netmask.split(".").reduce((a, o) => a * 256 + Number(o), 0);
      const net = (ip & mask) >>> 0, size = Math.min(1024, (~mask >>> 0) + 1);
      for (let n = 1; n < size - 1; n++) { const v = net + n; hosts.add([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".")); }
    }
  return [...hosts];
}
async function check() {
  if (tv) {
    const r = await adb(["connect", `${tv}:5555`]);
    const state = await adb(["-s", `${tv}:5555`, "get-state"]);
    tvOk = /device/.test(state) && !/unauthorized|offline/.test(state);
    if (!tvOk) { if (/unauthorized/.test(state + r)) console.log("TV is asking to Allow debugging — accept it on screen."); if (!process.env.TV_IP) tv = null; }
    return;
  }
  const hits = (await Promise.all(scanHosts().map(async (h) => ((await open5555(h)) ? h : null)))).filter(Boolean) as string[];
  if (hits.length) { tv = hits[0]; console.log(`Found Fire TV at ${tv}`); return check(); }
}
(async function loop() { try { await check(); } catch (e) { console.error(e); } setTimeout(loop, tvOk ? 8000 : 4000); })();


// ---- Fast key path ----
// `adb shell input keyevent` boots a Java VM per press (1.6-2.3 s on this Fire TV). Instead we keep ONE persistent
// `monkey --port` server running on the TV and push key presses over a socket (~60 ms).
let mode: "fast" | "slow" = "slow", fastSock: Socket | null = null, fastPort = 0, fastBusy: Promise<unknown> = Promise.resolve();
let bench: Record<string, unknown> = {};
const dev = () => `${tv}:5555`;
// monkey exits when its client disconnects, so every (re)connect starts a fresh server and proves it answers before we trust it.
async function startFast(): Promise<boolean> {
  try {
    fastSock?.destroy(); fastSock = null;
    await adb(["-s", dev(), "shell", "ps -A | grep com.android.commands.monkey | awk '{print $2}' | xargs kill"]);
    Bun.spawn(["adb", "-s", dev(), "shell", "nohup monkey --port 1080 </dev/null >/dev/null 2>&1 &"], { stdout: "ignore", stderr: "ignore" });
    fastPort = Number((await adb(["-s", dev(), "forward", "tcp:0", "tcp:1080"])).trim());
    if (!fastPort) return false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 900));
      const c = sock(fastPort, "127.0.0.1"); c.setNoDelay(true);
      const ok = await new Promise<boolean>((res) => {
        let buf = ""; const t = setTimeout(() => res(false), 4000);
        c.on("error", () => { clearTimeout(t); res(false); });
        c.on("data", (d) => { buf += d; if (buf.includes("\n")) { clearTimeout(t); res(buf.startsWith("OK")); } });
        c.on("connect", () => c.write("press 0\n"));
      });
      if (ok) { fastSock = c; c.on("error", () => { fastSock = null; }); c.on("close", () => { fastSock = null; }); return true; }
      c.destroy();
    }
    return false;
  } catch { return false; }
}
function fastCmd(c: string, timeout = 3000): Promise<string> {
  const run1 = () => new Promise<string>((res, rej) => {
    const s2 = fastSock; if (!s2) return rej(new Error("no socket"));
    let buf = ""; const t = setTimeout(() => { s2.off("data", on); rej(new Error("timeout")); }, timeout);
    const on = (d: Buffer) => { buf += d; if (buf.includes("\n")) { clearTimeout(t); s2.off("data", on); res(buf.trim()); } };
    s2.on("data", on); s2.write(c + "\n");
  });
  const p = fastBusy.then(run1, run1); fastBusy = p.catch(() => {}); return p;   // serialize: one reply per command
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function timeIt(f: () => Promise<unknown>) { const t = performance.now(); await f(); return performance.now() - t; }
// Automatic latency test: measures both paths, picks the faster, records the result. KEYCODE_UNKNOWN (0) does nothing on the TV.
async function runBench() {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  const slow: number[] = []; for (let i = 0; i < 3; i++) slow.push(await timeIt(() => adb(["-s", dev(), "shell", "input", "keyevent", "0"])));
  out.slowMedianMs = Math.round(median(slow));
  if (fastSock || (await startFast())) {
    for (let attempt = 0; attempt < 3; attempt++) {   // the first presses after monkey boots are slow (JIT) - warm up, re-measure
      for (let i = 0; i < 3; i++) await fastCmd("press 0", 10000).catch(() => {});
      const fast: number[] = []; for (let i = 0; i < 10; i++) fast.push(await timeIt(() => fastCmd("press 0", 2000)).catch(() => 9999));
      out.fastMedianMs = Math.round(median(fast)); out.fastMaxMs = Math.round(Math.max(...fast)); out.attempts = attempt + 1;
      if ((out.fastMedianMs as number) < 400) break;
      // monkey serves one client at a time and can hold a stale one: restart it on the TV and reconnect
      await adb(["-s", dev(), "shell", "ps -A | grep com.android.commands.monkey | awk '{print $2}' | xargs kill"]);
      await new Promise((r) => setTimeout(r, 1500)); await startFast();
    }
  }
  mode = typeof out.fastMedianMs === "number" && out.fastMedianMs < 400 && (out.fastMedianMs as number) < (out.slowMedianMs as number) ? "fast" : "slow";
  out.mode = mode; bench = out; console.log("latency test:", JSON.stringify(out));
  return out;
}
async function pressKey(code: number) {
  if (mode === "fast") { try { const r = await fastCmd(`press ${code}`); if (r.startsWith("OK")) return r; } catch {} if (await startFast()) { try { return await fastCmd(`press ${code}`); } catch {} } mode = "slow"; }
  return adb(["-s", dev(), "shell", "input", "keyevent", String(code)]);
}
// Keep-warm: WiFi radios doze when idle (ping to the TV: ~67 ms avg at 1 pkt/s vs ~19 ms at 10 pkt/s). While a remote page is active,
// poke the TV 10x/s so its radio stays awake and the next key press doesn't pay the wake-up cost.
let lastActive = 0; const warm = createSocket("udp4");
setInterval(() => { if (tv && Date.now() - lastActive < 5000) warm.send("w", 9, tv, () => {}); }, 100);
let benched = "";
setInterval(() => { if (tvOk && tv && benched !== tv) { benched = tv; runBench().catch(() => { benched = ""; }); } if (!tvOk) benched = ""; }, 3000);
setInterval(() => { if (tvOk && mode === "slow") benched = ""; }, 45_000);   // fast path failed earlier: try again
const sh = (...cmd: string[]) => adb(["-s", `${tv}:5555`, "shell", ...cmd]);

Bun.serve({
  idleTimeout: 60,   // /bench runs ~15 s
  port: PORT, hostname: "0.0.0.0",
  websocket: {   // key presses over one open socket: no HTTP handshake/headers per press
    message(ws, msg) {
      try { const { k, id, p } = JSON.parse(String(msg));
        lastActive = Date.now(); if (p) return void ws.send("p"); const code = KEYS[String(k).toUpperCase()];
        if (code !== undefined && tv && tvOk) pressKey(code).then(() => ws.send(JSON.stringify({ id, ok: 1 })), () => ws.send(JSON.stringify({ id, ok: 0 })));
        else ws.send(JSON.stringify({ id, ok: 0 })); } catch {}
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && server.upgrade(req)) return undefined as any;
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/" || url.pathname === "/index.html")
        return new Response(Bun.file(new URL("../web/index.html", import.meta.url)), { headers: { "content-type": "text/html" } });
      if (url.pathname.startsWith("/pc/")) {
        if (req.headers.get("x-token") !== TOKEN) return json({ error: "bad token — re-scan the pairing QR" }, 401);
        if (/^\/pc\/(screen|tap|drag|scroll|inputcheck)$/.test(url.pathname)) {
          if (!tailnetOnly(req)) return json({ error: "screen control only works over Tailscale, not the public link" }, 403);
          const res = await screen(url.pathname.slice(4), req);
          if (res.status !== 200 || url.pathname !== "/pc/screen" || Date.now() - lastScreenLog > 30000) { lastScreenLog = Date.now(); console.log(`[screen] ${url.pathname} ${res.status} host=${url.hostname} ua=${(req.headers.get("user-agent") ?? "").slice(0, 50)}`); }
          return res;
        }
        const b = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string>) : {};
        return json(await pc(url.pathname.slice(4), b));
      }
      if (url.pathname === "/health") return json({ ok: true, tv, tvConnected: tvOk, mode });
      if (url.pathname === "/bench") return json(req.method === "POST" || !bench.mode ? await runBench() : bench);
      if (url.pathname === "/rescan") {   // forget the TV and look for it again right now
        if (!process.env.TV_IP) tv = null; tvOk = false; await check();
        return json({ ok: true, tv, tvConnected: tvOk });
      }
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      if (!tv || !tvOk) return json({ error: "tv not connected", tv }, 503);
      const b = (await req.json().catch(() => ({}))) as Record<string, string>;
      if (url.pathname === "/key") {
        const code = KEYS[String(b.key).toUpperCase()];
        if (!code) return json({ error: "unknown key" }, 400);
        return json({ result: await pressKey(code), mode });
      }
      if (url.pathname === "/launch") {
        const pkg = APPS[String(b.app)];
        if (!pkg) return json({ error: "unknown app" }, 400);
        return json({ result: await sh("monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1") });
      }
      if (url.pathname === "/text") {
        const t = String(b.text ?? "").replace(/[^A-Za-z0-9 .,@_-]/g, "").replace(/ /g, "%s");
        return json({ result: await sh("input", "text", t) });
      }
      return json({ error: "not found" }, 404);
    } catch (e) { return json({ error: String(e) }, 500); }
  },
});

// ---- Tunnel (so the https site on your phone can reach this bridge) ----
function pair(link: string) { console.log(`\nScan with your phone (one time):\n${link}\n`); qr.generate(link, { small: true }); }
const lan = subnets()[0] ? Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address : null;
console.log(`Bridge on :${PORT}${lan ? `  (LAN page: http://${lan}:${PORT})` : ""}`);
if (!process.env.NO_TUNNEL) {
  let t: ReturnType<typeof Bun.spawn> | null = null, url = "", fails = 0;
  const start = () => {
    t = Bun.spawn(["cloudflared", "tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], { stdout: "ignore", stderr: "pipe" });
    const mine = t; url = ""; fails = 0;
    (async () => {
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of mine.stderr as any) {
        buf += dec.decode(chunk);
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !url) {
          url = m[0]; pair(`${SITE}/#b=${url}&t=${TOKEN}`); console.log(`Alerts: subscribe to ntfy topic ${TOPIC}`);
          // Phone notification: tap to re-point the site at the new address. Address only, never the token
          // (the phone already stores the token from first pairing).
          fetch("https://ntfy.sh/" + TOPIC, { method: "POST", headers: { Title: "Remote ready - tap to reconnect", Click: `${SITE}/#b=${url}` }, body: "Bridge has a new address." }).catch(() => {});
        }
      }
    })();
  };
  start();
  // watchdog: free quick tunnels die; if ours stops answering, replace it
  setInterval(async () => {
    if (!url) return;
    const ok = await fetch(url + "/health", { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    fails = ok ? 0 : fails + 1;
    if (fails >= 3) { console.log("tunnel dead, restarting"); t?.kill(); start(); }
  }, 30_000);
  process.on("exit", () => t?.kill());
  process.on("SIGINT", () => { t?.kill(); process.exit(0); });
}
