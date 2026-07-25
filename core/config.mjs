// Key/config loading: ~/.agentvoice/config.json first (hooks don't reliably
// inherit shell env), process.env as fallback. Never logged, never synced.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_FILE = join(homedir(), ".agentvoice", "config.json");

let cached;
export function getConfig() {
  if (cached) return cached;
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch { /* no config file yet — env only */ }
  cached = {
    anthropicKey: file.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "",
    openaiKey: file.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
    geminiKey: file.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "",
    model: file.AGENTVOICE_MODEL || process.env.AGENTVOICE_MODEL || "claude-haiku-4-5-20251001",
    geminiModel: file.AGENTVOICE_GEMINI_MODEL || process.env.AGENTVOICE_GEMINI_MODEL || "gemini-flash-latest",
    edgeVoice: file.AGENTVOICE_EDGE_VOICE || "en-US-AvaMultilingualNeural",
  };
  return cached;
}
export { CONFIG_FILE };
