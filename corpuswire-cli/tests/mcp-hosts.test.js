import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorkspaceId } from "@corpuswire/sdk";

import { parseCliArgs, runCliCommand, runMcpCommand } from "../lib/cli.js";
import { codexTomlBlock, findCodexSection, mcpHandshake, parseMcpArgs, serverEntry } from "../lib/mcp-hosts.js";

const CLI_BIN = fileURLToPath(new URL("../bin/corpuswire.js", import.meta.url));

async function sandbox(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cw-mcp-hosts-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  await mkdir(home);
  await mkdir(repo);
  const output = [];
  const run = (argv, extra = {}) => runMcpCommand(argv, { env: {}, cwd: repo, homeDirectory: home,
    write: (line) => output.push(line), now: () => new Date("2026-10-18T10:00:00Z"), ...extra });
  return { dir, home, repo, output, run };
}

test("argument parsing applies per-host scopes and rejects unsupported ones", () => {
  assert.equal(parseMcpArgs(["install", "--host", "claude-code"]).scope, "project");
  assert.equal(parseMcpArgs(["install", "--host", "codex"]).scope, "user");
  assert.throws(() => parseMcpArgs(["install", "--host", "codex", "--scope", "project"]), /use --scope user/);
  assert.throws(() => parseMcpArgs(["install", "--host", "cursor"]), /--host must be one of/);
  assert.throws(() => parseMcpArgs(["launch"]), /Unknown cw mcp command/);
});

test("entries launch cw mcp serve, carry no credentials, and suit each host", () => {
  assert.deepEqual(serverEntry("claude-code", { scope: "user", apiBaseUrl: "http://127.0.0.1:18080" }),
    { type: "stdio", command: "cw", args: ["mcp", "serve"] });
  assert.deepEqual(serverEntry("vscode", { scope: "project", workspaceId: "w", apiBaseUrl: "https://cw.example/" }), {
    type: "stdio", command: "cw", args: ["mcp", "serve"], cwd: "${workspaceFolder}",
    env: { CORPUSWIRE_BASE_URL: "https://cw.example/", CORPUSWIRE_WORKSPACE_ID: "w", CORPUSWIRE_TOOL_PROFILE: "core" },
  });
  assert.equal(serverEntry("copilot-cli", { scope: "user" }).type, "local");
  assert.equal(serverEntry("copilot-cli", { scope: "user", workspaceId: "w" }).env.CORPUSWIRE_WORKSPACE_ID, undefined);
});

