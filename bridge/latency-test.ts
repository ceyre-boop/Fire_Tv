// Run: bun bridge/latency-test.ts   — re-measures button-to-TV latency and shows which path the bridge picked.
const base = process.env.BRIDGE ?? "http://localhost:8788";
const r = await fetch(base + "/bench", { method: "POST" }).then((x) => x.json()) as any;
console.log(r);
console.log(r.mode === "fast" ? `PASS fast path: ~${r.fastMedianMs} ms per press (was ~${r.slowMedianMs} ms)` : `FAIL fast path unavailable, using slow path (~${r.slowMedianMs} ms)`);
process.exit(r.mode === "fast" ? 0 : 1);
