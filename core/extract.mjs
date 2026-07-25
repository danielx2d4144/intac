// Structured extraction: pull the signals a skimming developer actually reads
// (files touched, test/build results, the closing prose) instead of shipping
// the raw wall of text to the LLM. Hard 8KB cap bounds latency and cost.
const CAP = 8 * 1024;

const FILE_RE =
  /(?:^|[\s"'`(\[])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.\w{1,8})(?=$|[\s"'`)\],:;]|\.(?:\s|$))/gm;

const TEST_LINE_RE =
  /^.*(?:\btests? (?:pass|passed|fail|failed)\b|\bpassing\b|\bfailing\b|\d+ (?:passed|failed|errors?)\b|✓|✗|PASS|FAIL|error TS\d+|ExitCode|exit code \d+).*$/gim;

export function structuredExtract(turn) {
  const files = [...new Set([...turn.matchAll(FILE_RE)].map((m) => m[1]))]
    .filter((f) => !f.includes("node_modules"))
    .slice(0, 20);

  const testSignals = [...new Set([...turn.matchAll(TEST_LINE_RE)].map((m) => m[0].trim()))]
    .slice(0, 10);

  const paragraphs = turn.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let finalParagraphs = paragraphs.slice(-3).join("\n\n");

  // Cap by trimming the closing prose — never the structured signals.
  const header = [
    files.length ? `FILES MENTIONED:\n${files.join("\n")}` : "",
    testSignals.length ? `TEST/BUILD SIGNALS:\n${testSignals.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const room = CAP - header.length - "\n\nCLOSING TEXT:\n".length;
  if (finalParagraphs.length > room) finalParagraphs = finalParagraphs.slice(-Math.max(room, 0));

  const extract = [header, `CLOSING TEXT:\n${finalParagraphs}`].filter(Boolean).join("\n\n");
  return { extract, fileCount: files.length, testSignalCount: testSignals.length };
}
