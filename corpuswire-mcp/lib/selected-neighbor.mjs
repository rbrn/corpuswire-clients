import { createHash } from "node:crypto";

// This module proposes source-bound hits only. The caller must read files
// safely, capture complete delivered runs, and compare both rendered arms.
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validPath = (value) => typeof value === "string" && value.length > 0
  && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.includes("\\")
  && !value.includes("\0")
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const validUtf8 = (value) => typeof value === "string"
  && Buffer.from(value, "utf8").toString("utf8") === value;
const unsupportedLineModel = (value) => /[\r\u0000\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u.test(value);

function sourceLines(value) {
  if (!validUtf8(value) || !value || unsupportedLineModel(value)) return null;
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop(); // A final LF is not an extra physical line.
  return lines.length > 0 ? lines : null;
}

function generationIdentity(metadata, expected) {
  if (!isRecord(metadata)) return null;
  const sourceGeneration = metadata.source_generation;
  if (!Number.isInteger(sourceGeneration) || sourceGeneration < 1) return null;
  const scope = metadata.index_scope;
  if (scope !== null && scope !== undefined) {
    if (!Number.isInteger(expected) || expected < 1
      || sourceGeneration !== expected || !isRecord(scope) || scope.identity_version !== "v2"
      || scope.publication_state !== "published" || scope.generation !== expected) return null;
    return JSON.stringify(scope);
  }
  // Ordinary incremental indexes give each file its own source generation.
  // The complete source hash, projection, and delivered lines are still checked
  // per file; a caller may supply expected for a uniform frozen-v1 publication.
  if (expected !== null && expected !== undefined && sourceGeneration !== expected) return null;
  return "frozen-v1";
}

function selectedHit(hit, sourceTexts, expectedGeneration, scopeIdentity) {
  const metadata = hit?.metadata;
  if (isRecord(metadata?.extras)
    && Object.hasOwn(metadata.extras, "corpuswire_partial_source_line")) {
    return { reason: "partial_source_line" };
  }
  const path = metadata?.source_path;
  const hash = metadata?.source_hash;
  const projection = metadata?.extras?.corpuswire_display_lines;
  if (!validPath(path) || !isDigest(hash) || typeof hit?.chunk_id !== "string"
    || !hit.chunk_id || typeof hit.text !== "string" || !hit.text.trim()) {
    return { reason: "invalid_selected_hit" };
  }
  const scope = generationIdentity(metadata, expectedGeneration);
  if (!scope || (scopeIdentity !== null && scope !== scopeIdentity)) {
    return { reason: "generation_or_scope_mismatch" };
  }
  const sourceText = sourceTexts.get(path);
  const lines = sourceLines(sourceText);
  if (!lines || sha256(sourceText) !== hash) return { reason: "source_mismatch" };
  if (!isRecord(projection)
    || projection.schema_version !== "corpuswire-complete-source-lines/v1"
    || projection.source_hash !== hash
    || !Number.isInteger(projection.start_line) || !Number.isInteger(projection.end_line)
    || projection.start_line < 1 || projection.end_line < projection.start_line
    || projection.end_line > lines.length
    || !Number.isInteger(metadata.start_line) || !Number.isInteger(metadata.end_line)
    || metadata.start_line < 1 || metadata.end_line < metadata.start_line
    || metadata.end_line > lines.length
    || typeof projection.text !== "string" || !projection.text.trim()
    || Buffer.byteLength(projection.text, "utf8") > 16_000
    || projection.text_sha256 !== sha256(projection.text)
    || projection.text.split("\n").length !== projection.end_line - projection.start_line + 1
    || projection.text !== lines.slice(projection.start_line - 1, projection.end_line).join("\n")) {
    return { reason: "projection_mismatch" };
  }
  const chunkText = hit.text.trim();
  const direct = projection.mapping_kind === undefined
    && !projection.text.endsWith("\n")
    && projection.start_line >= metadata.start_line
    && projection.end_line <= metadata.end_line
    && projection.text.includes(chunkText);
  let sourceContext = false;
  if (projection.mapping_kind === "source-context/v1"
    && projection.chunk_text_sha256 === sha256(hit.text)
    && projection.start_line <= metadata.start_line
    && projection.end_line >= metadata.end_line
    && metadata.start_line - projection.start_line <= 3
    && projection.end_line - metadata.end_line <= 3
    && (projection.start_line < metadata.start_line || projection.end_line > metadata.end_line)) {
    const beforeCount = metadata.start_line - projection.start_line;
    const afterCount = projection.end_line - metadata.end_line;
    const projectionLines = projection.text.split("\n");
    const before = projectionLines.slice(0, beforeCount);
    const after = afterCount ? projectionLines.slice(-afterCount) : [];
    const core = projectionLines.slice(beforeCount, projectionLines.length - afterCount).join("\n");
    const markdown = path.toLowerCase().endsWith(".md");
    const permitted = (line) => !line.trim() || (markdown && /^#{1,6}\s+\S/.test(line));
    sourceContext = core.includes(chunkText)
      && before.every(permitted) && after.every(permitted);
  }
  if (!direct && !sourceContext) return { reason: "unsupported_projection" };
  return { path, hash, lines, scope };
}

function sourceTextMap(value) {
  if (value instanceof Map) {
    if (value.size > 5) return null;
    return value;
  }
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 5) return null;
  return new Map(entries);
}

function windowText(window) {
  return window.source.lines.slice(window.start - 1, window.end).join("\n");
}

function excerptChars(windows) {
  return windows.reduce((total, window) => total + windowText(window).length, 0);
}

function projectionFits(windows, proposed, budget) {
  const text = windowText(proposed);
  return text.trim().length > 0
    && Buffer.byteLength(text, "utf8") <= 16_000
    && excerptChars(windows) - windowText(windows[proposed.index]).length + text.length <= budget;
}

function headingOutsideCode(lines, headingLine) {
  let fence = null;
  for (const line of lines.slice(0, headingLine)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character
        && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    // Container fences and HTML require a fuller block parser; do not guess.
    if (/^\s*(?:>|[-+*]\s|\d+[.)]\s).*(`{3,}|~{3,})/.test(line)
      || /<(?:!--|\/?[a-zA-Z][\w-]*(?:\s|\/?>|$)|[!?])/.test(line)) return false;
    if (marker) {
      if (marker[1][0] === "`" && marker[2].includes("`")) return false;
      fence = { character: marker[1][0], length: marker[1].length };
    }
  }
  return fence === null;
}

function headingPrefixStart(window) {
  if (!window.source.path.toLowerCase().endsWith(".md")) return null;
  for (let line = window.start - 1; line >= Math.max(1, window.start - 3); line -= 1) {
    const text = window.source.lines[line - 1];
    if (/^[ \t]*$/.test(text)) continue;
    if (!/^ {0,3}#{1,6}[ \t]+\S/.test(text)) return null;
    return headingOutsideCode(window.source.lines, line) ? line : null;
  }
  return null;
}

function bundledHit(window, queryDigest) {
  const text = windowText(window);
  if (!text.trim() || Buffer.byteLength(text, "utf8") > 16_000) return null;
  const terminalBlank = text.endsWith("\n");
  if (terminalBlank && (window.end <= window.start
    || window.source.lines[window.end - 1] !== "")) return null;
  const hitText = terminalBlank ? text.slice(0, -1) : text;
  if (!hitText.trim()) return null;
  const digest = sha256(JSON.stringify([
    "selected-neighbor-v1", queryDigest, window.source.scope, window.source.path,
    window.source.hash, window.start, window.end, sha256(text), window.hit.chunk_id,
  ]));
  const metadata = window.hit.metadata;
  return {
    ...window.hit,
    chunk_id: `bundle:${digest}`,
    text: hitText,
    metadata: {
      ...metadata,
      start_line: window.start,
      end_line: terminalBlank ? window.end - 1 : window.end,
      extras: {
        ...metadata.extras,
        corpuswire_display_lines: {
          schema_version: "corpuswire-complete-source-lines/v1",
          source_hash: window.source.hash,
          start_line: window.start,
          end_line: window.end,
          text,
          text_sha256: sha256(text),
          ...(terminalBlank ? {
            mapping_kind: "source-context/v1",
            chunk_text_sha256: sha256(hitText),
          } : {}),
        },
        evidence_bundle: {
          schema_version: "evidence_bundle/v1",
          contributing_chunk_ids: [window.hit.chunk_id],
        },
      },
    },
  };
}

/**
 * Propose neighboring physical source lines around authenticated delivered
 * runs. This function performs no I/O and never uses expected-answer labels.
 * The caller must verify source-path filesystem safety and final rendering.
 */
export function planSelectedNeighbor({
  baselineHits, deliveredRuns, sourceTexts, query, maxChars = 12_000, generation,
  maxRadius = 8, headingPrefix = false,
}) {
  const fallback = (reason) => ({ hits: baselineHits, usedNeighbor: false, reason });
  if (!Array.isArray(baselineHits) || baselineHits.length === 0 || baselineHits.length > 5
    || !Array.isArray(deliveredRuns) || deliveredRuns.length > 5
    || typeof query !== "string" || !Number.isInteger(maxChars)
    || (maxRadius !== 8 && maxRadius !== 20)
    || (generation !== null && generation !== undefined
      && (!Number.isInteger(generation) || generation < 1))) return fallback("invalid_input");
  const budget = Math.max(200, Math.min(50_000, maxChars));
  if (budget > 12_000) return fallback("request_exceeds_budget");
  const texts = sourceTextMap(sourceTexts);
  if (!texts) return fallback("invalid_source_texts");
  const selected = new Map();
  const sourceByPath = new Map();
  let scopeIdentity = null;
  for (const [index, hit] of baselineHits.entries()) {
    if (typeof hit?.chunk_id !== "string" || selected.has(hit.chunk_id)) {
      return fallback("duplicate_selected_hit");
    }
    const result = selectedHit(hit, texts, generation, scopeIdentity);
    if (result.reason) return fallback(result.reason);
    scopeIdentity = result.scope;
    const priorHash = sourceByPath.get(result.path);
    if (priorHash && priorHash !== result.hash) return fallback("mixed_source_hash");
    sourceByPath.set(result.path, result.hash);
    selected.set(hit.chunk_id, { hit, index, source: result });
  }
  if (texts.size !== sourceByPath.size
    || [...texts.keys()].some((path) => !sourceByPath.has(path))) {
    return fallback("unexpected_source_text");
  }
  const runsById = new Map();
  let lastIndex = -1;
  for (const run of deliveredRuns) {
    const item = selected.get(run?.chunkId);
    if (!item || item.index <= lastIndex || runsById.has(run.chunkId)
      || !Number.isInteger(run.startLine) || !Number.isInteger(run.endLine)
      || run.startLine < 1 || run.endLine < run.startLine
      || typeof run.text !== "string" || !run.text.trim()
      || run.text.split("\n").length !== run.endLine - run.startLine + 1
      || run.startLine < item.hit.metadata.extras.corpuswire_display_lines.start_line
      || run.endLine > item.hit.metadata.extras.corpuswire_display_lines.end_line
      || run.endLine > item.source.lines.length
      || run.text !== item.source.lines.slice(run.startLine - 1, run.endLine).join("\n")) {
      return fallback("delivered_run_mismatch");
    }
    lastIndex = item.index;
    runsById.set(run.chunkId, run);
  }
  const windows = [];
  for (const item of selected.values()) {
    const run = runsById.get(item.hit.chunk_id);
    if (run) windows.push({
      hit: item.hit, source: item.source, index: windows.length,
      start: run.startLine, end: run.endLine, changed: false,
    });
  }
  if (windows.length === 0) return fallback("no_complete_delivered_lines");
  if (excerptChars(windows) > budget) return fallback("control_exceeds_budget");
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (const window of windows) {
      if (!window.blockedBefore && window.start > 1) {
        const proposal = { ...window, start: window.start - 1 };
        if (projectionFits(windows, proposal, budget)) {
          window.start = proposal.start;
          window.changed = true;
        } else window.blockedBefore = true;
      }
      if (!window.blockedAfter && window.end < window.source.lines.length) {
        const proposal = { ...window, end: window.end + 1 };
        if (projectionFits(windows, proposal, budget)) {
          window.end = proposal.end;
          window.changed = true;
        } else window.blockedAfter = true;
      }
    }
  }
  if (headingPrefix === true && maxRadius === 20) {
    for (const window of windows) {
      const start = headingPrefixStart(window);
      if (start === null) continue;
      const proposal = { ...window, start };
      if (projectionFits(windows, proposal, budget)) {
        window.start = start;
        window.changed = true;
      }
    }
  }
  if (!windows.some((window) => window.changed)) return fallback("no_safe_addition");
  const queryDigest = sha256(query);
  const hits = windows.map((window) => bundledHit(window, queryDigest));
  if (hits.some((hit) => hit === null)) return fallback("unrenderable_window");
  return { hits, usedNeighbor: true, reason: "proposal_requires_renderer_validation" };
}
