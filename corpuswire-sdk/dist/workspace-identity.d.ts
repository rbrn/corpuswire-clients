export declare const WORKSPACE_IDENTITY_VERSION: "workspace-identity/v1";
/** Where a resolved workspace identity came from, most explicit first. */
export type WorkspaceIdentitySource = "argument" | "env" | "host-config" | "user-profile" | "derived" | "none";
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
export declare function deriveWorkspaceId(root: string): Promise<string>;
/** Workspace files `cw init`, the VS Code extension, and MCP hosts write, in lookup order. */
export declare function workspaceConfigPaths(root: string): string[];
/** Per-user profile files shared with the VS Code extension. */
export declare function userProfilePaths(homeDirectory: string): string[];
/** Read the workspace id a single configuration document declares, if any. */
export declare function configuredWorkspaceId(document: unknown, kind: "workspace" | "user"): string | undefined;
/**
 * Resolve the workspace a client should query: explicit arguments, then
 * environment, then the workspace's own configuration, then the user profile,
 * then the folder-derived default. Unreadable files are skipped.
 */
export declare function resolveWorkspaceIdentity(options?: ResolveWorkspaceIdentityOptions): Promise<WorkspaceIdentity>;
/**
 * Parse JSON with comments and trailing commas, as VS Code settings and
 * `mcp.json` files allow. String contents are never altered.
 */
export declare function parseJsonc(source: string): unknown;
