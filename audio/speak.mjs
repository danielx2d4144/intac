// Audio chain: OpenAI TTS → temp MP3 → hidden PowerShell MediaPlayer.
// Fallbacks: SAPI offline voice → desktop toast. Mute file short-circuits to toast.
// Stage 2 note: this file-then-play path cannot barge-in; streaming upgrade lands there.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "../core/config.mjs";

const pExecFile = promisify(execFile);
const MUTE_FILE = join(homedir(), ".agentvoice", "muted");

const psRun = (script, timeout = 60000) =>
  pExecFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true, timeout },
  );

export function isMuted() {
  return existsSync(MUTE_FILE);
}

async function openaiTtsToFile(text) {
  const { openaiKey } = getConfig();
  if (!openaiKey.startsWith("sk-")) throw new Error("no valid openai key");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openaiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "mp3" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = join(tmpdir(), "agentvoice");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `summary-${Date.now()}.mp3`);
  writeFileSync(file, buf);
  return file;
}

// Edge TTS: Microsoft's neural voices, free, no key. Primary voice when no
// OpenAI key is configured.
async function edgeTtsToFile(text) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const { edgeVoice } = getConfig();
  const tts = new MsEdgeTTS();
  await tts.setMetadata(edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  // toFile appends /audio.mp3 and does NOT create the directory — make it first.
  const outDir = join(tmpdir(), "agentvoice", `summary-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });
  const { audioFilePath } = await tts.toFile(outDir, text);
  return audioFilePath;
}

async function playMp3(file) {
  // MediaPlayer needs a message pump; a timed wait keyed to media length is the boring reliable way.
  const script = `
Add-Type -AssemblyName PresentationCore;
$p = New-Object System.Windows.Media.MediaPlayer;
$p.Open([Uri]'${file.replace(/'/g, "''")}');
$deadline = (Get-Date).AddSeconds(10);
while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 };
if (-not $p.NaturalDuration.HasTimeSpan) { exit 1 };
$p.Volume = 1.0; $p.Play();
Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 500);
$p.Close();`;
  await psRun(script, 90000);
}

async function sapiSpeak(text) {
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak('${text.replace(/'/g, "''")}');`;
  await psRun(script);
}

async function toast(text) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms;
$n = New-Object System.Windows.Forms.NotifyIcon;
$n.Icon = [System.Drawing.SystemIcons]::Information;
$n.Visible = $true;
$n.ShowBalloonTip(8000, 'agentvoice', '${text.replace(/'/g, "''").slice(0, 250)}', 'Info');
Start-Sleep -Seconds 9; $n.Dispose();`;
  await psRun(script, 15000);
}

// Returns the channel used: "tts" | "edge" | "sapi" | "toast" | "muted-toast" | "silent-fail"
export async function speak(text) {
  if (isMuted()) {
    try { await toast(text); return "muted-toast"; } catch { return "silent-fail"; }
  }
  try {
    const file = await openaiTtsToFile(text);
    await playMp3(file);
    return "tts";
  } catch { /* fall through */ }
  try {
    const file = await edgeTtsToFile(text);
    await playMp3(file);
    return "edge";
  } catch { /* fall through */ }
  try { await sapiSpeak(text); return "sapi"; } catch { /* fall through */ }
  try { await toast(text); return "toast"; } catch { return "silent-fail"; }
}
