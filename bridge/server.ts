// Fire TV remote bridge. Run: bun start  — auto-discovers the TV, auto-opens a tunnel, prints a pairing QR.
import { networkInterfaces } from "node:os";
import { connect as tcp } from "node:net";
import { createSocket } from "node:dgram";
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
async function health() {
  const n = cpus().length, cpu = Math.round((loadavg()[0] / n) * 100);
  const vm = await run(["vm_stat"]), pg = (k: string) => Number(vm.match(new RegExp(k + ":\\s+(\\d+)"))?.[1] ?? 0);
  const total = (await run(["sysctl", "-n", "hw.memsize"])), tot = Number(total) / 16384;
  const mem = Math.round(((pg("Pages active") + pg("Pages wired down") + pg("Pages occupied by compressor")) / tot) * 100);
  const disk = Number((await run(["df", "-k", "/System/Volumes/Data"])).split("\n")[1]?.match(/(\d+)%/)?.[1] ?? 0);
  const b = await run(["pmset", "-g", "batt"]), bm = b.match(/(\d+)%/);
  const batt = bm ? Number(bm[1]) : null, charging = !/discharging/.test(b);
  const list = await run(["launchctl", "list"]); const rows = new Map(list.split("\n").slice(1).map((l) => { const [pid, st, lb] = l.split("\t"); return [lb, { pid: pid === "-" ? null : Number(pid), exit: Number(st) }] as const; }));
  const services = labels().map((label) => ({ label, loaded: rows.has(label), pid: rows.get(label)?.pid ?? null, exit: rows.get(label)?.exit ?? null }));
  const ps = (await run(["ps", "-U", String(UID_), "-Ao", "pid=,pcpu=,pmem=,comm="])).split("\n").map((l) => { const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/); return m ? { pid: +m[1], cpu: +m[2], mem: +m[3], name: m[4].split("/").pop()! } : null; }).filter(Boolean) as any[];
  const procs = ps.sort((a, b) => b.cpu - a.cpu).slice(0, 8);
  return { cpu, mem, disk, batt, charging, services, procs, th: TH, topic: TOPIC };
}
const alertState = new Map<string, number>(); const strikes = new Map<string, number>();
async function notify(key: string, bad: boolean, msg: string) {
  const was = alertState.has(key);
  if (bad && (!was || Date.now() - alertState.get(key)! > 30 * 60_000)) { alertState.set(key, Date.now()); await fetch("https://ntfy.sh/" + TOPIC, { method: "POST", headers: { Title: "Mac alert", Priority: "high" }, body: msg }).catch(() => {}); }
  else if (!bad && was) { alertState.delete(key); await fetch("https://ntfy.sh/" + TOPIC, { method: "POST", headers: { Title: "Recovered" }, body: msg + " is back to normal" }).catch(() => {}); }
}
async function monitor() {
  try {
    const h = await health(); const hot = (k: string, bad: boolean) => { strikes.set(k, bad ? (strikes.get(k) ?? 0) + 1 : 0); return (strikes.get(k) ?? 0) >= 3; };
    await notify("cpu", hot("cpu", h.cpu > TH.cpu), `CPU ${h.cpu}%`);
    await notify("mem", hot("mem", h.mem > TH.mem), `Memory ${h.mem}%`);
    await notify("disk", h.disk > TH.disk, `Disk ${h.disk}% full`);
    await notify("batt", h.batt !== null && !h.charging && h.batt < TH.batt, `Battery ${h.batt}%`);
    for (const sv of h.services) if (sv.label !== SELF) await notify("svc:" + sv.label, hot("svc:" + sv.label, !sv.pid && sv.exit !== 0 && sv.loaded), `Service ${sv.label} is down (exit ${sv.exit})`);
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
async function pc(action: string, b: Record<string, string>) {
  switch (action) {
    case "status": return { awake: !!awake, mac: cfg.mac ?? null, apps: PC_APPS };
    case "config": { if (b.mac) wol(b.mac); cfg.mac = b.mac; writeFileSync(CFG_FILE, JSON.stringify(cfg)); return { mac: cfg.mac }; }
    case "wake": if (!cfg.mac) throw new Error("set the computer's MAC first"); wol(cfg.mac); return { sent: cfg.mac };
    case "health": return await health();
    case "svc": {
      const l = String(b.label); if (!labels().includes(l)) throw new Error("unknown service");
      if (l === SELF && b.op !== "restart") throw new Error("won't stop the bridge itself");
      const t = `gui/${UID_}/${l}`;
      if (b.op === "restart") return { out: await run(["launchctl", "kickstart", "-k", t]) };
      if (b.op === "stop") return { out: await run(["launchctl", "bootout", t]) };
      if (b.op === "start") { const o = await run(["launchctl", "bootstrap", `gui/${UID_}`, `${LA}/${l}.plist`]); return { out: o + (await run(["launchctl", "kickstart", t])) }; }
      throw new Error("bad op");
    }
    case "kill": { const pid = Number(b.pid); const mine = (await run(["ps", "-U", String(UID_), "-o", "pid="])).split("\n").map(Number); if (!mine.includes(pid) || pid === process.pid) throw new Error("not allowed"); process.kill(pid, "SIGTERM"); return {}; }
    case "testalert": await fetch("https://ntfy.sh/" + TOPIC, { method: "POST", headers: { Title: "Test" }, body: "Alerts work" }); return {};
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

const PORT = Number(process.env.PORT ?? 8788);
const SITE = process.env.SITE_URL ?? "https://web-woad-eight-46.vercel.app";
const KEYS: Record<string, number> = {
  UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23, BACK: 4, HOME: 3, MENU: 82,
  PLAYPAUSE: 85, REWIND: 89, FF: 90, NEXT: 87, PREV: 88,
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
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address.split(".").slice(0, 3).join("."));
  return out;
}
async function check() {
  if (tv) {
    const r = await adb(["connect", `${tv}:5555`]);
    const state = await adb(["-s", `${tv}:5555`, "get-state"]);
    tvOk = /device/.test(state) && !/unauthorized|offline/.test(state);
    if (!tvOk) { if (/unauthorized/.test(state + r)) console.log("TV is asking to Allow debugging — accept it on screen."); if (!process.env.TV_IP) tv = null; }
    return;
  }
  for (const base of subnets()) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    const hits = (await Promise.all(hosts.map(async (h) => ((await open5555(h)) ? h : null)))).filter(Boolean) as string[];
    if (hits.length) { tv = hits[0]; console.log(`Found Fire TV at ${tv}`); return check(); }
  }
}
(async function loop() { try { await check(); } catch (e) { console.error(e); } setTimeout(loop, tvOk ? 8000 : 4000); })();

const sh = (...cmd: string[]) => adb(["-s", `${tv}:5555`, "shell", ...cmd]);

Bun.serve({
  port: PORT, hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/" || url.pathname === "/index.html")
        return new Response(Bun.file(new URL("../web/index.html", import.meta.url)), { headers: { "content-type": "text/html" } });
      if (url.pathname.startsWith("/pc/")) {
        if (req.headers.get("x-token") !== TOKEN) return json({ error: "bad token — re-scan the pairing QR" }, 401);
        const b = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string>) : {};
        return json(await pc(url.pathname.slice(4), b));
      }
      if (url.pathname === "/health") return json({ ok: true, tv, tvConnected: tvOk });
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      if (!tv || !tvOk) return json({ error: "tv not connected", tv }, 503);
      const b = (await req.json().catch(() => ({}))) as Record<string, string>;
      if (url.pathname === "/key") {
        const code = KEYS[String(b.key).toUpperCase()];
        if (!code) return json({ error: "unknown key" }, 400);
        return json({ result: await sh("input", "keyevent", String(code)) });
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
  const t = Bun.spawn(["cloudflared", "tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], { stdout: "ignore", stderr: "pipe" });
  (async () => {
    const dec = new TextDecoder(); let buf = "", done = false;
    for await (const chunk of t.stderr) {
      buf += dec.decode(chunk);
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) { done = true; pair(`${SITE}/#b=${m[0]}&t=${TOKEN}`); console.log(`Alerts: subscribe to ntfy topic ${TOPIC}`); }
    }
  })();
  process.on("exit", () => t.kill());
  process.on("SIGINT", () => { t.kill(); process.exit(0); });
}
