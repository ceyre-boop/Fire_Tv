#!/usr/bin/env bun
// Shows every message on this Mac's ntfy topic as a real macOS notification. Runs under launchd (com.firetv.ntfy-mac).
// The same topic still goes to the phone app, so nothing changes there.
import { readFileSync } from "node:fs";
const TOPIC = readFileSync(new URL("../.ntfy-topic", import.meta.url).pathname, "utf8").trim();

function notify(title: string, body: string, loud: boolean) {
  // title/body go in as arguments, never spliced into the script text, so message content can't inject AppleScript
  const script = ["on run argv", `display notification (item 2 of argv) with title (item 1 of argv)${loud ? ' sound name "Glass"' : ""}`, "end run"];
  Bun.spawn(["osascript", ...script.flatMap((l) => ["-e", l]), title.slice(0, 120), body.slice(0, 400)], { stdout: "ignore", stderr: "ignore" });
}

let since = String(Math.floor(Date.now() / 1000)), wait = 1000;
for (;;) {
  try {
    const r = await fetch(`https://ntfy.sh/${TOPIC}/json?since=${since}`);
    if (!r.ok || !r.body) throw new Error("ntfy " + r.status);
    wait = 1000;
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of r.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id) since = m.id;   // resume after the last message we showed, so a reconnect never repeats or drops one
          if (m.event === "message") notify(m.title || "Mac", String(m.message ?? ""), (m.priority ?? 3) >= 4);
        } catch { /* ignore a broken line */ }
      }
    }
  } catch { /* offline or dropped: retry below */ }
  await Bun.sleep(wait); wait = Math.min(wait * 2, 30_000);
}
