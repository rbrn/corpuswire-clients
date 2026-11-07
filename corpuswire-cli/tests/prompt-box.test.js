import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyToClipboard, createPromptBox, displayPath, promptEditorEnabled, promptSaveDirectory, savePromptToFile } from "../lib/prompt-box.js";
import { runCliCommand } from "../lib/cli.js";

function fakeTerminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  input.setEncoding = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 60;
  output.chunks = [];
  output.write = (chunk) => { output.chunks.push(String(chunk)); return true; };
  output.text = () => output.chunks.join("").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return { input, output };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Ctrl+P replaces the draft with the rewrite and Enter accepts it", async () => {
  const { input, output } = fakeTerminal();
  const accepted = [];
  const box = createPromptBox({
    input, output, color: false,
    enhance: async (draft) => `Rewritten: ${draft}`,
    accept: (draft) => { accepted.push(draft); return "done"; },
  });
  box.start();
  assert.equal(input.isRaw, true);
  assert.match(output.text(), /Describe a task/);
  input.emit("data", "fix the sync lease bug");
  input.emit("data", "\u0010");
  await tick();
  assert.equal(box.draft, "Rewritten: fix the sync lease bug");
  input.emit("data", "\r");
  await tick();
  assert.deepEqual(accepted, ["Rewritten: fix the sync lease bug"]);
  assert.equal(box.draft, "");
  box.stop();
  assert.equal(input.isRaw, false);
});

test("Ctrl+J, Shift+Enter and bracketed paste add new lines instead of submitting", async () => {
  const { input, output } = fakeTerminal();
  const accepted = [];
  const box = createPromptBox({ input, output, color: false, enhance: async () => "x", accept: (d) => { accepted.push(d); } });
  box.start();
  input.emit("data", "one\ntwo\u001b[13;2uthree");
  input.emit("data", "\u001b[200~four\rfive\u001b[201~");
  assert.equal(box.draft, "one\ntwo\nthreefour\nfive");
  assert.deepEqual(accepted, []);
  box.stop();
});

test("editing during a rewrite keeps the user's edits", async () => {
  const { input, output } = fakeTerminal();
  let release;
  const box = createPromptBox({
    input, output, color: false,
    enhance: () => new Promise((resolve) => { release = resolve; }),
    accept: () => {},
  });
  box.start();
  input.emit("data", "fix renewLease in sync.js");
  input.emit("data", "\u0010");
  input.emit("data", "!");
  release("rewritten");
  await tick();
  assert.equal(box.draft, "fix renewLease in sync.js!");
  assert.match(output.text(), /Kept your edits/);
  box.stop();
});

test("Ctrl+C clears a draft first and exits only on an empty draft", () => {
  const { input, output } = fakeTerminal();
  let exits = 0;
  const box = createPromptBox({ input, output, color: false, enhance: async () => "x", accept: () => {}, onExit: () => { exits += 1; } });
  box.start();
  input.emit("data", "something");
  input.emit("data", "\u0003");
  assert.equal(box.draft, "");
  assert.equal(exits, 0);
  input.emit("data", "\u0003");
  assert.equal(exits, 1);
  assert.equal(box.active, false);
});

test("? on an empty draft lists shortcuts; inside text it is typed", () => {
  const { input, output } = fakeTerminal();
  const box = createPromptBox({ input, output, color: false, enhance: async () => "x", accept: () => {} });
  box.start();
  input.emit("data", "?");
  assert.equal(box.draft, "");
  assert.match(output.text(), /delete the previous word/);
  input.emit("data", "why?");
  assert.equal(box.draft, "why?");
  box.stop();
});

test("a broad request asks one scope question before rewriting", async () => {
  const { input, output } = fakeTerminal();
  const sent = [];
  const box = createPromptBox({ input, output, color: false, enhance: async (d) => { sent.push(d); return "ok"; }, accept: () => {} });
  box.start();
  input.emit("data", "How does logging work?");
  input.emit("data", "\u0010");
  assert.deepEqual(sent, []);
  assert.match(output.text(), /Which part of logging/);
  input.emit("data", "HTTP access logs\r");
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /How does logging work\?\n\nUser clarification:\nHTTP access logs/);
  box.stop();
});

