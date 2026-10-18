// Server-packed evidence (CRP-003 "server-v1"). When the engine runs with
// RETRIEVAL_EVIDENCE_PACKING=server-v1, /query and /v1/enhance responses carry
// `evidence_spans` and a `packing` report. This module decides whether the
// client may trust those spans and renders them in the Auggie layout used by
// the engine harness: `Path: <path>` then one `<line>\t<source line>` row per
// line. Pure functions only; the caller keeps the old selected-neighbor path
// whenever these return false or null.

const SPAN_REASONS = new Set(["selected", "projection", "sibling", "heading"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isLine = (value) => Number.isSafeInteger(value) && value >= 1;
const validPath = (value) => typeof value === "string" && value.length > 0
  && !/[\0\r\n]/.test(value) && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value)
  && !value.includes("\\")
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

/**
 * Reads CORPUSWIRE_SERVER_PACKING. `auto` (default, also when unset or empty)
 * uses server spans when they are present and complete. `off` and any value
 * other than `auto` keep the client-side path, so a typo fails closed.
 */
export function serverPackingMode(env = process.env) {
  const raw = env?.CORPUSWIRE_SERVER_PACKING;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "" || value === "auto" ? "auto" : "off";
}

/**
 * True only when the mode is `auto`, the response carries a `packing` object
 * with `complete === true` and no `fallback_reason`, and `evidence_spans` is a
 * non-empty array. Accepts the result body or a `{ result }` envelope. Span
 * contents are validated separately by renderServerSpans.
 */
export function shouldUseServerPacking(response, env = process.env) {
  if (serverPackingMode(env) !== "auto" || !isRecord(response)) return false;
  const body = !("packing" in response) && isRecord(response.result) ? response.result : response;
  const packing = body.packing;
  if (!isRecord(packing) || packing.complete !== true) return false;
  if (packing.fallback_reason !== null && packing.fallback_reason !== undefined) return false;
  return Array.isArray(body.evidence_spans) && body.evidence_spans.length > 0;
}

function spanLines(span) {
  if (!isRecord(span) || !validPath(span.source_path) || !isDigest(span.source_hash)
    || !isLine(span.start_line) || !isLine(span.end_line) || span.end_line < span.start_line
    || typeof span.text !== "string" || !SPAN_REASONS.has(span.reason)
    || !Array.isArray(span.from_chunk_ids)
    || !span.from_chunk_ids.every((id) => typeof id === "string" && id.length > 0)) return null;
  const lines = span.text.split("\n");
  return lines.length === span.end_line - span.start_line + 1 ? lines : null;
}

/**
 * Validates and groups spans by source_path in first-appearance order,
 * keeping the received order within a file. Returns null when any span is
 * malformed, when one path carries two source hashes, or when spans of one
 * file overlap, so the caller falls back instead of showing doubtful text.
 */
export function groupServerSpans(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return null;
  const groups = new Map();
  for (const span of spans) {
    const lines = spanLines(span);
    if (!lines) return null;
    const group = groups.get(span.source_path);
    if (group) {
      if (group.sourceHash !== span.source_hash) return null;
      if (group.spans.some((other) => span.start_line <= other.end_line
        && other.start_line <= span.end_line)) return null;
      group.spans.push({ ...span, lines });
    } else {
      groups.set(span.source_path, {
        sourcePath: span.source_path,
        sourceHash: span.source_hash,
        spans: [{ ...span, lines }],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Renders spans as `Path: <source_path>\n` followed by `<line>\t<text>` rows
 * and a final newline, one section per span, sections concatenated. Spans are
 * grouped by path (first appearance order) unless `options.groupByPath` is
 * false, in which case the received order is kept. Returns null for empty or
 * invalid input.
 */
export function renderServerSpans(spans, options = {}) {
  const groups = groupServerSpans(spans);
  if (!groups) return null;
  const ordered = options.groupByPath === false
    ? spans.map((span) => ({ ...span, lines: spanLines(span) }))
    : groups.flatMap((group) => group.spans);
  return ordered.map((span) => `Path: ${span.source_path}\n${span.lines
    .map((line, index) => `${span.start_line + index}\t${line}`).join("\n")}\n`).join("");
}

/** `path:start-end` citations in rendered (grouped) order, or [] when invalid. */
export function serverSpanCitations(spans) {
  const groups = groupServerSpans(spans);
  if (!groups) return [];
  return groups.flatMap((group) => group.spans
    .map((span) => `${group.sourcePath}:${span.start_line}-${span.end_line}`));
}