test("project install merges into .mcp.json, is idempotent, and keeps other servers", async (t) => {
  const box = await sandbox(t);
  await writeFile(path.join(box.repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  await mkdir(path.join(box.repo, ".vscode"));
  await writeFile(path.join(box.repo, ".vscode", "settings.json"),
    '{ // cw init\n "corpuswire.remoteIndexing.workspaceId": "local-docker://repo#main", }');
  const first = await box.run(["install", "--host", "claude-code"]);
  assert.equal(first.changed, true);
  assert.match(first.backupPath, /\.mcp\.json\.bak-2026-10-18T10-00-00-000Z$/);
  const written = JSON.parse(await readFile(path.join(box.repo, ".mcp.json"), "utf8"));
  assert.deepEqual(written.mcpServers.other, { command: "x" });
  assert.deepEqual(written.mcpServers["corpuswire-context-engine"], { type: "stdio", command: "cw", args: ["mcp", "serve"],
    env: { CORPUSWIRE_WORKSPACE_ID: "local-docker://repo#main" } });
  assert.equal((await box.run(["install", "--host", "claude-code"])).unchanged, true);
});

test("install refuses foreign entries and commented files unless forced", async (t) => {
  const box = await sandbox(t);
  const config = path.join(box.repo, ".vscode", "mcp.json");
  await mkdir(path.dirname(config));
  await writeFile(config, JSON.stringify({ servers: { "corpuswire-context-engine": { command: "node", args: ["/old/checkout/mcp.js"] } } }));
  await assert.rejects(box.run(["install", "--host", "vscode"]), /without cw mcp serve; rerun with --force/);
  await box.run(["install", "--host", "vscode", "--force"]);
  assert.equal(JSON.parse(await readFile(config, "utf8")).servers["corpuswire-context-engine"].command, "cw");
  await writeFile(config, '{\n  // mine\n  "servers": {}\n}\n');
  await assert.rejects(box.run(["install", "--host", "vscode"]), /comments that rewriting would drop/);
  const before = await readFile(config, "utf8");
  const dry = await box.run(["install", "--host", "vscode", "--dry-run", "--force"]);
  assert.match(dry.preview, /"cw"/);
  assert.equal(await readFile(config, "utf8"), before);
});

test("user-scope Claude Code and VS Code print the command instead of editing their profiles", async (t) => {
  const box = await sandbox(t);
  const claude = await box.run(["install", "--host", "claude-code", "--scope", "user", "--api-base-url", "http://127.0.0.1:8000"]);
  assert.equal(claude.instruction,
    "claude mcp add --scope user -e CORPUSWIRE_BASE_URL=http://127.0.0.1:8000 corpuswire-context-engine -- cw mcp serve");
  const vscode = await box.run(["install", "--host", "vscode", "--scope", "user"]);
  assert.match(vscode.instruction, /MCP: Open User Configuration/);
  assert.deepEqual(await readdir(box.home), []);
});

test("Copilot CLI install writes the per-user config", async (t) => {
  const box = await sandbox(t);
  await box.run(["install", "--host", "copilot-cli"]);
  const written = JSON.parse(await readFile(path.join(box.home, ".copilot", "mcp-config.json"), "utf8"));
  assert.deepEqual(written.mcpServers["corpuswire-context-engine"], { type: "local", command: "cw", args: ["mcp", "serve"],
    env: { CORPUSWIRE_TOOL_PROFILE: "core" }, tools: ["*"] });
});

test("Codex install appends, replaces only its own tables, and refuses foreign ones", async (t) => {
  const box = await sandbox(t);
  const config = path.join(box.home, ".codex", "config.toml");
  await mkdir(path.dirname(config));
  await writeFile(config, 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n');
  await box.run(["install", "--host", "codex"]);
  let text = await readFile(config, "utf8");
  assert.equal(text, 'model = "x"\n\n[mcp_servers.other]\ncommand = "y"\n\n[mcp_servers.corpuswire-context-engine]\ncommand = "cw"\nargs = ["mcp", "serve"]\n');
  assert.equal((await box.run(["install", "--host", "codex"])).unchanged, true);
  await box.run(["install", "--host", "codex", "--api-base-url", "http://127.0.0.1:8000"]);
  text = await readFile(config, "utf8");
  assert.match(text, /\[mcp_servers\.corpuswire-context-engine\.env\]\nCORPUSWIRE_BASE_URL = "http:\/\/127\.0\.0\.1:8000"\n$/);
  assert.equal(text.match(/\[mcp_servers\.corpuswire-context-engine\]/g).length, 1);
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "y"/);

  await writeFile(config, '[mcp_servers.corpuswire-context-engine]\ncommand = "node"\nargs = ["/Users/me/old/run.sh"]\n\n[profiles.fast]\nmodel = "z"\n');
  await assert.rejects(box.run(["install", "--host", "codex"]), /rerun with --force/);
  await box.run(["install", "--host", "codex", "--force"]);
  assert.equal(await readFile(config, "utf8"),
    '[mcp_servers.corpuswire-context-engine]\ncommand = "cw"\nargs = ["mcp", "serve"]\n\n[profiles.fast]\nmodel = "z"\n');
});

test("Codex section detection matches quoted names and sub-tables only", () => {
  const block = codexTomlBlock({ command: "cw", args: ["mcp", "serve"], env: { A: "1" } });
  const section = findCodexSection(`x = 1\n${block}\n[mcp_servers.corpuswire-context-engine-old]\ncommand = "q"\n`);
  assert.equal(section.ours, true);
  assert.deepEqual(section.lines.slice(section.start, section.end),
    ["[mcp_servers.corpuswire-context-engine]", 'command = "cw"', 'args = ["mcp", "serve"]', "",
      "[mcp_servers.corpuswire-context-engine.env]", 'A = "1"']);
  assert.ok(findCodexSection('[mcp_servers."corpuswire-context-engine"]\ncommand = "cw"\n'));
  assert.equal(findCodexSection('[mcp_servers.corpuswire-context-engine-old]\n'), undefined);
});

test("doctor reports a missing config, then a ready one, without running a real host", async (t) => {
  const box = await sandbox(t);
  const missing = await box.run(["doctor", "--host", "claude-code"]);
  assert.equal(missing.ok, false);
  assert.match(missing.checks[0].message, /run cw mcp install --host claude-code/);
  await box.run(["install", "--host", "claude-code", "--workspace-id", "w1"]);
  const seen = [];
  const ready = await box.run(["doctor", "--host", "claude-code"], {
    commandResolvable: async () => true,
    handshake: async (entry, options) => { seen.push([entry.command, options.env.CORPUSWIRE_WORKSPACE_ID]); return { ok: true, serverVersion: "v", protocolVersion: "p", tools: 23 }; },
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(seen, [["cw", "w1"]]);
  assert.deepEqual(ready.checks.map((check) => `${check.name}:${check.status}`),
    ["config:ok", "launcher:ok", "command:ok", "handshake:ok", "workspace:ok"]);
  assert.match(ready.checks.at(-1).message, /^w1 \(env\)$/);
});

test("cw mcp serve answers a real MCP handshake", async () => {
  const result = await mcpHandshake({ command: process.execPath, args: [CLI_BIN, "mcp", "serve"] },
    { cwd: tmpdir(), env: { ...process.env, CORPUSWIRE_BASE_URL: "http://127.0.0.1:9" } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.tools >= 20);
});

test("cw search queries the folder's configured or indexed workspace", async (t) => {
  const box = await sandbox(t);
  const requests = [];
  const client = (indexed) => ({
    queryRaw: async (request) => { requests.push(request.workspaceId ?? null); return { result: { retrieved_chunks: [] } }; },
    diagnoseWorkspace: async ({ workspaceId }) => ({ can_retrieve: indexed, point_count: indexed ? 1 : 0, workspaceId }),
  });
  const notes = [];
  const search = (indexed) => runCliCommand(parseCliArgs(["search", "where"], {}, box.repo),
    { client: client(indexed), write: () => {}, writeError: (line) => notes.push(line), homeDirectory: box.home });
  const derived = await deriveWorkspaceId(box.repo);
  await search(true);
  await search(false);
  await mkdir(path.join(box.repo, ".vscode"));
  await writeFile(path.join(box.repo, ".vscode", "settings.json"), JSON.stringify({ "corpuswire.remoteIndexing.workspaceId": "configured" }));
  await search(false);
  await runCliCommand(parseCliArgs(["search", "where", "--workspace-id", "explicit"], {}, box.repo),
    { client: client(false), write: () => {}, homeDirectory: box.home });
  assert.deepEqual(requests, [derived, null, "configured", "explicit"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /has no index yet; using the backend default workspace/);
});
