// THE production hook entry point for Claude Code (Stop + Notification).
// Contract: read stdin JSON, enqueue, spawn detached worker, exit <100ms.
// The agent loop must never feel us.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { enqueue } from "../core/spool.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let stdin = "";
try {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) stdin += chunk;
  }
} catch { /* proceed with empty */ }

let hook = {};
try { hook = JSON.parse(stdin); } catch { /* defensive */ }

const eventType = hook.hook_event_name === "Notification" ? "Notification" : "Stop";
const cwd = hook.cwd || process.cwd();

enqueue({
  eventType,
  sessionId: hook.session_id || "unknown",
  transcriptPath: hook.transcript_path || null,
  notificationMessage: eventType === "Notification" ? (hook.message || null) : null,
  projectName: basename(cwd),
  hookFiredAt: Date.now(),
});

const worker = spawn(process.execPath, [join(here, "worker.mjs")], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
worker.unref();
process.exit(0);
