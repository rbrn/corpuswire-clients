import { inventorySha256 } from "./inventory.js";

export const WORKSPACE_IDENTITY_VERSION = "workspace-identity/v1" as const;

/** Where a resolved workspace identity came from, most explicit first. */
export type WorkspaceIdentitySource =
  | "argument"
  | "env"
  | "host-config"
  | "user-profile"
  | "derived"
  | "none";

export interface WorkspaceIdentity {
  workspaceId?: string;
  repoPath?: string;
  source: WorkspaceIdentitySource;
  /** Workspace root the identity was resolved for, when one was known. */
  root?: string;
  /** Configuration file that supplied the id, for host-config and user-profile. */
  configPath?: string;
}

export interface ResolveWorkspaceIdentityOptions {
  workspaceId?: string;
  repoPath?: string;
  env?: Record<string, string | undefined>;
  root?: string;
  homeDirectory?: string;
  /** The SDK has no runtime dependencies, so file reads are injected; a rejection skips the file. */
  readJson?: (filePath: string) => Promise<unknown>;
}

/**
 * Derive the folder-default identity `cw` uses when nothing is configured.
 * `root` must already be an absolute, resolved path; the path hash keeps two
 * checkouts with the same folder name apart.
 */
export async function deriveWorkspaceId(root: string): Promise<string> {
  const slug = basename(root)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Could not derive a workspace identity; pass --workspace-id explicitly.");
  }
  // Match path.resolve(), which drops trailing separators before `cw` hashes.
  const suffix = (await inventorySha256(root.replace(/(?<=.)[\\/]+$/, ""))).slice(0, 12);
  return `local-docker://${slug}-${suffix}#main`;
}

/** Workspace files `cw init`, the VS Code extension, and MCP hosts write, in lookup order. */
export function workspaceConfigPaths(root: string): string[] {
  return [join(root, ".vscode", "settings.json"), join(root, ".vscode", "mcp.json"), join(root, ".mcp.json")];
}

/** Per-user profile files shared with the VS Code extension. */
export function userProfilePaths(homeDirectory: string): string[] {
  return [join(homeDirectory, ".config", "corpuswire", "vscode-extension.json"),
    join(homeDirectory, ".corpuswire", "vscode-extension.json")];
}

/** Read the workspace id a single configuration document declares, if any. */
export function configuredWorkspaceId(document: unknown, kind: "workspace" | "user"): string | undefined {
  if (!isRecord(document)) return undefined;
  if (kind === "user") return nestedString(document, "remoteIndexing.workspaceId");
  const setting = nestedString(document, "corpuswire.remoteIndexing.workspaceId");
  if (setting) return setting;
  const servers = isRecord(document.servers) ? document.servers
    : isRecord(document.mcpServers) ? document.mcpServers : undefined;
  if (!servers) return undefined;
  for (const name of ["corpuswire-context-engine", "corpuswire"]) {
    const server = servers[name];
    const env = isRecord(server) && isRecord(server.env) ? server.env : undefined;
    const value = env?.CORPUSWIRE_WORKSPACE_ID;
    if (typeof value === "string" && value.trim() && !value.includes("${")) return value.trim();
  }
  return undefined;
}

/**
 * Resolve the workspace a client should query: explicit arguments, then
 * environment, then the workspace's own configuration, then the user profile,
 * then the folder-derived default. Unreadable files are skipped.
 */
export async function resolveWorkspaceIdentity(
  options: ResolveWorkspaceIdentityOptions = {},
): Promise<WorkspaceIdentity> {
  const env = options.env ?? {};
  const workspaceId = trimmed(options.workspaceId);
  const repoPath = trimmed(options.repoPath);
  if (workspaceId || repoPath) return { workspaceId, repoPath, source: "argument" };
  const envWorkspaceId = trimmed(env.CORPUSWIRE_WORKSPACE_ID);
  const envRepoPath = trimmed(env.CORPUSWIRE_REPO_PATH);
  if (envWorkspaceId || envRepoPath) return { workspaceId: envWorkspaceId, repoPath: envRepoPath, source: "env" };

  const root = trimmed(options.root);
  if (!root) return { source: "none" };
  const readJson = options.readJson ?? (() => Promise.reject(new Error("no reader")));
  for (const configPath of workspaceConfigPaths(root)) {
    const id = configuredWorkspaceId(await readJson(configPath).catch(() => undefined), "workspace");
    if (id) return { workspaceId: id, source: "host-config", root, configPath };
  }
  if (options.homeDirectory) {
    for (const configPath of userProfilePaths(options.homeDirectory)) {
      const id = configuredWorkspaceId(await readJson(configPath).catch(() => undefined), "user");
      if (id) return { workspaceId: id, source: "user-profile", root, configPath };
    }
  }
  try {
    return { workspaceId: await deriveWorkspaceId(root), source: "derived", root };
  } catch {
    return { source: "none", root };
  }
}

function basename(root: string): string {
  return root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
}

function join(root: string, ...parts: string[]): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts].join(separator);
}

function nestedString(document: Record<string, unknown>, key: string): string | undefined {
  const flat = document[key];
  if (typeof flat === "string" && flat.trim()) return flat.trim();
  let current: unknown = document;
  for (const part of key.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function trimmed(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse JSON with comments and trailing commas, as VS Code settings and
 * `mcp.json` files allow. String contents are never altered.
 */
export function parseJsonc(source: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
    } else if (char === ",") {
      // Drop a comma that only whitespace or comments separate from a closing bracket.
      let ahead = index + 1;
      while (ahead < source.length) {
        if (/\s/.test(source[ahead])) ahead += 1;
        else if (source[ahead] === "/" && source[ahead + 1] === "/") {
          while (ahead < source.length && source[ahead] !== "\n") ahead += 1;
        } else if (source[ahead] === "/" && source[ahead + 1] === "*") {
          ahead += 2;
          while (ahead < source.length && !(source[ahead] === "*" && source[ahead + 1] === "/")) ahead += 1;
          ahead += 2;
        } else break;
      }
      if (source[ahead] !== "}" && source[ahead] !== "]") output += char;
    } else {
      output += char;
    }
  }
  return JSON.parse(output);
}
