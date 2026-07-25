// T1 validation: simulates the real Claude Code hook entry point.
// Reads a Stop-like event from stdin, spawns the worker fully detached,
// and exits immediately — the agent loop must never wait on us.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const t0 = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(here, "..", "tmp");
mkdirSync(tmpDir, { recursive: true });

let stdin = "";
try {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) stdin += chunk;
  }
} catch { /* no stdin is fine for T1 */ }

const eventFile = join(tmpDir, "t1-event.json");
writeFileSync(eventFile, stdin || JSON.stringify({ hook_event_name: "Stop", simulated: true }));

const worker = spawn(process.execPath, [join(here, "t1-worker.mjs"), eventFile], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
worker.unref();

const elapsed = Date.now() - t0;
console.log(`T1 hook: spawned worker pid=${worker.pid}, parent exiting after ${elapsed}ms`);
process.exit(0);
