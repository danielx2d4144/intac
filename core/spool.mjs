// Spool + PID lockfile: colliding hook events (Stop + Notification seconds
// apart) must ALL play, serialized, Needs-you first. One worker owns playback;
// later hook invocations just enqueue and exit.
import {
  appendFileSync, readFileSync, writeFileSync, existsSync,
  mkdirSync, unlinkSync, renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".agentvoice");
const SPOOL = join(DIR, "spool.jsonl");
const LOCK = join(DIR, "worker.lock");
const HEARTBEAT_STALE_MS = 60_000;

function ensureDir() {
  mkdirSync(DIR, { recursive: true });
}

export function enqueue(event) {
  ensureDir();
  appendFileSync(SPOOL, JSON.stringify(event) + "\n");
}

// Returns true if this process should become the worker (lock acquired),
// false if a live worker already exists.
export function tryAcquireLock() {
  ensureDir();
  if (existsSync(LOCK)) {
    try {
      const { pid, beat } = JSON.parse(readFileSync(LOCK, "utf8"));
      const fresh = Date.now() - beat < HEARTBEAT_STALE_MS;
      if (fresh && pidAlive(pid)) return false;
    } catch { /* corrupt lock = stale */ }
    try { unlinkSync(LOCK); } catch { /* raced; re-check below */ }
  }
  try {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, beat: Date.now() }), { flag: "wx" });
    return true;
  } catch {
    return false; // another hook won the race — it will drain our event
  }
}

export function heartbeat() {
  try {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, beat: Date.now() }));
  } catch { /* best effort */ }
}

export function releaseLock() {
  try {
    const { pid } = JSON.parse(readFileSync(LOCK, "utf8"));
    if (pid === process.pid) unlinkSync(LOCK);
  } catch { /* already gone */ }
}

// Atomically take everything currently in the spool. Notification events
// jump the queue: the blocked agent is always the most important sound.
export function drainSpool() {
  if (!existsSync(SPOOL)) return [];
  const taken = SPOOL + `.${process.pid}.taking`;
  try {
    renameSync(SPOOL, taken);
  } catch {
    return []; // another drain raced us
  }
  const events = readFileSync(taken, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  try { unlinkSync(taken); } catch { /* ignore */ }
  return events.sort((a, b) =>
    (a.eventType === "Notification" ? 0 : 1) - (b.eventType === "Notification" ? 0 : 1),
  );
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
