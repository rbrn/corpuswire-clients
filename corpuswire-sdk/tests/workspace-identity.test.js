import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { deriveWorkspaceId, resolveWorkspaceIdentity } from "../dist/index.js";

const ROOT = "/work/My Repo";

function reader(files) {
  return async (filePath) => {
    if (!(filePath in files)) throw new Error("missing");
    return files[filePath];
  };
}

test("derived identity matches the cw folder default byte for byte", async () => {
  const suffix = createHash("sha256").update(path.resolve(ROOT)).digest("hex").slice(0, 12);
  assert.equal(await deriveWorkspaceId(ROOT), `local-docker://my-repo-${suffix}#main`);
  assert.equal(await deriveWorkspaceId(`${ROOT}/`), `local-docker://my-repo-${createHash("sha256").update(path.resolve(`${ROOT}/`)).digest("hex").slice(0, 12)}#main`);
  await assert.rejects(deriveWorkspaceId("/"), /Could not derive/);
});

test("explicit arguments and environment win over workspace files", async () => {
  const files = { [`${ROOT}/.vscode/settings.json`]: { "corpuswire.remoteIndexing.workspaceId": "from-settings" } };
  assert.deepEqual(await resolveWorkspaceIdentity({ workspaceId: " arg ", root: ROOT, readJson: reader(files) }),
    { workspaceId: "arg", repoPath: undefined, source: "argument" });
  assert.deepEqual(await resolveWorkspaceIdentity({ repoPath: "/srv/repo", root: ROOT, readJson: reader(files) }),
    { workspaceId: undefined, repoPath: "/srv/repo", source: "argument" });
  assert.deepEqual(await resolveWorkspaceIdentity({ env: { CORPUSWIRE_WORKSPACE_ID: "env-id" }, root: ROOT, readJson: reader(files) }),
    { workspaceId: "env-id", repoPath: undefined, source: "env" });
});

test("workspace files resolve in cw lookup order, nested or flat", async () => {
  const settings = `${ROOT}/.vscode/settings.json`;
  const vscodeMcp = `${ROOT}/.vscode/mcp.json`;
  const claudeMcp = `${ROOT}/.mcp.json`;
  assert.deepEqual(await resolveWorkspaceIdentity({ root: ROOT, readJson: reader({
    [settings]: { corpuswire: { remoteIndexing: { workspaceId: "nested" } } },
    [claudeMcp]: { mcpServers: { "corpuswire-context-engine": { env: { CORPUSWIRE_WORKSPACE_ID: "claude" } } } },
  }) }), { workspaceId: "nested", source: "host-config", root: ROOT, configPath: settings });
  assert.equal((await resolveWorkspaceIdentity({ root: ROOT, readJson: reader({
    [vscodeMcp]: { servers: { corpuswire: { env: { CORPUSWIRE_WORKSPACE_ID: "vscode" } } } },
    [claudeMcp]: { mcpServers: { "corpuswire-context-engine": { env: { CORPUSWIRE_WORKSPACE_ID: "claude" } } } },
  }) })).workspaceId, "vscode");
  assert.equal((await resolveWorkspaceIdentity({ root: ROOT, readJson: reader({
    [claudeMcp]: { mcpServers: { "corpuswire-context-engine": { env: { CORPUSWIRE_WORKSPACE_ID: "claude" } } } },
  }) })).workspaceId, "claude");
});

test("unexpanded host variables, unreadable files and other servers are skipped", async () => {
  const identity = await resolveWorkspaceIdentity({ root: ROOT, readJson: reader({
    [`${ROOT}/.vscode/settings.json`]: "not an object",
    [`${ROOT}/.vscode/mcp.json`]: { servers: { corpuswire: { env: { CORPUSWIRE_WORKSPACE_ID: "${input:workspace}" } } } },
    [`${ROOT}/.mcp.json`]: { mcpServers: { other: { env: { CORPUSWIRE_WORKSPACE_ID: "other" } } } },
  }) });
  assert.equal(identity.source, "derived");
  assert.equal(identity.workspaceId, await deriveWorkspaceId(ROOT));
});

test("user profile applies before the derived default, and no root means none", async () => {
  const profile = "/home/u/.config/corpuswire/vscode-extension.json";
  assert.deepEqual(await resolveWorkspaceIdentity({ root: ROOT, homeDirectory: "/home/u",
    readJson: reader({ [profile]: { remoteIndexing: { workspaceId: "profile-id" } } }) }),
  { workspaceId: "profile-id", source: "user-profile", root: ROOT, configPath: profile });
  assert.deepEqual(await resolveWorkspaceIdentity({}), { source: "none" });
  assert.deepEqual(await resolveWorkspaceIdentity({ root: "/" }), { source: "none", root: "/" });
});

test("Windows roots keep their separator", async () => {
  const seen = [];
  await resolveWorkspaceIdentity({ root: "C:\\work\\repo", readJson: async (filePath) => { seen.push(filePath); throw new Error("x"); } });
  assert.deepEqual(seen, ["C:\\work\\repo\\.vscode\\settings.json", "C:\\work\\repo\\.vscode\\mcp.json", "C:\\work\\repo\\.mcp.json"]);
});

test("parseJsonc accepts comments and trailing commas without touching strings", async () => {
  const { parseJsonc } = await import("../dist/index.js");
  assert.deepEqual(parseJsonc(`{
    // VS Code settings
    "a": "http://x//y", /* block */
    "b": ["/*not a comment*/", "q\\"//", ], // trailing
    "c": { "d": 1, /* last */ },
  }`), { a: "http://x//y", b: ["/*not a comment*/", "q\"//"], c: { d: 1 } });
  assert.throws(() => parseJsonc("{ nope }"));
});
