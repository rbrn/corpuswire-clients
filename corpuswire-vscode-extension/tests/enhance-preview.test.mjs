import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  CHAT_PARTICIPANT_ID,
  ENHANCE_PREVIEW_COMMAND,
  ToggleRegistration,
  fenceText,
  formatChatEnhanceResponse,
  resolveEnhanceSource,
} from "../dist/enhance-preview.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionSource = await readFile(new URL("../dist/extension.js", import.meta.url), "utf8");
const properties = manifest.contributes.configuration.properties;

test("the existing enhance command keeps its id, title and handler", () => {
  const command = manifest.contributes.commands.find((item) => item.command === "corpuswire.enhancePrompt");
  assert.deepEqual(command, { command: "corpuswire.enhancePrompt", title: "CorpusWire: Enhance Prompt" });
  assert.match(extensionSource, /registerCommand\("corpuswire\.enhancePrompt", enhanceSelectedPrompt\)/);
  assert.match(extensionSource, /registerCommand\("corpuswireContextEngine\.enhancePrompt", enhanceSelectedPrompt\)/);
});

test("the preview command is contributed and the keybinding is gated by an off-by-default setting", () => {
  assert.ok(manifest.contributes.commands.some((item) => item.command === ENHANCE_PREVIEW_COMMAND));
  assert.ok(manifest.activationEvents.includes(`onCommand:${ENHANCE_PREVIEW_COMMAND}`));
  const bindings = manifest.contributes.keybindings;
  assert.equal(bindings.length, 2);
  for (const binding of bindings) {
    assert.equal(binding.command, ENHANCE_PREVIEW_COMMAND);
    assert.equal(binding.key, "ctrl+alt+e");
    assert.equal(binding.mac, "cmd+alt+e");
    assert.ok(binding.when.startsWith("config.corpuswire.enhanceKeybinding.enabled && "));
  }
  assert.deepEqual(bindings.map((binding) => binding.args.source), ["selection", "input"]);
  assert.equal(properties["corpuswire.enhanceKeybinding.enabled"].default, false);
});

test("the chat participant is gated by corpuswire.chatParticipant.enabled, off by default", () => {
  assert.deepEqual(manifest.contributes.chatParticipants.map((item) => [item.id, item.name, item.when]), [
    [CHAT_PARTICIPANT_ID, "corpuswire", "config.corpuswire.chatParticipant.enabled"],
  ]);
  assert.equal(properties["corpuswire.chatParticipant.enabled"].default, false);
  // Runtime registration follows the same setting and tolerates hosts without the chat API.
  assert.match(extensionSource, /new ToggleRegistration\(createCorpusWireChatParticipant\)/);
  assert.match(extensionSource, /get\(CHAT_PARTICIPANT_SETTING, false\) === true/);
  assert.match(extensionSource, /typeof vscode\.chat\?\.createChatParticipant !== "function"/);
});

test("the prompt source follows the keybinding argument and falls back to an input box", () => {
  assert.equal(resolveEnhanceSource(undefined, "fix the parser"), "selection");
  assert.equal(resolveEnhanceSource(undefined, "   "), "input");
  assert.equal(resolveEnhanceSource(undefined, undefined), "input");
  assert.equal(resolveEnhanceSource({ source: "selection" }, "fix it"), "selection");
  assert.equal(resolveEnhanceSource({ source: "selection" }, ""), "input");
  // Focus in the chat input or a terminal: never reuse the stale editor selection.
  assert.equal(resolveEnhanceSource({ source: "input" }, "stale selection"), "input");
  assert.equal(resolveEnhanceSource("selection", "fix it"), "selection");
});

test("fences survive backticks in the rewrite", () => {
  assert.equal(fenceText("plain"), "```text\nplain\n```");
  assert.equal(fenceText("a\n"), "```text\na\n```");
  assert.equal(fenceText("use ```js\nx\n``` here"), "````text\nuse ```js\nx\n``` here\n````");
});

test("the chat reply shows the source, quality and the rewrite", () => {
  const grounded = formatChatEnhanceResponse("Do X in `a.ts`.", {
    usedLocalFallback: false, qualityStatus: "grounded", qualityMessage: "3 context sources.",
  });
  assert.equal(grounded, "**Enhanced by CorpusWire.** 3 context sources.\n\n```text\nDo X in `a.ts`.\n```\n");
  const fallback = formatChatEnhanceResponse("Do X.", {
    usedLocalFallback: true, qualityStatus: "weak", qualityMessage: "No context.",
  });
  assert.match(fallback, /^\*\*Enhanced by CorpusWire \(local fallback\)\.\*\* ⚠ No context\./);
});

test("the participant registration follows the setting without duplicates", () => {
  const events = [];
  let created = 0;
  const registration = new ToggleRegistration(() => {
    const id = ++created;
    events.push(`create ${id}`);
    return { dispose: () => events.push(`dispose ${id}`) };
  });
  registration.sync(false);
  registration.sync(true);
  registration.sync(true);
  assert.equal(registration.active, true);
  registration.sync(false);
  registration.sync(false);
  registration.sync(true);
  registration.dispose();
  assert.equal(registration.active, false);
  assert.deepEqual(events, ["create 1", "dispose 1", "create 2", "dispose 2"]);

  // A host without the chat API returns nothing; enabling stays a no-op.
  const unsupported = new ToggleRegistration(() => undefined);
  unsupported.sync(true);
  assert.equal(unsupported.active, false);
  unsupported.dispose();
});
