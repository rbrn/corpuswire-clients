import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { copyToClipboard, createPromptBox, promptEditorEnabled } from "../lib/prompt-box.js";
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
