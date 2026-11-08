// Run: bun bridge/latency-test.ts   — re-measures button-to-TV latency and shows which path the bridge picked.
const base = process.env.BRIDGE ?? "http://localhost:8788";
const r = await fetch(base + "/bench", { method: "POST" }).then((x) => x.json()) as any;
console.log(r);
console.log(r.mode === "fast" ? `PASS fast path: ~${r.fastMedianMs} ms per press (was ~${r.slowMedianMs} ms)` : `FAIL fast path unavailable, using slow path (~${r.slowMedianMs} ms)`);
// Real-world feel: one key press per second (like mid-movie), through the same WebSocket the phone uses.
// NOOP = KEYCODE_UNKNOWN, does nothing on the TV. Compare radio asleep vs kept warm by pings like the page sends.
const ws = new WebSocket(base.replace("http", "ws") + "/ws"); await new Promise((r) => (ws.onopen = r));
const one = (id: number) => new Promise<number>((res) => { const t = performance.now(); ws.onmessage = (e) => { if (e.data !== "p") res(performance.now() - t); }; ws.send(JSON.stringify({ k: "NOOP", id })); });
const run = async (warm: boolean) => {
  const t = warm ? setInterval(() => ws.send('{"p":1}'), 100) : null; const xs: number[] = [];
  for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, warm ? 1000 : 7000)); xs.push(await one(i)); }
  if (t) clearInterval(t); xs.sort((a, b) => a - b); return { median: Math.round(xs[7]), p90: Math.round(xs[13]), worst: Math.round(xs[14]) };
};
if (!process.env.QUICK) {
  console.log("cold (idle 7s between presses):", await run(false));
  console.log("warm (keep-alive on):         ", await run(true));
}
process.exit(r.mode === "fast" ? 0 : 1);
