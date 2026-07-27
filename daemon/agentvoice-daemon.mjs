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

const pExecFile = promisify(execFile);
const MUTE_FILE = join(homedir(), ".agentvoice", "muted");
const STT_MODEL = process.env.AGENTVOICE_STT_MODEL || "gemini-flash-lite-latest";
const PTT_SECONDS = Number(process.env.AGENTVOICE_PTT_SECONDS || 5);

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

const say = (s) => console.log(`[agentvoice] ${s}`);
say(`daemon up. pid=${process.pid} stt=${STT_MODEL}`);
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

// ---- push-to-talk (voice IN) -------------------------------------------------
async function pushToTalk() {
  if (busy) { say("busy speaking — try again in a moment"); return; }
  busy = true;
  try {
    const dir = join(tmpdir(), "agentvoice");
    mkdirSync(dir, { recursive: true });
    const wav = join(dir, `ptt-${Date.now()}.wav`);
    say(`recording ${PTT_SECONDS}s — SPEAK NOW...`);
    const t0 = Date.now();
    const recScript = `
$sig = '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string lpstrCommand, System.Text.StringBuilder lpstrReturnString, int uReturnLength, IntPtr hwndCallback);';
Add-Type -Name MCI -Namespace Win32 -MemberDefinition $sig;
[Win32.MCI]::mciSendString('open new type waveaudio alias rec', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('set rec time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('record rec', $null, 0, [IntPtr]::Zero) | Out-Null;
Start-Sleep -Seconds ${PTT_SECONDS};
[Win32.MCI]::mciSendString('stop rec', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('save rec "${wav.replace(/\\/g, "\\\\")}"', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('close rec', $null, 0, [IntPtr]::Zero) | Out-Null;
'RECORDED';`;
    await ps(recScript, (PTT_SECONDS + 15) * 1000);
    const wavBytes = readFileSync(wav);
    if (wavBytes.length < 1000) { say("no audio captured"); return; }

    say("transcribing...");
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
              { text: "Transcribe this audio verbatim. Output ONLY the spoken words, no commentary, no quotes. If silent or unintelligible, output exactly: [SILENCE]" },
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
    say(`heard (${Date.now() - t0}ms total): "${transcript}"`);

    const b64 = Buffer.from(transcript, "utf8").toString("base64");
    await ps(`$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; 'OK'`);
    say("FOCUS YOUR AGENT WINDOW — pasting in 3s...");
    await new Promise((r) => setTimeout(r, 3000));
    const enter = process.env.AGENTVOICE_NO_ENTER ? "" : "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');";
    await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 300; ${enter} 'SENT'`);
    say("sent.");
    logEvent({ type: "ptt", ms: Date.now() - t0, chars: transcript.length });
  } catch (err) {
    say(`ptt failed: ${String(err).slice(0, 150)}`);
  } finally {
    busy = false;
  }
}

// ---- keys ---------------------------------------------------------------------
if (process.stdin.isTTY) {
  const readline = await import("node:readline");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  say("keys: [V] talk  [M] mute  [Q] quit");
  process.stdin.on("keypress", async (_str, key) => {
    if (!key) return;
    const k = (key.name || "").toLowerCase();
    if (k === "q" || (key.ctrl && k === "c")) return shutdown();
    if (k === "m") {
      if (existsSync(MUTE_FILE)) { unlinkSync(MUTE_FILE); logEvent({ type: "unmute" }); say("unmuted"); }
      else { writeFileSync(MUTE_FILE, new Date().toISOString()); logEvent({ type: "mute" }); say("MUTED (desktop notifications only)"); }
    }
    if (k === "v") await pushToTalk();
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
  releaseLock();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
