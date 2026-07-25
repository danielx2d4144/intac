#!/usr/bin/env node
// Tiny gate-week CLI: mute / unmute / status / disable / day (end-of-day question).
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { logEvent, LOG_FILE } from "../core/log.mjs";

const MUTE_FILE = join(homedir(), ".agentvoice", "muted");
const cmd = process.argv[2];

switch (cmd) {
  case "mute": {
    writeFileSync(MUTE_FILE, new Date().toISOString());
    logEvent({ type: "mute" });
    console.log("Muted. Summaries become desktop notifications. `agentvoice unmute` to restore.");
    break;
  }
  case "unmute": {
    if (existsSync(MUTE_FILE)) {
      const since = readFileSync(MUTE_FILE, "utf8");
      unlinkSync(MUTE_FILE);
      logEvent({ type: "unmute", mutedSince: since });
    }
    console.log("Unmuted.");
    break;
  }
  case "status": {
    console.log(existsSync(MUTE_FILE) ? "MUTED" : "active");
    console.log(`log: ${LOG_FILE}`);
    break;
  }
  case "disable": {
    // Gate rule: a disable resets the 5-day counter. The reason is the data.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const reason = await rl.question("Why are you disabling it? (this is the gate data): ");
    rl.close();
    logEvent({ type: "disable", reason });
    console.log("Logged. Remove the hook from ~/.claude/settings.json to actually stop events.");
    break;
  }
  case "day": {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const acted = await rl.question("How many turns today did you act on by voice alone? (number or n): ");
    rl.close();
    logEvent({ type: "end-of-day", actedByVoiceAlone: acted });
    console.log("Logged. Good day.");
    break;
  }
  default:
    console.log("agentvoice <mute|unmute|status|disable|day>");
}
