// Defensive gate between the undocumented transcript format and the summarizer.
// A Claude Code update must degrade loudly (log + one spoken notice), never silently.
export function validateTurn(turnText) {
  if (typeof turnText !== "string") return { ok: false, reason: "not-a-string" };
  const trimmed = turnText.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length < 10) return { ok: false, reason: "too-short" };
  if (trimmed.length > 2_000_000) return { ok: false, reason: "absurd-length" };
  const replacementRatio =
    (trimmed.match(/�/g)?.length ?? 0) / trimmed.length;
  if (replacementRatio > 0.05) return { ok: false, reason: "binary-garbage" };
  return { ok: true, turn: trimmed };
}
