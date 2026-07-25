// Detached worker: acquires the playback lock (or exits if one is alive),
// then drains the spool through the pipeline until it's empty.
import { tryAcquireLock, releaseLock, heartbeat, drainSpool } from "../core/spool.mjs";
import { lastAssistantTurn } from "./transcript.mjs";
import { runPipeline } from "../core/pipeline.mjs";
import { logEvent } from "../core/log.mjs";

if (!tryAcquireLock()) process.exit(0); // live worker exists; it drains our event

const beat = setInterval(heartbeat, 15_000);

try {
  // Loop: new events may arrive while we're speaking.
  for (;;) {
    const events = drainSpool();
    if (events.length === 0) break;
    for (const ev of events) {
      heartbeat();
      try {
        let turnText = "";
        if (ev.eventType === "Notification") {
          // Notification carries its own message; transcript adds context but isn't required.
          turnText = ev.notificationMessage || "The agent needs your attention.";
        } else if (ev.inlineTurnText) {
          // Codex path: turn text arrives inline, no transcript file.
          turnText = ev.inlineTurnText;
        } else if (ev.transcriptPath) {
          const t = lastAssistantTurn(ev.transcriptPath);
          turnText = t.ok ? t.text : ""; // empty → validateTurn degrades loudly
        }
        await runPipeline({
          turnText,
          eventType: ev.eventType,
          projectName: ev.projectName || "your project",
          sessionId: ev.sessionId,
          hookFiredAt: ev.hookFiredAt,
        });
      } catch (err) {
        logEvent({ type: "worker-error", error: String(err).slice(0, 300) });
      }
    }
  }
} finally {
  clearInterval(beat);
  releaseLock();
}
