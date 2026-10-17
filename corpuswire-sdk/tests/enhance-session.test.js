import test from "node:test";
import assert from "node:assert/strict";

import {
  CorpusWireClient,
  ENHANCE_SESSION_LIMITS,
  toEnhancePayload,
  toEnhanceSessionPayload,
  toWorkspaceRelativeSessionPath,
} from "../dist/index.js";

function enhanceResult() {
  return {
    ok: true,
    request_id: "req-session",
    duration_ms: 3,
    result: {
      user_prompt: "fix it",
      retrieval_query: "fix it",
      retrieval_backend: "corpuswire_qdrant_vector",
      retrieval_warning: null,
      retrieved_chunks: [],
      task_type: "bug_fix",
      task_type_source: "llm",
      task_type_classification_error: null,
      output_mode: "generic",
      context_summary: "summary",
      summary_generation_error: null,
      enhancement_prompt: "rewrite prompt",
      citations: [],
      enhanced_prompt: "enhanced prompt",
      enhancement_backend: "llm",
      generation_error: null,
    },
  };
}

test("toEnhancePayload omits session when absent or empty", () => {
  assert.equal("session" in toEnhancePayload("fix it"), false);
  assert.equal("session" in toEnhancePayload({ prompt: "fix it" }), false);
  assert.equal("session" in toEnhancePayload({ prompt: "fix it", session: {} }), false);
  assert.equal(
    "session" in toEnhancePayload({
      prompt: "fix it",
      session: { conversation: [], recentEdits: [], activeFile: null, selection: null },
    }),
    false,
  );
  assert.equal(
    "session" in toEnhancePayload({
      prompt: "fix it",
      session: { activeFile: "/elsewhere/a.ts", recentEdits: ["../escape.ts", "~/x"] },
    }),
    false,
  );
});

test("toEnhancePayload maps session context to snake_case wire fields", () => {
  const payload = toEnhancePayload({
    repoPath: "/workspace/project",
    prompt: "why does this fail",
    session: {
      conversation: [
        { role: "user", text: "the login test fails" },
        { role: "assistant", text: "which test?" },
      ],
      activeFile: "/workspace/project/src/auth/login.ts",
      selection: { path: "src/auth/login.ts", startLine: 10, endLine: 24, text: "function login() {}" },
      recentEdits: ["/workspace/project/src/auth/session.ts", "./README.md"],
    },
  });

  assert.deepEqual(payload.session, {
    conversation: [
      { role: "user", text: "the login test fails" },
      { role: "assistant", text: "which test?" },
    ],
    active_file: "src/auth/login.ts",
    selection: { path: "src/auth/login.ts", start_line: 10, end_line: 24, text: "function login() {}" },
    recent_edits: ["src/auth/session.ts", "README.md"],
  });
  assert.equal(JSON.stringify(payload).includes("workspaceRoot"), false);
});

test("session payload clamps conversation, texts and recent edits to server caps", () => {
  const conversation = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `turn ${index} ` + "x".repeat(index === 24 ? 9000 : 10),
  }));
  const recentEdits = Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`);
  const payload = toEnhanceSessionPayload({
    conversation,
    recentEdits,
    selection: { path: "a.ts", startLine: 1, endLine: 2, text: "y".repeat(8500) },
  });

  assert.equal(payload.conversation.length, ENHANCE_SESSION_LIMITS.conversationTurns);
  assert.ok(payload.conversation[0].text.startsWith("turn 5 "));
  assert.ok(payload.conversation.at(-1).text.startsWith("turn 24 "));
  assert.equal(payload.conversation.at(-1).text.length, 8000);
  assert.equal(payload.selection.text.length, 8000);
  assert.equal(payload.recent_edits.length, 50);
  assert.equal(payload.recent_edits[0], "src/file-0.ts");
  assert.equal(payload.recent_edits.at(-1), "src/file-49.ts");
});

test("session payload drops invalid turns and normalizes selections", () => {
  const payload = toEnhanceSessionPayload(
    {
      conversation: [
        { role: "system", text: "ignored" },
        { role: "user", text: "   " },
        { role: "user", text: "kept" },
      ],
      selection: { path: "C:\\Repo\\src\\main.ts", startLine: 9, endLine: 3 },
      recentEdits: ["src/a.ts", "src\\a.ts", "c:/repo/src/b.ts", "D:/other/c.ts"],
    },
    "C:\\Repo",
  );
  assert.deepEqual(payload, {
    conversation: [{ role: "user", text: "kept" }],
    selection: { path: "src/main.ts", start_line: 3, end_line: 9 },
    recent_edits: ["src/a.ts", "src/b.ts"],
  });

  assert.equal(
    toEnhanceSessionPayload({ selection: { path: "a.ts", startLine: 0, endLine: 2 } }),
    undefined,
  );
});

test("toWorkspaceRelativeSessionPath only returns workspace-relative POSIX paths", () => {
  const root = "/home/dev/project";
  assert.equal(toWorkspaceRelativeSessionPath("/home/dev/project/src/a.ts", root), "src/a.ts");
  assert.equal(toWorkspaceRelativeSessionPath("/home/dev/project/", root), null);
  assert.equal(toWorkspaceRelativeSessionPath("/home/dev/project-other/a.ts", root), null);
  assert.equal(toWorkspaceRelativeSessionPath("/home/dev/project/../secret", root), null);
  assert.equal(toWorkspaceRelativeSessionPath("/abs/path.ts"), null);
  assert.equal(toWorkspaceRelativeSessionPath("~/notes.md", root), null);
  assert.equal(toWorkspaceRelativeSessionPath("../up.ts", root), null);
  assert.equal(toWorkspaceRelativeSessionPath("src/../lib/a.ts", root), "lib/a.ts");
  assert.equal(toWorkspaceRelativeSessionPath("./src/./a.ts", root), "src/a.ts");
  assert.equal(toWorkspaceRelativeSessionPath("C:relative.ts", root), null);
  assert.equal(toWorkspaceRelativeSessionPath("a".repeat(1025), root), null);
  assert.equal(toWorkspaceRelativeSessionPath(42, root), null);
});

test("session workspaceRoot overrides repoPath for path relativization", () => {
  const payload = toEnhancePayload({
    repoPath: "/server/side/path",
    prompt: "p",
    session: { workspaceRoot: "/local/ws", activeFile: "/local/ws/pkg/index.js" },
  });
  assert.deepEqual(payload.session, { active_file: "pkg/index.js" });
});

test("enhance sends session only when supplied", async () => {
  const bodies = [];
  const client = new CorpusWireClient({
    baseUrl: "http://example.test",
    fetchFn: async (_input, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => enhanceResult(),
        text: async () => JSON.stringify(enhanceResult()),
      };
    },
  });

  await client.enhance({ prompt: "fix it" });
  await client.enhance({
    prompt: "fix it",
    repoPath: "/ws",
    session: { activeFile: "/ws/src/x.py", recentEdits: [] },
  });

  assert.equal("session" in bodies[0], false);
  assert.deepEqual(bodies[1].session, { active_file: "src/x.py" });
});
