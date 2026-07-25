// Summarizer eval: run every case through structuredExtract + summarize,
// check the three signals (outcome, files, decision) and the 40-word budget.
// Cases grow to 10 during gate week from REAL transcripts.
// Usage: node evals/run.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { structuredExtract } from "../core/extract.mjs";
import { summarize } from "../core/summarize.mjs";

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "cases");
const files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));

let pass = 0, fail = 0;
for (const f of files) {
  const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
  const { extract } = structuredExtract(c.turnText);
  const { summary, degraded } = await summarize({
    extract,
    eventType: c.eventType || "Stop",
    projectName: c.projectName || "test project",
  });

  const words = summary.split(/\s+/).length;
  const checks = {
    "llm-reachable": !degraded,
    "word-budget-45": words <= 45, // 40-word target + small prefix allowance
    ...Object.fromEntries(
      (c.mustMention || []).map((m) => [
        `mentions:${m}`,
        summary.toLowerCase().includes(m.toLowerCase()),
      ]),
    ),
    ...(c.mustAskQuestion !== undefined
      ? { "asks-question": /\?/.test(summary) === c.mustAskQuestion }
      : {}),
  };

  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  if (failed.length === 0) {
    pass++;
    console.log(`PASS ${f} (${words}w): ${summary}`);
  } else {
    fail++;
    console.log(`FAIL ${f} (${words}w): ${summary}`);
    for (const [name] of failed) console.log(`     ✗ ${name}`);
  }
}
console.log(`\n${pass}/${pass + fail} cases passed`);
process.exit(fail === 0 ? 0 : 1);
