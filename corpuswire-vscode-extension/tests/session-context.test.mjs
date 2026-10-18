import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  MAX_RECENT_EDITS,
  RecentEditsTracker,
  buildEditorSession,
  capSessionText,
  isLegacySessionRejection,
  workspaceRelativePath,
} from "../dist/session-context.js";
import { toEnhancePayload } from "@corpuswire/sdk";

test("recent edits keep the last 50 saves per workspace folder, most recent first", () => {
  const tracker = new RecentEditsTracker();
  for (let index = 0; index < 60; index += 1) {
    tracker.record("file:///ws", `src/file-${index}.ts`);
  }
  tracker.record("file:///ws", "src/file-30.ts");
  tracker.record("file:///other", "README.md");

  const list = tracker.list("file:///ws");
  assert.equal(list.length, MAX_RECENT_EDITS);
  assert.equal(list[0], "src/file-30.ts");
  assert.equal(list[1], "src/file-59.ts");
  assert.equal(list.filter((entry) => entry === "src/file-30.ts").length, 1);
  assert.deepEqual(tracker.list("file:///other"), ["README.md"]);
  assert.deepEqual(tracker.list("file:///unknown"), []);

  tracker.forget("file:///other", "README.md");
  assert.deepEqual(tracker.list("file:///other"), []);
});

test("workspaceRelativePath only accepts files strictly inside the folder", () => {
  assert.equal(workspaceRelativePath("/home/dev/ws", "/home/dev/ws/src/a.ts"), "src/a.ts");
  assert.equal(workspaceRelativePath("/home/dev/ws/", "/home/dev/ws/src/a.ts"), "src/a.ts");
  assert.equal(workspaceRelativePath("/home/dev/ws", "/home/dev/ws-other/a.ts"), undefined);
  assert.equal(workspaceRelativePath("/home/dev/ws", "/home/dev/ws"), undefined);
  assert.equal(workspaceRelativePath("/home/dev/ws", "/home/dev/ws/../secret"), undefined);
  assert.equal(workspaceRelativePath("/c:/Users/dev/ws", "/c:/Users/dev/ws/src/main.ts"), "src/main.ts");
});

test("buildEditorSession converts zero-based selections to 1-based inclusive lines", () => {
  assert.deepEqual(
    buildEditorSession({
      activeFile: "src/a.ts",
      selection: { startLine: 4, endLine: 9, endCharacter: 3, text: "code" },
      recentEdits: ["src/b.ts"],
    }),
    {
      activeFile: "src/a.ts",
      selection: { path: "src/a.ts", startLine: 5, endLine: 10, text: "code" },
      recentEdits: ["src/b.ts"],
    },
  );
  // A selection ending at column 0 of the next line does not include that line.
  assert.deepEqual(
    buildEditorSession({
      activeFile: "src/a.ts",
      selection: { startLine: 4, endLine: 6, endCharacter: 0, text: "two\nlines\n" },
    }).selection,
    { path: "src/a.ts", startLine: 5, endLine: 6, text: "two\nlines\n" },
  );
  // Text from excluded files arrives empty and is not sent.
  assert.deepEqual(
    buildEditorSession({
      activeFile: ".env",
      selection: { startLine: 0, endLine: 0, endCharacter: 5, text: "" },
    }).selection,
    { path: ".env", startLine: 1, endLine: 1 },
  );
});

test("buildEditorSession caps text and omits an empty session", () => {
  assert.equal(buildEditorSession({}), undefined);
  assert.equal(buildEditorSession({ recentEdits: [] }), undefined);
  assert.equal(
    buildEditorSession({ selection: { startLine: 0, endLine: 1, endCharacter: 1, text: "x" } }),
    undefined,
    "a selection without a workspace-relative file is not sent",
  );
  const session = buildEditorSession({
    activeFile: "a.ts",
    selection: { startLine: 0, endLine: 0, endCharacter: 1, text: "y".repeat(9000) },
    recentEdits: Array.from({ length: 70 }, (_, index) => `f${index}.ts`),
  });
  assert.equal(session.selection.text.length, 8000);
  assert.equal(session.recentEdits.length, 50);
  assert.equal(capSessionText("ab\uD83D\uDE00", 3), "ab");
});

