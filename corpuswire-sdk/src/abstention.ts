/**
 * Read the calibrated-abstention hint of an enhance result (CRP-001 M1.1).
 *
 * The service sets `retrieval_abstained: true` when its abstention model finds
 * the evidence insufficient; it then delivers no chunks and lists up to two
 * `retrieval_closest_paths` as unconfirmed leads. Older services omit both
 * fields, and current ones send `false` and `[]` otherwise; in both cases
 * these helpers return null so renderers can leave their output unchanged.
 */

const MAX_HINT_PATHS = 5;
const MAX_HINT_PATH_LENGTH = 300;

export interface RetrievalAbstention {
  closestPaths: string[];
}

/** Return the abstention hint, or null unless `retrieval_abstained` is exactly true. */
export function retrievalAbstention(result: unknown): RetrievalAbstention | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { retrieval_abstained?: unknown; retrieval_closest_paths?: unknown };
  if (record.retrieval_abstained !== true) return null;
  const raw = Array.isArray(record.retrieval_closest_paths) ? record.retrieval_closest_paths : [];
  const closestPaths: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    // eslint-disable-next-line no-control-regex
    const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_HINT_PATH_LENGTH);
    if (cleaned && !closestPaths.includes(cleaned)) closestPaths.push(cleaned);
    if (closestPaths.length >= MAX_HINT_PATHS) break;
  }
  return { closestPaths };
}

/** One short line for terminals and tool output, or null when the service did not abstain. */
export function formatAbstentionHint(result: unknown, options: { quotePaths?: boolean } = {}): string | null {
  const abstention = retrievalAbstention(result);
  if (!abstention) return null;
  const paths = abstention.closestPaths.map((value) => (options.quotePaths ? `\`${value}\`` : value));
  return `Not found in the index; closest files, not confirmed: ${paths.length > 0 ? paths.join(", ") : "none"}.`;
}
