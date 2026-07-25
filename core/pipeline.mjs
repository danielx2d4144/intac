// Pipeline orchestrator: one event in → one spoken summary out.
// Called by the worker with an extracted turn; owns validation, extraction,
// summarization, speech, and the 3-timestamp latency log.
import { validateTurn } from "./validate.mjs";
import { structuredExtract } from "./extract.mjs";
import { summarize } from "./summarize.mjs";
import { speak } from "../audio/speak.mjs";
import { logEvent } from "./log.mjs";

export async function runPipeline({ turnText, eventType, projectName, sessionId, hookFiredAt }) {
  const degraded = [];
  const v = validateTurn(turnText);

  let summary;
  if (!v.ok) {
    degraded.push(`parser:${v.reason}`);
    summary =
      eventType === "Notification"
        ? `Needs you: the agent in ${projectName} is waiting on your input.`
        : "Summary unavailable. Transcript format may have changed. Check the screen.";
  } else {
    const { extract } = structuredExtract(v.turn);
    const result = await summarize({ extract, eventType, projectName });
    summary = result.summary;
    if (result.degraded) degraded.push(result.degraded);
  }

  const summaryReadyAt = Date.now();
  const channel = await speak(summary);
  const audioStartedAt = Date.now(); // approximation: speak() resolves after playback on this path
  if (channel === "sapi" || channel === "toast") degraded.push(`tts:${channel}`);

  logEvent({
    type: "summary",
    eventType,
    sessionId,
    projectName,
    words: summary.split(/\s+/).length,
    channel,
    degraded: degraded.length ? degraded : undefined,
    hookFiredAt,
    summaryReadyAt,
    audioStartedAt,
    latencyToSummaryMs: hookFiredAt ? summaryReadyAt - hookFiredAt : undefined,
  });

  return { summary, channel, degraded };
}
