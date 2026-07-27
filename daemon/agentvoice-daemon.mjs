// agentvoice daemon v0 — the Stage 1 resident process.
//
// While running, it owns the worker lock permanently, so hook-spawned workers
// exit instantly and ALL events flow through this warm process instead —
// hooks and the friend's Codex hack stay completely unchanged.
//
// Keys (when run in a terminal):
//   V     push-to-talk: record 5s → transcribe → paste into the window you
//         focus during the countdown (+Enter unless AGENTVOICE_NO_ENTER=1)
//   M     toggle mute
//   Q     quit cleanly
//
// Run: node daemon/agentvoice-daemon.mjs
import { tryAcquireLock, releaseLock, heartbeat, drainSpool } from "../core/spool.mjs";
import { lastAssistantTurn } from "../integrations/transcript.mjs";
import { runPipeline } from "../core/pipeline.mjs";
import { logEvent } from "../core/log.mjs";
import { getConfig } from "../core/config.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PsWorker } from "./ps-worker.mjs";

const pExecFile = promisify(execFile);
const MUTE_FILE = join(homedir(), ".agentvoice", "muted");
const STT_MODEL = process.env.AGENTVOICE_STT_MODEL || "gemini-flash-lite-latest";
// Window-title pattern for the paste target (regex, case-insensitive).
// Claude Code sets its terminal title; "claude" matches the default. Press L to
// list candidate windows if pasting lands nowhere.
const TARGET_TITLE = process.env.AGENTVOICE_TARGET_TITLE || "claude";

const ps = (script, timeout = 120000) =>
  pExecFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true, timeout },
  );

// ---- take ownership ---------------------------------------------------------
if (!tryAcquireLock()) {
  console.error("Another worker/daemon holds the lock. Is a daemon already running?");
  process.exit(1);
}
const beat = setInterval(heartbeat, 15_000);
let busy = false;
let quitting = false;
let recording = false;
let recStartedAt = 0;
const worker = new PsWorker();
await worker.start();

const say = (s) => console.log(`[agentvoice] ${s}`);
say(`daemon up. pid=${process.pid} stt=${STT_MODEL} (warm ps-worker ready)`);
say(existsSync(MUTE_FILE) ? "status: MUTED" : "status: active");

// ---- spool drain loop (voice OUT, warm) ------------------------------------
async function drainOnce() {
  if (busy) return;
  const events = drainSpool();
  if (events.length === 0) return;
  busy = true;
  try {
    for (const ev of events) {
      heartbeat();
      try {
        let turnText = "";
        if (ev.eventType === "Notification") {
          turnText = ev.notificationMessage || "The agent needs your attention.";
        } else if (ev.inlineTurnText) {
          turnText = ev.inlineTurnText;
        } else if (ev.transcriptPath) {
          const t = lastAssistantTurn(ev.transcriptPath);
          turnText = t.ok ? t.text : "";
        }
        const r = await runPipeline({
          turnText,
          eventType: ev.eventType,
          projectName: ev.projectName || "your project",
          sessionId: ev.sessionId,
          hookFiredAt: ev.hookFiredAt,
        });
        say(`spoke [${r.channel}] (${ev.eventType}, ${ev.projectName}): ${r.summary.slice(0, 80)}...`);
      } catch (err) {
        logEvent({ type: "daemon-error", error: String(err).slice(0, 300) });
        say(`event failed: ${String(err).slice(0, 120)}`);
      }
    }
  } finally {
    busy = false;
  }
}
const drainTimer = setInterval(drainOnce, 500);

// ---- push-to-talk (voice IN) — V toggles: press to start, press to stop -----
async function pttStart() {
  const r = await worker.cmd("REC_START");
  if (!r.startsWith("OK")) { say(`mic failed: ${r}`); return; }
  recording = true;
  recStartedAt = Date.now();
  say("recording — press V again when you're done speaking...");
}

