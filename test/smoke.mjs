// End-to-end smoke test: fake transcript → pipeline → audible summary.
import { readFileSync } from "node:fs";
import { runPipeline } from "../core/pipeline.mjs";

const turnText = readFileSync(new URL("./fixtures/smoke-turn.txt", import.meta.url), "utf8");
const t0 = Date.now();
const r = await runPipeline({
  turnText,
  eventType: process.argv[2] === "notification" ? "Notification" : "Stop",
  projectName: "demo app",
  sessionId: "smoke-1",
  hookFiredAt: t0,
});
console.log("CHANNEL:", r.channel);
console.log("DEGRADED:", r.degraded);
console.log("SUMMARY:", r.summary);
console.log("WORDS:", r.summary.split(/\s+/).length);
console.log("TOTAL MS:", Date.now() - t0);
