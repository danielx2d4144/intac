// Extracts the last assistant turn from a Claude Code transcript (JSONL).
// Format is undocumented and version-unstable — everything here is defensive;
// validateTurn downstream decides if what we found is usable.
import { readFileSync } from "node:fs";

export function lastAssistantTurn(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return { ok: false, reason: "transcript-unreadable" };
  }
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = entry?.message;
    if (entry?.type !== "assistant" || !msg) continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n\n");
    }
    if (text.trim()) return { ok: true, text };
    // Assistant entry with no text (pure tool_use) — keep walking back.
  }
  return { ok: false, reason: "no-assistant-text-found" };
}
