// Resolve which CorpusWire workspace a read tool should query when the host
// did not configure one. Explicit arguments and environment always win and are
// passed through unchanged; only an otherwise unscoped request is resolved here.

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS_TIMEOUT_MS = 500;
const NEGATIVE_PROBE_TTL_MS = 60_000;

export function readIdentityResolutionMode(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "env-only" ? "env-only" : "auto";
}

/**
 * @param {object} dependencies
 * @param {(options: object) => Promise<object>} dependencies.resolveIdentity SDK resolveWorkspaceIdentity
 * @param {() => boolean} dependencies.clientSupportsRoots
 * @param {(timeoutMs: number) => Promise<unknown>} dependencies.requestRoots sends roots/list to the host
 * @param {(cwd: string) => Promise<string | undefined>} dependencies.gitToplevel
 * @param {(workspaceId: string) => Promise<boolean>} dependencies.workspaceHasIndex
 */
export function createWorkspaceScope({
  env, cwd, homeDirectory, readJson, resolveIdentity, clientSupportsRoots, requestRoots, gitToplevel,
  workspaceHasIndex, now = () => Date.now(),
}) {
  let rootsPromise;
  const probes = new Map();

  async function discoverRoot() {
    if (clientSupportsRoots()) {
      rootsPromise ??= requestRoots(ROOTS_TIMEOUT_MS).then(fileRoots, () => []);
      const roots = await rootsPromise;
      if (roots.length > 0) return { root: roots[0], source: "mcp-roots", otherRoots: roots.slice(1) };
    }
    const syncRoot = typeof env.CORPUSWIRE_SYNC_ROOT === "string" && env.CORPUSWIRE_SYNC_ROOT.trim();
    if (syncRoot) return { root: path.resolve(syncRoot), source: "sync-root", otherRoots: [] };
    const toplevel = await gitToplevel(cwd).catch(() => undefined);
    if (toplevel) return { root: path.resolve(toplevel), source: "git-toplevel", otherRoots: [] };
    // Hosts that spawn servers from the home directory or "/" have no project folder.
    const resolved = path.resolve(cwd);
    if (resolved === path.parse(resolved).root || resolved === path.resolve(homeDirectory)) return undefined;
    return { root: resolved, source: "cwd", otherRoots: [] };
  }

  async function hasIndex(workspaceId) {
    const cached = probes.get(workspaceId);
    if (cached && (cached.found || now() - cached.at < NEGATIVE_PROBE_TTL_MS)) return cached.found;
    const found = await workspaceHasIndex(workspaceId).catch(() => false);
    probes.set(workspaceId, { found, at: now() });
    return found;
  }

  return {
    /** Forget host roots after notifications/roots/list_changed. */
    invalidateRoots() { rootsPromise = undefined; },

    /** Returns { workspaceId, repoPath, identity } for a read tool's arguments. */
    async resolve(args) {
      const explicit = { workspaceId: args.workspaceId, repoPath: args.repoPath, env };
      if (readIdentityResolutionMode(env.CORPUSWIRE_IDENTITY_RESOLUTION) === "env-only") {
        return scope(await resolveIdentity(explicit));
      }
      const passthrough = await resolveIdentity(explicit);
      if (passthrough.source !== "none") return scope(passthrough);
      const discovered = await discoverRoot();
      if (!discovered) return scope({ source: "none" });
      const identity = await resolveIdentity({ ...explicit, root: discovered.root, homeDirectory, readJson });
      const warnings = discovered.otherRoots.length > 0
        ? [`host offered ${discovered.otherRoots.length + 1} workspace roots; using the first`] : [];
      const annotated = { ...identity, rootSource: discovered.source, warnings };
      if (identity.source === "derived" && !(await hasIndex(identity.workspaceId))) {
        return scope({ source: "backend-default", root: identity.root, rootSource: discovered.source,
          derivedWorkspaceId: identity.workspaceId,
          warnings: [...warnings, `no index found for the folder default ${identity.workspaceId}; using the backend default. Run cw in this folder to index it, or pass workspaceId.`] });
      }
      return scope(annotated);
    },
  };
}

function scope(identity) {
  return { workspaceId: identity.workspaceId, repoPath: identity.repoPath, identity };
}

function fileRoots(result) {
  const roots = Array.isArray(result?.roots) ? result.roots : [];
  const paths = [];
  for (const root of roots) {
    if (typeof root?.uri !== "string" || !root.uri.startsWith("file:")) continue;
    try { paths.push(path.resolve(fileURLToPath(root.uri))); } catch { /* ignore malformed roots */ }
  }
  return paths;
}

/** One header line naming the identity source, plus any warnings. */
export function formatIdentityLines(identity) {
  if (!identity) return [];
  const where = identity.configPath ? ` (${identity.configPath})`
    : identity.root ? ` (${identity.rootSource ?? "root"}: ${identity.root})` : "";
  return [
    `- workspaceIdentity: ${identity.source}${where}`,
    ...(identity.warnings ?? []).map((warning) => `- identityWarning: ${warning}`),
  ];
}
