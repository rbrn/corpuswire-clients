// `cw mcp serve|install|doctor`: one stable MCP entry point for every host, and
// the per-host configuration that points at it. Generated configs never contain
// credentials; `cw mcp serve` resolves them at launch like other cw commands.
import { parseJsonc, resolveWorkspaceIdentity } from "@corpuswire/sdk";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MCP_SERVER_NAME = "corpuswire-context-engine";
export const MCP_HOSTS = Object.freeze(["claude-code", "vscode", "copilot-cli", "codex"]);
const DEFAULT_SCOPE = Object.freeze({ "claude-code": "project", vscode: "project", "copilot-cli": "user", codex: "user" });
const DEFAULT_BASE_URL = "http://127.0.0.1:18080";
const HANDSHAKE_TIMEOUT_MS = 15_000;

export const MCP_HELP = `cw mcp

Usage:
  cw mcp serve                       Run the CorpusWire MCP server on stdio
  cw mcp install --host <host>       Write this host's MCP configuration
  cw mcp doctor --host <host>        Check the configuration and run a handshake

Hosts: ${MCP_HOSTS.join(", ")}

Options:
  --scope <project|user>   project: this folder (claude-code, vscode); user: your profile
                           (copilot-cli, codex; prints the command for claude-code and vscode)
  --source-root <path>     Workspace folder. Default: current folder
  --workspace-id <id>      Workspace id for a project-scope config. Default: this folder's
  --api-base-url <url>     Service URL written into the config when not the default
  --dry-run                Print the change without writing
  --force                  Replace an entry cw did not write, or a file with comments
  --json                   Print a JSON result
`;

export function parseMcpArgs(argv, env = process.env, currentFolder = process.cwd()) {
  const [subcommand, ...rest] = argv;
  const options = {
    subcommand, host: undefined, scope: undefined, sourceRoot: currentFolder, workspaceId: env.CORPUSWIRE_WORKSPACE_ID || "",
    apiBaseUrl: env.CORPUSWIRE_BASE_URL || DEFAULT_BASE_URL, dryRun: false, force: false, json: false,
  };
  const value = (index, flag) => {
    const next = rest[index + 1];
    if (!next || next.startsWith("-")) throw new Error(`Missing value for ${flag}`);
    return next;
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--host": options.host = value(index, arg); index += 1; break;
      case "--scope": options.scope = value(index, arg); index += 1; break;
      case "--source-root": options.sourceRoot = path.resolve(value(index, arg)); index += 1; break;
      case "--workspace-id": options.workspaceId = value(index, arg); index += 1; break;
      case "--api-base-url": options.apiBaseUrl = value(index, arg); index += 1; break;
      case "--dry-run": options.dryRun = true; break;
      case "--force": options.force = true; break;
      case "--json": options.json = true; break;
      default: throw new Error(`Unknown option for cw mcp: ${arg}`);
    }
  }
  if (!["serve", "install", "doctor", "help", undefined].includes(subcommand)) {
    throw new Error(`Unknown cw mcp command: ${subcommand}. Expected serve, install or doctor.`);
  }
  if (["install", "doctor"].includes(subcommand)) {
    if (!MCP_HOSTS.includes(options.host)) throw new Error(`--host must be one of: ${MCP_HOSTS.join(", ")}.`);
    options.scope ??= DEFAULT_SCOPE[options.host];
    if (!["project", "user"].includes(options.scope)) throw new Error("--scope must be project or user.");
    if (["copilot-cli", "codex"].includes(options.host) && options.scope !== "user") {
      throw new Error(`${options.host} reads a per-user configuration; use --scope user.`);
    }
  }
  return options;
}

/** The server entry each host gets: `cw mcp serve`, never a checkout path. */
export function serverEntry(host, { scope, workspaceId, apiBaseUrl }) {
  const env = {};
  if (apiBaseUrl && apiBaseUrl.replace(/\/+$/, "") !== DEFAULT_BASE_URL) env.CORPUSWIRE_BASE_URL = apiBaseUrl;
  // A user-scope server serves many folders, so it resolves the workspace per folder.
  if (scope === "project" && workspaceId) env.CORPUSWIRE_WORKSPACE_ID = workspaceId;
  if (host === "copilot-cli" || host === "vscode") env.CORPUSWIRE_TOOL_PROFILE = "core";
  const base = { command: "cw", args: ["mcp", "serve"], ...(Object.keys(env).length ? { env } : {}) };
  if (host === "vscode") return { type: "stdio", ...base, cwd: "${workspaceFolder}" };
  if (host === "copilot-cli") return { type: "local", ...base, tools: ["*"] };
  return { type: "stdio", ...base };
}