test("log() and progress writes print above the box", () => {
  const { input, output } = fakeTerminal();
  const box = createPromptBox({ input, output, color: false, enhance: async () => "x", accept: () => {} });
  box.start();
  box.log("Index verified (3 files).");
  box.raw("\r\u001b[2Kscanning 40%");
  assert.match(output.text(), /Index verified \(3 files\)\./);
  assert.match(output.text(), /scanning 40%/);
  box.stop();
});

test("the kill switch turns the editor off", () => {
  assert.equal(promptEditorEnabled({}), true);
  assert.equal(promptEditorEnabled({ CORPUSWIRE_CLI_PROMPT_EDITOR: "off" }), false);
  assert.equal(promptEditorEnabled({ CORPUSWIRE_CLI_PROMPT_EDITOR: "0" }), false);
});

test("copyToClipboard tries the next tool and reports none when all fail", async () => {
  const tried = [];
  const spawnFn = (command) => {
    tried.push(command);
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => child.emit("close", command === "xclip" ? 0 : 1));
    return child;
  };
  assert.equal(await copyToClipboard("hi", { platform: "linux", spawnFn }), "xclip");
  assert.deepEqual(tried, ["wl-copy", "xclip"]);
  const failing = () => { throw new Error("ENOENT"); };
  assert.equal(await copyToClipboard("hi", { platform: "darwin", spawnFn: failing }), null);
});

test("cw enhance without a prompt opens the editor and prints the accepted draft", async () => {
  const { input, output } = fakeTerminal();
  const written = [];
  const client = { enhanceRaw: async ({ prompt }) => ({ result: { enhanced_prompt: `Grounded: ${prompt}` } }) };
  const run = runCliCommand(
    { command: "enhance", promptParts: [], outputMode: "generic", workspaceId: "local-docker://x#main", apiBaseUrl: "http://127.0.0.1:18080" },
    { client, write: (line) => written.push(line), promptInput: input, promptOutput: output, env: {} },
  );
  await tick();
  input.emit("data", "add a test for renewLease in sync.js");
  input.emit("data", "\u0010");
  await tick();
  await tick();
  input.emit("data", "\r");
  const result = await run;
  assert.equal(result.ok, true);
  assert.deepEqual(written, ["Grounded: add a test for renewLease in sync.js"]);
});

test("cw enhance without a prompt still errors when the editor is off", async () => {
  const { input, output } = fakeTerminal();
  await assert.rejects(
    runCliCommand(
      { command: "enhance", promptParts: [], outputMode: "generic", workspaceId: "w", apiBaseUrl: "http://127.0.0.1:18080" },
      { client: {}, write: () => {}, promptInput: input, promptOutput: output, env: { CORPUSWIRE_CLI_PROMPT_EDITOR: "off" } },
    ),
    /Missing prompt/,
  );
});