test("editor session reaches the wire as snake_case and is omitted when absent", () => {
  const session = buildEditorSession({
    activeFile: "src/a.ts",
    selection: { startLine: 1, endLine: 2, endCharacter: 4, text: "body" },
    recentEdits: ["src/b.ts"],
  });
  assert.deepEqual(toEnhancePayload({ prompt: "p", session }).session, {
    active_file: "src/a.ts",
    selection: { path: "src/a.ts", start_line: 2, end_line: 3, text: "body" },
    recent_edits: ["src/b.ts"],
  });
  assert.equal("session" in toEnhancePayload({ prompt: "p" }), false);
});

test("extension sends editor session for both enhance flows and tracks saves in memory", async () => {
  const source = await readFile(new URL("../dist/extension.js", import.meta.url), "utf8");
  assert.match(source, /buildEnhancementRequest\(prompt, settings, session\)/);
  assert.match(source, /buildEnhancementRequest\(selectedText, settings, session\)/);
  // The session comes from the editor captured with the settings, collected
  // before the authentication await, never from a later activeTextEditor read.
  for (const [prompt, flow] of [["prompt", /async function runPromptEnhancement[\s\S]*?buildEnhancementRequest\(prompt/], ["selectedText", /async function enhanceSelectedPrompt[\s\S]*?buildEnhancementRequest\(selectedText/]]) {
    const body = source.match(flow)?.[0] ?? "";
    const collect = body.indexOf(`collectEditorSession(${prompt}, editor)`);
    const auth = body.indexOf("buildAuthenticatedServiceHeaders(");
    assert.ok(collect >= 0 && auth > collect, `${prompt} flow collects the session before awaiting authentication`);
  }
  const helper = source.match(/function collectEditorSession\([\s\S]*?\n}/)?.[0] ?? "";
  assert.doesNotMatch(helper, /activeTextEditor/);
  assert.match(source, /vscode\.workspace\.onDidSaveTextDocument\(recordSavedDocument\)/);
  assert.doesNotMatch(source, /globalState|workspaceState/);
});

test("only a legacy server's rejection of the session key itself triggers the retry", () => {
  const legacy = JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "session"], msg: "Extra inputs are not permitted" }] });
  assert.equal(isLegacySessionRejection(422, legacy), true);
  assert.equal(isLegacySessionRejection(400, legacy), false);
  const invalidPath = JSON.stringify({ detail: [{ type: "value_error", loc: ["body", "session", "active_file"] }] });
  assert.equal(isLegacySessionRejection(422, invalidPath), false);
  const nestedExtra = JSON.stringify({ detail: [{ type: "extra_forbidden", loc: ["body", "session", "unknown"] }] });
  assert.equal(isLegacySessionRejection(422, nestedExtra), false);
  assert.equal(isLegacySessionRejection(422, "not json"), false);
  assert.equal(isLegacySessionRejection(422, ""), false);
});

test("extension retries without session only through the legacy-server guard", async () => {
  const source = await readFile(new URL("../dist/extension.js", import.meta.url), "utf8");
  const start = source.indexOf("async function enhanceAllowingLegacyServer(");
  const end = source.indexOf("\nasync function enhancePromptWithFallback(", start);
  assert.ok(start > 0 && end > start);
  const helper = source.slice(start, end);
  assert.match(helper, /isLegacySessionRejection\(error\.status, error\.responseBody\)/);
  const fallback = source.slice(end, source.indexOf("\nfunction ", end + 1));
  assert.doesNotMatch(fallback, /client\.enhance\(/);
});
