// Shared speech-to-text: Groq Whisper (fast free tier) first, Gemini fallback.
// Returns { text, provider, ms }; text is "" when nothing intelligible.
import { getConfig } from "./config.mjs";

const DEV_PROMPT =
  "Software developer dictating prompts and commands: git, npm, commit, branch, deploy, merge, test, build, push, pull, refactor, bug, file names.";

async function viaGroq(wavBytes) {
  const { groqKey } = getConfig();
  const form = new FormData();
  form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "audio.wav");
  form.append("model", "whisper-large-v3-turbo");
  form.append("prompt", DEV_PROMPT);
  form.append("temperature", "0");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${groqKey}` },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const data = await res.json();
  return (data.text || "").trim();
}

async function viaGemini(wavBytes) {
  const { geminiKey } = getConfig();
  const model = process.env.AGENTVOICE_STT_MODEL || "gemini-flash-lite-latest";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: `Transcribe this audio verbatim. ${DEV_PROMPT} Output ONLY the spoken words, no commentary, no quotes. If silent or unintelligible, output exactly: [SILENCE]` },
            { inline_data: { mime_type: "audio/wav", data: wavBytes.toString("base64") } },
          ],
        }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts
    ?.filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text).join("").trim();
  return text === "[SILENCE]" ? "" : (text || "");
}

export async function transcribe(wavBytes) {
  const { groqKey, geminiKey } = getConfig();
  const t0 = Date.now();
  const providers = [];
  if (groqKey.startsWith("gsk_")) providers.push(["groq", viaGroq]);
  if (geminiKey.startsWith("AIza") || geminiKey.startsWith("AQ.")) providers.push(["gemini", viaGemini]);
  let lastErr = "no-stt-key-configured";
  for (const [name, fn] of providers) {
    try {
      const text = await fn(wavBytes);
      return { text, provider: name, ms: Date.now() - t0 };
    } catch (err) {
      lastErr = `${name}:${String(err.message).slice(0, 60)}`;
    }
  }
  return { text: "", provider: `failed(${lastErr})`, ms: Date.now() - t0 };
}