export function isCwEntry(entry) {
  return entry?.command === "cw" && Array.isArray(entry.args) && entry.args[0] === "mcp" && entry.args[1] === "serve";
}

/** Where a host keeps its configuration for a scope, or the command to run instead of writing one. */
export function hostTarget(host, scope, { sourceRoot, homeDirectory }) {
  if (host === "claude-code") {
    return scope === "project"
      ? { kind: "json", path: path.join(sourceRoot, ".mcp.json"), container: "mcpServers" }
      : { kind: "command", readPath: path.join(homeDirectory, ".claude.json"), container: "mcpServers" };
  }
  if (host === "vscode") {
    return scope === "project"
      ? { kind: "json", path: path.join(sourceRoot, ".vscode", "mcp.json"), container: "servers" }
      : { kind: "command" };
  }
  if (host === "copilot-cli") {
    return { kind: "json", path: path.join(homeDirectory, ".copilot", "mcp-config.json"), container: "mcpServers" };
  }
  return { kind: "toml", path: path.join(homeDirectory, ".codex", "config.toml") };
}

function manualInstruction(host, entry) {
  if (host === "claude-code") {
    const env = Object.entries(entry.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return ["claude", "mcp", "add", "--scope", "user", ...env, MCP_SERVER_NAME, "--", entry.command, ...entry.args].join(" ");
  }
  return `In VS Code run "MCP: Open User Configuration" and add under "servers":\n${JSON.stringify({ [MCP_SERVER_NAME]: entry }, null, 2)}`;
}

export function codexTomlBlock(entry) {
  const lines = [`[mcp_servers.${MCP_SERVER_NAME}]`, `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`];
  if (entry.env) {
    lines.push("", `[mcp_servers.${MCP_SERVER_NAME}.env]`,
      ...Object.entries(entry.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Find this server's tables in a Codex config.toml: [start, end) line indexes, or undefined. */
export function findCodexSection(text) {
  const lines = text.split("\n");
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${MCP_SERVER_NAME}"|${MCP_SERVER_NAME})(?:\\.[^\\]]+)?\\s*\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && (!/^\s*\[/.test(lines[end]) || header.test(lines[end]))) end += 1;
  // Leave blank lines that separate the next table where they are.
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  const body = lines.slice(start, end).join("\n");
  const ours = /^\s*command\s*=\s*"cw"\s*$/m.test(body) && /^\s*args\s*=\s*\[\s*"mcp"\s*,\s*"serve"\s*\]/m.test(body);
  return { start, end, ours, lines };
}

async function readText(filePath) {
  try { return await readFile(filePath, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function backup(filePath, now) {
  const target = `${filePath}.bak-${now().toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(filePath, target);
  return target;
}

export async function installHostConfig(options, dependencies = {}) {
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const now = dependencies.now ?? (() => new Date());
  // A folder default is left out: the server derives the same id itself, and
  // baking it in would stop the fallback to the backend default before indexing.
  let workspaceId;
  if (options.scope === "project") {
    const identity = options.workspaceId ? undefined : await resolveWorkspaceIdentity({ env: {}, root: options.sourceRoot,
      homeDirectory, readJson: async (filePath) => parseJsonc(await readFile(filePath, "utf8")) });
    workspaceId = options.workspaceId || (identity.source === "derived" ? undefined : identity.workspaceId);
  }
  const entry = serverEntry(options.host, { scope: options.scope, workspaceId, apiBaseUrl: options.apiBaseUrl });
  const target = hostTarget(options.host, options.scope, { sourceRoot: options.sourceRoot, homeDirectory });
  const result = { schema_version: "mcp-install/v1", host: options.host, scope: options.scope, entry, changed: false,
    dryRun: options.dryRun };
  if (target.kind === "command") return { ...result, instruction: manualInstruction(options.host, entry) };
  result.path = target.path;

  const existing = await readText(target.path);
  let next;
  if (target.kind === "toml") {
    const block = codexTomlBlock(entry);
    const section = existing === undefined ? undefined : findCodexSection(existing);
    if (section && !section.ours && !options.force) {
      throw new Error(`${target.path} already defines ${MCP_SERVER_NAME} without cw mcp serve; rerun with --force to replace it.`);
    }
    if (section) {
      const current = `${section.lines.slice(section.start, section.end).join("\n")}\n`;
      if (current === block) return { ...result, unchanged: true };
      next = [...section.lines.slice(0, section.start), ...block.trimEnd().split("\n"), ...section.lines.slice(section.end)].join("\n");
    } else {
      next = existing ? `${existing.replace(/\n*$/, "\n")}\n${block}` : block;
    }
  } else {
    let document = {};
    if (existing !== undefined) {
      try { document = JSON.parse(existing); }
      catch {
        document = parseJsonc(existing);
        if (!options.force) throw new Error(`${target.path} has comments that rewriting would drop; rerun with --force (a backup is kept).`);
      }
    }
    const servers = document[target.container] ?? {};
    const current = servers[MCP_SERVER_NAME];
    if (current && !isCwEntry(current) && !options.force) {
      throw new Error(`${target.path} already defines ${MCP_SERVER_NAME} without cw mcp serve; rerun with --force to replace it.`);
    }
    if (current && JSON.stringify(current) === JSON.stringify(entry)) return { ...result, unchanged: true };
    next = `${JSON.stringify({ ...document, [target.container]: { ...servers, [MCP_SERVER_NAME]: entry } }, null, 2)}\n`;
  }
  if (options.dryRun) return { ...result, changed: true, preview: next };
  await mkdir(path.dirname(target.path), { recursive: true });
  const backupPath = existing === undefined ? undefined : await backup(target.path, now);
  await writeFile(target.path, next);
  return { ...result, changed: true, ...(backupPath ? { backupPath } : {}) };
}

/** Read the configured entry for a host back, for doctor. */
export async function readHostEntry(host, scope, { sourceRoot, homeDirectory }) {
  const target = hostTarget(host, scope, { sourceRoot, homeDirectory });
  if (host === "vscode" && scope === "user") return { target, unsupported: "VS Code keeps user MCP servers in its own profile; check them with \"MCP: List Servers\"." };
  const filePath = target.path ?? target.readPath;
  const text = await readText(filePath);
  if (text === undefined) return { target, filePath };
  if (target.kind === "toml") {
    const section = findCodexSection(text);
    if (!section) return { target, filePath };
    const body = section.lines.slice(section.start, section.end).join("\n");
    const command = body.match(/^\s*command\s*=\s*"([^"]*)"/m)?.[1];
    const args = [...(body.match(/^\s*args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    const envBody = body.split(/^\s*\[.*\.env\]\s*$/m)[1] ?? "";
    const env = Object.fromEntries([...envBody.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((match) => [match[1], match[2]]));
    return { target, filePath, entry: { command, args, env } };
  }
  const document = parseJsonc(text);
  return { target, filePath, entry: document?.[target.container]?.[MCP_SERVER_NAME] };
}

async function commandResolvable(command, env) {
  if (!command) return false;
  if (path.isAbsolute(command)) return access(command, fsConstants.X_OK).then(() => true, () => false);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (await access(path.join(directory, command + extension), fsConstants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

/** Start the configured server and run initialize + tools/list, as a host would. */
export function mcpHandshake(entry, { cwd, env, timeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(entry.command, entry.args ?? [], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    const responses = {};
    const finish = (outcome) => { clearTimeout(timer); child.kill(); resolve(outcome); };
    const timer = setTimeout(() => finish({ ok: false, error: `no handshake response within ${timeoutMs} ms` }), timeoutMs);
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish({ ok: false, error: "server wrote non-JSON to stdout" }); }
        responses[message.id] = message;
        if (responses[1] && responses[2]) {
          finish({ ok: Boolean(responses[1].result && responses[2].result), protocolVersion: responses[1].result?.protocolVersion,
            serverVersion: responses[1].result?.serverInfo?.version, tools: responses[2].result?.tools?.length ?? 0 });
        }
      }
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "cw-mcp-doctor", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

export async function doctorHostConfig(options, dependencies = {}) {
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const env = dependencies.env ?? process.env;
  const checks = [];
  const { entry, filePath, unsupported } = await readHostEntry(options.host, options.scope, { sourceRoot: options.sourceRoot, homeDirectory });
  if (unsupported) return { schema_version: "mcp-doctor/v1", host: options.host, scope: options.scope, ok: false, checks: [{ name: "config", status: "skipped", message: unsupported }] };
  checks.push(entry ? { name: "config", status: "ok", message: `${MCP_SERVER_NAME} in ${filePath}` }
    : { name: "config", status: "error", message: `${MCP_SERVER_NAME} not found in ${filePath}; run cw mcp install --host ${options.host}` });
  if (entry) {
    checks.push(isCwEntry(entry) ? { name: "launcher", status: "ok", message: "uses cw mcp serve" }
      : { name: "launcher", status: "warning", message: `runs ${entry.command} ${(entry.args ?? []).join(" ")}; a checkout path breaks when the folder moves` });
    const resolvable = await (dependencies.commandResolvable ?? commandResolvable)(entry.command, env);
    checks.push(resolvable ? { name: "command", status: "ok", message: `${entry.command} found` }
      : { name: "command", status: "error", message: `${entry.command} is not on PATH or not executable` });
    const entryEnv = Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) =>
      [key, String(value).replaceAll("${workspaceFolder}", options.sourceRoot)]));
    if (resolvable) {
      const handshake = await (dependencies.handshake ?? mcpHandshake)(entry, { cwd: options.sourceRoot, env: { ...env, ...entryEnv } });
      checks.push(handshake.ok
        ? { name: "handshake", status: "ok", message: `server ${handshake.serverVersion}, protocol ${handshake.protocolVersion}, ${handshake.tools} tools` }
        : { name: "handshake", status: "error", message: handshake.error ?? "initialize or tools/list failed" });
    }
    const identity = await resolveWorkspaceIdentity({ env: { ...env, ...entryEnv }, root: options.sourceRoot, homeDirectory,
      readJson: async (file) => parseJsonc(await readFile(file, "utf8")) });
    checks.push({ name: "workspace", status: identity.workspaceId || identity.repoPath ? "ok" : "warning",
      message: `${identity.workspaceId ?? identity.repoPath ?? "backend default"} (${identity.source})` });
  }
  return { schema_version: "mcp-doctor/v1", host: options.host, scope: options.scope,
    ok: checks.every((check) => check.status !== "error"), checks };
}

/** The bundled MCP server: an explicit path, the installed package, or the sibling package in a clients checkout. */
export async function locateMcpServer(env = process.env) {
  if (env.CORPUSWIRE_MCP_SERVER_PATH) return pathToFileURL(path.resolve(env.CORPUSWIRE_MCP_SERVER_PATH)).href;
  try { return import.meta.resolve("@corpuswire/mcp"); } catch { /* not installed */ }
  const sibling = fileURLToPath(new URL("../../corpuswire-mcp/bin/corpuswire-mcp.js", import.meta.url));
  if (await access(sibling).then(() => true, () => false)) return pathToFileURL(sibling).href;
  throw new Error("CorpusWire MCP server not found. Install @corpuswire/mcp or set CORPUSWIRE_MCP_SERVER_PATH.");
}

export function formatMcpResult(result) {
  if (result.schema_version === "mcp-doctor/v1") {
    return [`cw mcp doctor (${result.host}, ${result.scope}): ${result.ok ? "ready" : "not ready"}`,
      ...result.checks.map((check) => `- ${check.name}: ${check.status}: ${check.message}`)].join("\n");
  }
  if (result.instruction) return `Run this to register CorpusWire for ${result.host} (${result.scope} scope):\n${result.instruction}`;
  if (result.unchanged) return `Already configured: ${result.path}`;
  if (result.dryRun) return `Would write ${result.path}:\n${result.preview}`;
  return `Configured ${result.host}: ${result.path}${result.backupPath ? `\nBackup: ${result.backupPath}` : ""}`;
}
