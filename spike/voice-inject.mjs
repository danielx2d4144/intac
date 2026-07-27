// STAGE 1 SPIKE — the coin-flip: can spoken words land in a live Claude Code session?
// Zero new deps, zero new accounts:
//   mic:    PowerShell + winmm mciSendString (built into Windows)
//   STT:    your existing free Gemini key (audio inline — no OpenAI needed)
//   inject: clipboard + SendKeys Ctrl+V (+Enter) into the focused window
//
// Usage:
//   node spike/voice-inject.mjs --seconds 5 --dry-run   # record+transcribe only
//   node spike/voice-inject.mjs --seconds 5             # full loop: focus your
//                                                       # Claude Code window during
//                                                       # the countdown after recording
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../core/config.mjs";

const pExecFile = promisify(execFile);
const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 5;
const dryRun = args.includes("--dry-run");
const noEnter = args.includes("--no-enter");

const ps = (script, timeout = 120000) =>
  pExecFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true, timeout },
  );

// ---- 1. RECORD ------------------------------------------------------------
const dir = join(tmpdir(), "agentvoice");
mkdirSync(dir, { recursive: true });
const wav = join(dir, `spike-${Date.now()}.wav`);

console.log(`[1/4] Recording ${seconds}s from the default mic — SPEAK NOW...`);
const t0 = Date.now();
const recScript = `
$sig = '[DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern int mciSendString(string lpstrCommand, System.Text.StringBuilder lpstrReturnString, int uReturnLength, IntPtr hwndCallback);';
Add-Type -Name MCI -Namespace Win32 -MemberDefinition $sig;
[Win32.MCI]::mciSendString('open new type waveaudio alias rec', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('set rec time format ms bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('record rec', $null, 0, [IntPtr]::Zero) | Out-Null;
Start-Sleep -Seconds ${seconds};
[Win32.MCI]::mciSendString('stop rec', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('save rec "${wav.replace(/\\/g, "\\\\")}"', $null, 0, [IntPtr]::Zero) | Out-Null;
[Win32.MCI]::mciSendString('close rec', $null, 0, [IntPtr]::Zero) | Out-Null;
'RECORDED';`;
const { stdout: recOut } = await ps(recScript, (seconds + 15) * 1000);
if (!recOut.includes("RECORDED")) throw new Error("mic recording failed: " + recOut);
const wavBytes = readFileSync(wav);
console.log(`      recorded ${wavBytes.length} bytes in ${Date.now() - t0}ms → ${wav}`);
if (wavBytes.length < 1000) throw new Error("WAV suspiciously small — no mic input?");

// ---- 2. TRANSCRIBE (Gemini, free key) --------------------------------------
console.log("[2/4] Transcribing via Gemini...");
const t1 = Date.now();
const { geminiKey, geminiModel } = getConfig();
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
  {
    method: "POST",
    headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: "Transcribe this audio verbatim. Output ONLY the spoken words, no commentary, no quotes. If the audio is silent or unintelligible, output exactly: [SILENCE]" },
          { inline_data: { mime_type: "audio/wav", data: wavBytes.toString("base64") } },
        ],
      }],
      generationConfig: { maxOutputTokens: 2000 },
    }),
    signal: AbortSignal.timeout(30000),
  },
);
if (!res.ok) throw new Error(`gemini stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
const data = await res.json();
const transcript = data.candidates?.[0]?.content?.parts
  ?.filter((p) => typeof p.text === "string" && !p.thought)
  .map((p) => p.text).join("").trim();
console.log(`      transcript (${Date.now() - t1}ms): "${transcript}"`);
if (!transcript || transcript === "[SILENCE]") {
  console.log("      Nothing intelligible — try again closer to the mic.");
  process.exit(1);
}

// ---- 3. CLIPBOARD -----------------------------------------------------------
console.log("[3/4] Placing transcript on clipboard...");
const b64 = Buffer.from(transcript, "utf8").toString("base64");
await ps(`$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t; 'CLIP_OK'`);

if (dryRun) {
  console.log("[4/4] DRY RUN — skipping injection. Transcript is on your clipboard; paste it anywhere to verify.");
  process.exit(0);
}

// ---- 4. INJECT --------------------------------------------------------------
console.log("[4/4] FOCUS YOUR CLAUDE CODE WINDOW NOW — pasting in 4 seconds...");
await new Promise((r) => setTimeout(r, 4000));
const enterPart = noEnter ? "" : "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}');";
await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 300; ${enterPart} 'SENT'`);
console.log(`      injected${noEnter ? " (no Enter)" : " + Enter"}. Total loop: ${Date.now() - t0}ms`);
console.log("SPIKE RESULT: if your words just became an agent prompt, Stage 1 is GO.");
