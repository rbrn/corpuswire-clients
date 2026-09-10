import type { InventoryScan, InventorySelectionPolicy, WorkspaceInventory } from "./types.js";
export declare const INVENTORY_VERSION: "workspace-inventory/v1";
export declare class WorkspaceScanIncompleteError extends Error {
    readonly code = "scan_incomplete";
    constructor(message?: string);
}
export declare function canonicalInventoryPath(value: string): string;
export declare function inventorySha256(content: Uint8Array | string): Promise<string>;
export declare function inventoryDigest(entries: ReadonlyArray<readonly [string, string, number]>): Promise<string>;
export declare function selectionPolicyDigest(policy: InventorySelectionPolicy): Promise<string>;
export declare function buildWorkspaceInventory(entries: ReadonlyArray<readonly [string, string, number]>, policy: InventorySelectionPolicy, scan: InventoryScan): Promise<WorkspaceInventory>;
/** Exclude raw discovery metadata and Terraform values from source uploads. */
export declare function isRetrievalExcludedPath(relativePath: string): boolean;
