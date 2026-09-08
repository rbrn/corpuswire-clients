import type { InventoryScan, InventorySelectionPolicy, WorkspaceInventory } from "./types.js";

const encoder = new TextEncoder();
export const INVENTORY_VERSION = "workspace-inventory/v1" as const;

export class WorkspaceScanIncompleteError extends Error {
  readonly code = "scan_incomplete";
  constructor(message = "Workspace scan did not complete") {
    super(message);
    this.name = "WorkspaceScanIncompleteError";
  }
}

export function canonicalInventoryPath(value: string): string {
  const path = value.replaceAll("\\", "/");
  if (!path || path.trim() !== path || path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || path.includes("\0") || path.split("/").some((part) => ["", ".", ".."].includes(part))
    || /[\uD800-\uDFFF]/u.test(path)) {
    throw new WorkspaceScanIncompleteError("Inventory requires safe relative paths and valid Unicode");
  }
  return path;
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left), b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export async function inventorySha256(content: Uint8Array | string): Promise<string> {
  const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inventoryDigest(entries: ReadonlyArray<readonly [string, string, number]>): Promise<string> {
  const seen = new Set<string>();
  const normalized = entries.map(([rawPath, hash, size]) => {
    const path = canonicalInventoryPath(rawPath);
    if (seen.has(path) || !/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 0) {
      throw new WorkspaceScanIncompleteError("Inventory requires unique paths, lowercase SHA-256 and safe sizes");
    }
    seen.add(path);
    return [path, hash, size] as const;
  }).sort((a, b) => compareUtf8(a[0], b[0]));
  return inventorySha256(JSON.stringify(normalized));
}

export async function selectionPolicyDigest(policy: InventorySelectionPolicy): Promise<string> {
  const canonical = { ...policy,
    include_globs: [...new Set(policy.include_globs)].sort(compareUtf8),
    exclude_globs: [...new Set(policy.exclude_globs)].sort(compareUtf8),
  };
  return inventorySha256(JSON.stringify(canonical, Object.keys(canonical).sort()));
}

export async function buildWorkspaceInventory(
  entries: ReadonlyArray<readonly [string, string, number]>,
  policy: InventorySelectionPolicy,
  scan: InventoryScan,
): Promise<WorkspaceInventory> {
  if (scan.complete !== true || !Number.isSafeInteger(scan.excludedFileCount) || scan.excludedFileCount < 0
    || !Number.isFinite(Date.parse(scan.startedAt)) || !Number.isFinite(Date.parse(scan.completedAt))
    || Date.parse(scan.startedAt) > Date.parse(scan.completedAt)) {
    throw new WorkspaceScanIncompleteError();
  }
  const bytes = entries.reduce((sum, entry) => sum + entry[2], 0);
  if (!Number.isSafeInteger(bytes)) throw new WorkspaceScanIncompleteError("Inventory byte count overflow");
  return {
    schema_version: INVENTORY_VERSION, scan_complete: true, selection_policy: policy,
    selection_policy_digest: await selectionPolicyDigest(policy), manifest_digest: await inventoryDigest(entries),
    eligible_file_count: entries.length, eligible_source_bytes: bytes, excluded_file_count: scan.excludedFileCount,
    scan_started_at: scan.startedAt, scan_completed_at: scan.completedAt,
  };
}

const DISCOVERY_ONLY_FILENAMES = new Set<string>([".terraform.lock.hcl", "angular.json", "build.gradle", "build.gradle.kts", "bun.lock", "bun.lockb", "dependencies.lock", "gradle.lockfile", "gradle.properties", "jsconfig.json", "libs.versions.toml", "npm-shrinkwrap.json", "nx.json", "package-lock.json", "package.json", "pdm.lock", "pipfile", "pipfile.lock", "pnpm-lock.yaml", "poetry.lock", "pom.xml", "project.json", "pyproject.toml", "settings.gradle", "settings.gradle.kts", "setup.cfg", "setup.py", "uv.lock", "workspace.json", "yarn.lock"]);

/** Exclude raw discovery metadata and Terraform values from source uploads. */
export function isRetrievalExcludedPath(relativePath: string): boolean {
  const name = relativePath.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
  return DISCOVERY_ONLY_FILENAMES.has(name)
    || /\.(gradle|properties|tfvars|xml)$/.test(name)
    || (name.startsWith("tsconfig") && name.endsWith(".json"))
    || /^(requirements|constraints)([-_].*)?\.txt$/.test(name)
    || name.endsWith(".tfvars.json") || name.includes(".tfstate")
    || name === "crash.log" || name === "tfplan"
    || /\.(tfplan|plan)(\.json)?$/.test(name);
}
