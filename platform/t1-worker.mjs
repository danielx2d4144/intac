// T1 validation: the detached worker.
// Proves it (1) outlives the parent, (2) plays audio via hidden PowerShell
// with no window flash, (3) handles paths with spaces.
import { writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(here, "..", "tmp");
const marker = join(tmpDir, "t1-worker-alive.txt");

const log = (line) =>
  appendFileSync(marker, `${new Date().toISOString()} ${line}\n`);

writeFileSync(marker, `${new Date().toISOString()} worker started pid=${process.pid}\n`);

// Give the parent time to fully exit so survival is actually proven.
await new Promise((r) => setTimeout(r, 1500));
log("still alive after parent exit window");

// Audio via hidden PowerShell + SAPI (offline path — no API needed for T1).
const psScript = [
  "Add-Type -AssemblyName System.Speech;",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
  "$s.Rate = 1;",
  "$s.Speak('Agent voice spawn validation passed.');",
].join(" ");

try {
  const t0 = Date.now();
  await pExecFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
    { windowsHide: true, timeout: 30000 },
  );
  log(`audio played ok in ${Date.now() - t0}ms`);
} catch (err) {
  log(`audio FAILED: ${String(err).slice(0, 300)}`);
}

// Paths-with-spaces check: write and read back through a spaced directory.
try {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const spacedDir = join(tmpDir, "dir with spaces");
  mkdirSync(spacedDir, { recursive: true });
  const spacedFile = join(spacedDir, "file with spaces.txt");
  writeFileSync(spacedFile, "ok");
  const back = readFileSync(spacedFile, "utf8");
  log(`spaced-path roundtrip: ${back === "ok" ? "ok" : "MISMATCH"}`);
} catch (err) {
  log(`spaced-path FAILED: ${String(err).slice(0, 300)}`);
}

log("worker done");
