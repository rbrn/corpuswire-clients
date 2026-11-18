import type { InventoryScan, InventorySelectionPolicy, RemoteIndexCapabilities, WorkspaceInventory } from "./types.js";
export declare const INVENTORY_VERSION: "workspace-inventory/v1";
/** Scheduling tiers match the server's canonical supported-file registry. */
export declare function ingestionPriority(relativePath: string, fileTypes?: RetrievalFileTypes): 1 | 2 | 3;
export interface WorkspaceScanIncompleteDetails {
    sessionId?: string;
    manifestErrors?: readonly string[];
    manifestSkipped?: number;
}
export declare class WorkspaceScanIncompleteError extends Error {
    readonly code = "scan_incomplete";
    readonly sessionId?: string;
    readonly manifestErrors: readonly string[];
    readonly manifestSkipped?: number;
    constructor(message?: string, details?: WorkspaceScanIncompleteDetails);
}
export declare function canonicalInventoryPath(value: string): string;
export declare function inventorySha256(content: Uint8Array | string): Promise<string>;
export declare function inventoryDigest(entries: ReadonlyArray<readonly [string, string, number]>): Promise<string>;
export declare function selectionPolicyDigest(policy: InventorySelectionPolicy): Promise<string>;
export declare function buildWorkspaceInventory(entries: ReadonlyArray<readonly [string, string, number]>, policy: InventorySelectionPolicy, scan: InventoryScan): Promise<WorkspaceInventory>;
/** Which build files the server indexes, derived from `GET /v1/index/capabilities`. */
export interface RetrievalFileTypes {
    /** True only when the server reports `build_files_enabled: true` (IDX-004). */
    readonly buildFilesEnabled: boolean;
    /** Lowercase file names whose content the server never indexes. */
    readonly discoveryOnlyFilenames: ReadonlySet<string>;
    /** Lowercase extensions (with leading dot) whose content the server never indexes. */
    readonly discoveryOnlyExtensions: readonly string[];
}
/** Derive the retrieval file-type policy from server capabilities; missing fields mean build files are off. */
export declare function retrievalFileTypesFromCapabilities(capabilities: Partial<RemoteIndexCapabilities> | null | undefined): RetrievalFileTypes;
/**
 * Exclude raw discovery metadata, Terraform values and CorpusWire's own diagnostics from source uploads.
 * Without `fileTypes`, or when the server does not index build files, the built-in floor applies.
 */
export declare function isRetrievalExcludedPath(relativePath: string, fileTypes?: RetrievalFileTypes): boolean;
