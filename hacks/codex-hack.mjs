// The friend's Stage 0 hack: Codex CLI → same shared core.
// Codex has a `notify` config hook (fires with a JSON arg on turn completion /
// approval requests). Wire in ~/.codex/config.toml:
//   notify = ["node", "C:\\path\\to\\intac\\hacks\\codex-hack.mjs"]
// The JSON arrives as argv[2], not stdin.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { enqueue } from "../core/spool.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let payload = {};
try { payload = JSON.parse(process.argv[2] || "{}"); } catch { /* defensive */ }

// codex notify types: "agent-turn-complete" | "approval-requested" (naming defensive)
const type = String(payload.type || "");
const isApproval = /approval/i.test(type);

const lastMessage =
  payload["last-assistant-message"] || payload.last_assistant_message || "";
const turnText = isApproval
  ? (payload.message || "Codex is waiting for your approval.")
  : (lastMessage || (Array.isArray(payload["input_messages"]) ? payload["input_messages"].join(" ") : ""));

enqueue({
  eventType: isApproval ? "Notification" : "Stop",
  sessionId: payload["turn-id"] || payload.turn_id || "codex",
  transcriptPath: null,
  notificationMessage: isApproval ? turnText : null,
  inlineTurnText: isApproval ? null : turnText, // codex gives text directly; no transcript file
  projectName: basename(payload.cwd || process.cwd()),
  hookFiredAt: Date.now(),
});

const worker = spawn(process.execPath, [join(here, "..", "integrations", "worker.mjs")], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
worker.unref();
process.exit(0);
