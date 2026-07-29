// The product's heart: extract → ≤40-word pair-programmer summary.
// Providers in preference order: Gemini (free tier) → Anthropic (BYO key).
// Keys are prefix-checked so a placeholder env var doesn't cost a 401 round-trip.
// Template fallback keeps the pipeline speaking even when every LLM is down.
import { getConfig } from "./config.mjs";

const SYSTEM = `You are the voice of a coding agent, speaking a quick over-the-shoulder update to the developer. From the structured extract of the agent's last turn, produce ONE spoken-style summary of at most 40 words covering: outcome (done/failed/partial), naming the feature or task in the agent's own words (if the agent says "dark mode", say "dark mode", not a paraphrase), scope (what changed, key files in plain words - say "settings component", not full paths), and test/build status if present. If and ONLY if the agent's own text explicitly asked the developer a question, end with that question restated briefly. NEVER invent a question, suggestion, or next step the agent did not state - if the agent asked nothing, the summary ends with the status. No markdown, no code syntax, no file extensions spelled out. Sound human.`;

async function viaGroq(userText) {
  const { groqKey } = getConfig();
  const model = process.env.AGENTVOICE_GROQ_MODEL || "openai/gpt-oss-120b";
  const isReasoner = model.includes("gpt-oss");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${groqKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      // Reasoning models spend tokens thinking before answering - give headroom.
      max_tokens: isReasoner ? 800 : 120,
      temperature: 0,
      ...(isReasoner ? { reasoning_effort: "low" } : {}),
      messages: [
        { role: "system", content: SYSTEM + " CRITICAL: Do not phrase anything as a question unless the agent's text literally contains a question mark addressed to the developer. Statements of failure stay statements." },
        { role: "user", content: userText },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("groq empty completion");
  return text;
}

async function viaGemini(userText) {
  const { geminiKey, geminiModel } = getConfig();
  // Free tier throttles intermittently: give a real budget and one retry.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts: [{ text: userText }] }],
            generationConfig: { maxOutputTokens: 1500 },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts
        ?.filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
      if (!text) throw new Error("gemini empty completion");
      return text;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function viaAnthropic(userText) {
  const { anthropicKey, model } = getConfig();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error("anthropic empty completion");
  return text;
}

export async function summarize({ extract, eventType, projectName }) {
  const prefix = eventType === "Notification" ? "Needs you: " : "";
  const userText = `Project: ${projectName}\nEvent: ${eventType}\n\n${extract}`;
  const { geminiKey, anthropicKey, groqKey } = getConfig();

  const providers = [];
  // Groq first: free tier responds in <1s where Gemini's queue takes 8-15s.
  if (groqKey.startsWith("gsk_")) providers.push(["groq", viaGroq]);
  // Google keys: classic "AIza..." or the newer "AQ." format.
  if (geminiKey.startsWith("AIza") || geminiKey.startsWith("AQ.")) providers.push(["gemini", viaGemini]);
  if (anthropicKey.startsWith("sk-ant-")) providers.push(["anthropic", viaAnthropic]);

  const errors = [];
  for (const [name, fn] of providers) {
    try {
      return { summary: prefix + (await fn(userText)), degraded: null };
    } catch (err) {
      errors.push(`${name}:${String(err.message).slice(0, 60)}`);
    }
  }
  if (providers.length === 0) errors.push("llm:no-valid-key-configured");

  const fallback =
    eventType === "Notification"
      ? `Needs you: the agent in ${projectName} is waiting on your input. Check the screen.`
      : `Turn finished in ${projectName}. Check screen for details.`;
  return { summary: fallback, degraded: errors.join("|") || "llm:unknown" };
}
