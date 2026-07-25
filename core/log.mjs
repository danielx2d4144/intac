// Local-only usage log (gate instrumentation). JSONL at ~/.agentvoice/usage.jsonl.
// Nothing here ever leaves the machine.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".agentvoice");
export const LOG_FILE = join(DIR, "usage.jsonl");

export function logEvent(entry) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Logging must never break the pipeline.
  }
}