test("a long draft scrolls inside the box instead of overflowing the screen", () => {
  const { input, output } = fakeTerminal();
  output.rows = 12;
  const box = createPromptBox({ input, output, color: false, enhance: async () => "x", accept: () => {}, status: "Index ready" });
  box.start();
  box.setDraft(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
  output.chunks.length = 0;
  box.render();
  const frame = output.chunks.find((chunk) => chunk.includes("line 29"));
  assert.ok(frame, "the cursor line is visible");
  assert.ok(frame.split("\r\n").length <= 12, `frame has ${frame.split("\r\n").length} rows`);
  assert.match(frame, /more lines/);
  box.stop();
});

test("Ctrl+S saves the draft, keeps it in the box and shows the path", async () => {
  const { input, output } = fakeTerminal();
  const saved = [];
  const box = createPromptBox({
    input, output, color: false, enhance: async () => "x", accept: () => {},
    save: async (draft) => { saved.push(draft); return path.join(process.cwd(), ".corpuswire", "prompts", "prompt-1.md"); },
  });
  box.start();
  assert.match(output.text(), /Ctrl\+S save/);
  input.emit("data", "\u0013");
  await tick();
  assert.match(output.text(), /Type a task first/);
  assert.deepEqual(saved, []);
  input.emit("data", "line one\nline two");
  input.emit("data", "\u0013");
  await tick();
  assert.deepEqual(saved, ["line one\nline two"]);
  assert.equal(box.draft, "line one\nline two");
  assert.match(output.text(), /Saved to \.corpuswire\/prompts\/prompt-1\.md/);
  box.setDraft("");
  input.emit("data", "?");
  assert.match(output.text(), /Ctrl\+S\s+save the draft to a file/);
  box.stop();
});

test("Ctrl+S reports a failed save and saves the original draft during a scope question", async () => {
  const { input, output } = fakeTerminal();
  const saved = [];
  let fail = true;
  const box = createPromptBox({
    input, output, color: false, enhance: async () => "x", accept: () => {},
    assessPrompt: () => ({ status: "needs_clarification", questions: [{ question: "Which part?" }] }),
    save: async (draft) => { if (fail) throw new Error("disk full"); saved.push(draft); return "/tmp/p.md"; },
  });
  box.start();
  input.emit("data", "How does logging work");
  input.emit("data", "\u0013");
  await tick();
  assert.match(output.text(), /Save failed: disk full/);
  fail = false;
  input.emit("data", "\u0010");
  input.emit("data", "the sync");
  input.emit("data", "\u0013");
  await tick();
  assert.deepEqual(saved, ["How does logging work"]);
  box.stop();
});

test("savePromptToFile writes owner-only files under .corpuswire/prompts and never overwrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cw-prompt-save-"));
  try {
    const now = new Date(2026, 10, 7, 18, 1, 2);
    const first = await savePromptToFile("fix the lease\n\n", { env: {}, root, now });
    const second = await savePromptToFile("second", { env: {}, root, now });
    assert.equal(first, path.join(root, ".corpuswire", "prompts", "prompt-20261107-180102.md"));
    assert.equal(second, path.join(root, ".corpuswire", "prompts", "prompt-20261107-180102-2.md"));
    assert.equal(await readFile(first, "utf8"), "fix the lease\n");
    assert.equal(await readFile(path.join(root, ".corpuswire", ".gitignore"), "utf8"), "*\n");
    if (process.platform !== "win32") assert.equal((await stat(first)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CORPUSWIRE_PROMPT_DIR picks the folder, with ~ expanded and no .gitignore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cw-prompt-dir-"));
  try {
    assert.deepEqual(promptSaveDirectory({ env: { CORPUSWIRE_PROMPT_DIR: "~/notes" }, root, home: "/home/me" }),
      { directory: "/home/me/notes", configured: true });
    const saved = await savePromptToFile("hi", { env: { CORPUSWIRE_PROMPT_DIR: path.join(root, "out") }, root, now: new Date(2026, 0, 2, 3, 4, 5) });
    assert.equal(saved, path.join(root, "out", "prompt-20260102-030405.md"));
    await assert.rejects(stat(path.join(root, ".gitignore")));
    await assert.rejects(stat(path.join(root, ".corpuswire")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("displayPath shortens to the current folder or home", () => {
  assert.equal(displayPath("/w/repo/.corpuswire/prompts/a.md", { cwd: "/w/repo", home: "/h" }), ".corpuswire/prompts/a.md");
  assert.equal(displayPath("/h/notes/a.md", { cwd: "/w/repo", home: "/h" }), "~/notes/a.md");
  assert.equal(displayPath("/elsewhere/a.md", { cwd: "/w/repo", home: "/h" }), "/elsewhere/a.md");
});

test("cw enhance without a prompt saves with Ctrl+S into the workspace folder", async () => {
  const { input, output } = fakeTerminal();
  const calls = [];
  const run = runCliCommand(
    { command: "enhance", promptParts: [], outputMode: "generic", workspaceId: "local-docker://x#main", apiBaseUrl: "http://127.0.0.1:18080", sourceRoot: "/w/repo" },
    { client: {}, write: () => {}, promptInput: input, promptOutput: output, env: { CORPUSWIRE_PROMPT_DIR: "/p" },
      savePrompt: async (text, options) => { calls.push({ text, ...options }); return "/p/prompt.md"; } },
  );
  await tick();
  input.emit("data", "draft text");
  input.emit("data", "\u0013");
  await tick();
  assert.deepEqual(calls, [{ text: "draft text", env: { CORPUSWIRE_PROMPT_DIR: "/p" }, root: path.resolve("/w/repo") }]);
  assert.match(output.text(), /Saved to \/p\/prompt\.md/);
  input.emit("data", "\u0003");
  input.emit("data", "\u0003");
  const result = await run;
  assert.equal(result.cancelled, true);
});
