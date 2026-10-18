/**
 * Read the calibrated-abstention hint of an enhance result (CRP-001 M1.1).
 *
 * The service sets `retrieval_abstained: true` when its abstention model finds
 * the evidence insufficient; it then delivers no chunks and lists up to two
 * `retrieval_closest_paths` as unconfirmed leads. Older services omit both
 * fields, and current ones send `false` and `[]` otherwise; in both cases
 * these helpers return null so renderers can leave their output unchanged.
 */
export interface RetrievalAbstention {
    closestPaths: string[];
}
/** Return the abstention hint, or null unless `retrieval_abstained` is exactly true. */
export declare function retrievalAbstention(result: unknown): RetrievalAbstention | null;
/** One short line for terminals and tool output, or null when the service did not abstain. */
export declare function formatAbstentionHint(result: unknown, options?: {
    quotePaths?: boolean;
}): string | null;