async function pttStopAndSend() {
  recording = false;
  busy = true;
  try {
    const t0 = Date.now();
    const dir = join(tmpdir(), "agentvoice");
    mkdirSync(dir, { recursive: true });
    const wav = join(dir, `ptt-${Date.now()}.wav`);
    const stopRes = await worker.cmd("REC_STOP", wav);
    if (!stopRes.startsWith("OK")) { say(`mic save failed: ${stopRes}`); return; }
    const spokeMs = t0 - recStartedAt;
    const wavBytes = readFileSync(wav);
    if (wavBytes.length < 1000) { say("no audio captured"); return; }

    const { geminiKey } = getConfig();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${STT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: "Transcribe this audio verbatim. The speaker is a software developer dictating commands and prompts - prefer technical terms when ambiguous (git, npm, commit, branch, deploy, merge, test, build, push, pull). Output ONLY the spoken words, no commentary, no quotes. If silent or unintelligible, output exactly: [SILENCE]" },
              { inline_data: { mime_type: "audio/wav", data: wavBytes.toString("base64") } },
            ],
          }],
          generationConfig: { maxOutputTokens: 2000 },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok) { say(`stt failed: ${res.status}`); return; }
    const data = await res.json();
    const transcript = data.candidates?.[0]?.content?.parts
      ?.filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text).join("").trim();
    if (!transcript || transcript === "[SILENCE]") { say("nothing intelligible"); return; }
    const sttMs = Date.now() - t0;
    say(`heard: "${transcript}"`);

    await worker.cmd("CLIP", transcript);
    const wantEnter = process.env.AGENTVOICE_NO_ENTER ? "0" : "1";
    if (process.env.AGENTVOICE_FOCUS_MODE === "manual") {
      say("FOCUS YOUR AGENT WINDOW — pasting in 5s...");
      await new Promise((r) => setTimeout(r, 5000));
      const enter = wantEnter === "1" ? "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');" : "";
      await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 300; ${enter} 'SENT'`);
      say("sent.");
    } else {
      const out = await worker.cmd("FOCUS_PASTE", TARGET_TITLE, wantEnter);
      if (out.startsWith("ERR")) {
        say(`no window matched /${TARGET_TITLE}/i — transcript is on your clipboard. Press L to list windows.`);
      } else {
        say(out.replace("OK FOCUS_PASTE", "pasted into:"));
      }
    }
    const totalMs = Date.now() - t0;
    say(`latency: spoke ${(spokeMs / 1000).toFixed(1)}s | stop-to-text ${sttMs}ms | stop-to-sent ${totalMs}ms`);
    logEvent({ type: "ptt", spokeMs, sttMs, totalMs, chars: transcript.length });
  } catch (err) {
    say(`ptt failed: ${String(err).slice(0, 150)}`);
  } finally {
    busy = false;
  }
}

async function pushToTalk() {
  if (recording) return pttStopAndSend();
  if (busy) { say("busy — try again in a moment"); return; }
  return pttStart();
}

// ---- keys ---------------------------------------------------------------------
if (process.stdin.isTTY) {
  const readline = await import("node:readline");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  say("keys: [V] talk (press to start, press again to send)  [M] mute  [L] list windows  [Q] quit");
  // Paste-burst guard: characters arriving <30ms apart are a paste landing in
  // our own window, not a human pressing command keys - ignore until it settles.
  let lastKeyAt = 0;
  let burstUntil = 0;
  process.stdin.on("keypress", async (_str, key) => {
    if (!key) return;
    const now = Date.now();
    if (now - lastKeyAt < 30) burstUntil = now + 300;
    lastKeyAt = now;
    if (now < burstUntil) return;
    const k = (key.name || "").toLowerCase();
    if (k === "q" || (key.ctrl && k === "c")) return shutdown();
    if (k === "m") {
      if (existsSync(MUTE_FILE)) { unlinkSync(MUTE_FILE); logEvent({ type: "unmute" }); say("unmuted"); }
      else { writeFileSync(MUTE_FILE, new Date().toISOString()); logEvent({ type: "mute" }); say("MUTED (desktop notifications only)"); }
    }
    if (k === "v") await pushToTalk();
    if (k === "l") {
      const { stdout } = await ps(`Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + ' | ' + $_.MainWindowTitle }`);
      say("windows with titles:");
      console.log(stdout.trim());
      say(`current target pattern: /${TARGET_TITLE}/i (set AGENTVOICE_TARGET_TITLE to change)`);
    }
  });
} else {
  say("no TTY — running headless (voice-out only)");
}

function shutdown() {
  if (quitting) return;
  quitting = true;
  say("shutting down...");
  clearInterval(drainTimer);
  clearInterval(beat);
  worker.stop();
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
