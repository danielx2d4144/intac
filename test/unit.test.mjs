// Unit tests for the deterministic plumbing (node --test). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTurn } from "../core/validate.mjs";
import { structuredExtract } from "../core/extract.mjs";
import { lastAssistantTurn } from "../integrations/transcript.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("validateTurn: accepts normal prose", () => {
  assert.equal(validateTurn("I finished the refactor and all tests pass.").ok, true);
});

test("validateTurn: rejects empty / whitespace", () => {
  assert.equal(validateTurn("").ok, false);
  assert.equal(validateTurn("   \n  ").ok, false);
});

test("validateTurn: rejects non-strings and garbage", () => {
  assert.equal(validateTurn(null).ok, false);
  assert.equal(validateTurn(undefined).ok, false);
  assert.equal(validateTurn(42).ok, false);
  assert.equal(validateTurn("��������������������").ok, false);
});

test("structuredExtract: finds files, skips node_modules, caps at 8KB", () => {
  const turn = [
    "Edited src/components/App.tsx and lib/utils/date.ts.",
    "Also touched node_modules/react/index.js (ignore me).",
    "Tests: 10 passed, 0 failed.",
    "Done. " + "x".repeat(10_000),
  ].join("\n\n");
  const { extract, fileCount } = structuredExtract(turn);
  assert.ok(extract.includes("src/components/App.tsx"));
  const filesSection = extract.split("TEST/BUILD SIGNALS")[0];
  assert.ok(!filesSection.includes("node_modules"), "files list must exclude node_modules");
  assert.ok(fileCount >= 2);
  assert.ok(extract.length <= 8 * 1024);
});

test("structuredExtract: captures test signals", () => {
  const { extract } = structuredExtract("Work done.\n\n24 passed, 2 failed\n\nSee above.");
  assert.ok(extract.includes("TEST/BUILD SIGNALS"));
});

test("lastAssistantTurn: skips tool-only entries, reads text blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "av-test-"));
  const p = join(dir, "t.jsonl");
  writeFileSync(p, [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the real answer" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x" }] } }),
    "not json at all {{{",
  ].join("\n"));
  const r = lastAssistantTurn(p);
  assert.equal(r.ok, true);
  assert.equal(r.text, "the real answer");
});

test("lastAssistantTurn: unreadable path degrades cleanly", () => {
  const r = lastAssistantTurn("Z:/definitely/not/here.jsonl");
  assert.equal(r.ok, false);
});
