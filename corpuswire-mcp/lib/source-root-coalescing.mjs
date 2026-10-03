import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const sourcePath = (value) => typeof value === "string" && value.length > 0
  && !value.startsWith("/") && !value.includes("\\")
  && value.split("/").every((part) => part && part !== "." && part !== "..");

function sourceLines(text) {
  if (typeof text !== "string" || !text || text.includes("\r")) return null;
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.length > 0 ? lines : null;
}

function validFence(fence) {
  if (!fence || Array.isArray(fence)
    || fence.schema_version !== "rqt110-frozen-publication-fence/v1"
    || fence.overlay_id !== null
    || !Number.isInteger(fence.manifest_revision) || fence.manifest_revision < 1
    || !Number.isInteger(fence.generation) || fence.generation < 1
    || !digest(fence.source_snapshot_digest) || !digest(fence.publication_digest)) return false;
  return ["tenant_id", "served_workspace_id", "storage_workspace_id", "collection", "repository_id"]
    .every((field) => typeof fence[field] === "string" && fence[field].length > 0);
}

function validHit(hit, fence) {
  const metadata = hit?.metadata;
  if (metadata?.extras && Object.hasOwn(metadata.extras, "corpuswire_partial_source_line")) return false;
  if (!metadata || !sourcePath(metadata.source_path) || !digest(metadata.source_hash)
    || metadata.index_scope != null || metadata.source_generation !== fence.generation
    || typeof hit.chunk_id !== "string" || !hit.chunk_id
    || !Number.isInteger(metadata.start_line) || !Number.isInteger(metadata.end_line)
    || metadata.start_line < 1 || metadata.end_line < metadata.start_line) return false;
  for (const [field, fenceField] of [
    ["tenant_id", "tenant_id"], ["workspace_id", "served_workspace_id"],
    ["storage_workspace_id", "storage_workspace_id"], ["collection", "collection"],
    ["repository_id", "repository_id"], ["source_snapshot_digest", "source_snapshot_digest"],
    ["publication_digest", "publication_digest"], ["manifest_revision", "manifest_revision"],
    ["overlay_id", "overlay_id"],
  ]) {
    if (Object.hasOwn(metadata, field) && metadata[field] !== fence[fenceField]) return false;
  }
  return true;
}

function validPerFileHit(hit, generation) {
  const metadata = hit?.metadata;
  if (metadata?.extras && Object.hasOwn(metadata.extras, "corpuswire_partial_source_line")) return false;
  return metadata && sourcePath(metadata.source_path) && digest(metadata.source_hash)
    && metadata.index_scope == null && metadata.source_generation === generation
    && typeof hit.chunk_id === "string" && hit.chunk_id.length > 0
    && Number.isInteger(metadata.start_line) && Number.isInteger(metadata.end_line)
    && metadata.start_line >= 1 && metadata.end_line >= metadata.start_line;
}

function exactRun(run, hit, lines) {
  if (run?.chunkId !== hit.chunk_id
    || !Number.isInteger(run.startLine) || !Number.isInteger(run.endLine)
    || run.startLine < 1 || run.endLine < run.startLine
    || run.endLine > lines.length || typeof run.text !== "string"
    || !run.text.trim()) return false;
  return run.text === lines.slice(run.startLine - 1, run.endLine).join("\n");
}

function proposedHit(window, identityTag) {
  const text = window.lines.slice(window.start - 1, window.end).join("\n");
  if (!text.trim()) return null;
  const terminalLf = text.endsWith("\n");
  if (terminalLf && (window.end <= window.start || window.lines[window.end - 1] !== "")) {
    return null;
  }
  const hitText = terminalLf ? text.slice(0, -1) : text;
  const ids = window.contributors.map((item) => item.chunk_id);
  const source = window.contributors[0];
  const id = sha256(JSON.stringify([
    "source-root-coalescing/v1", identityTag,
    window.path, window.hash, window.start, window.end, sha256(text), ids,
  ]));
  return {
    ...source,
    chunk_id: `bundle:${id}`,
    text: hitText,
    metadata: {
      ...source.metadata,
      start_line: window.start,
      end_line: terminalLf ? window.end - 1 : window.end,
      extras: {
        ...source.metadata.extras,
        corpuswire_display_lines: {
          schema_version: "corpuswire-complete-source-lines/v1",
          source_hash: window.hash,
          start_line: window.start,
          end_line: window.end,
          text,
          text_sha256: sha256(text),
          ...(terminalLf ? {
            mapping_kind: "source-context/v1",
            chunk_text_sha256: sha256(hitText),
          } : {}),
        },
        evidence_bundle: {
          schema_version: "evidence_bundle/v1",
          contributing_chunk_ids: ids,
        },
      },
    },
  };
}

/**
 * Pure proposal over already delivered, source-authenticated control lines.
 * In publication mode the caller must authenticate the publication fence.
 * In per-file mode the caller must supply source bytes read and SHA-verified
 * from the configured root. Neither mode is a publication attestation by
 * itself. The caller must render both arms canonically and preserve all
 * delivered control lines before accepting a proposal.
 * No candidate pool, answer labels, query terms, or source reads occur here.
 */
export function planSourceRootCoalescing({
  baselineHits, deliveredRuns, sourceRecords, publicationFence,
  proofMode = "publication/v1", topK = 5, maxChars = 12_000, maxRadius = 20,
}) {
  const fallback = (reason) => ({
    hits: baselineHits, fallbackHits: baselineHits, usedPacking: false,
    reason, excerptChars: null, addedLineCount: 0,
  });
  const perFile = proofMode === "per-file-source/v1";
  if ((perFile ? publicationFence != null : proofMode !== "publication/v1"
      || !validFence(publicationFence))
    || !Array.isArray(baselineHits) || baselineHits.length < 2 || baselineHits.length > 5
    || !Array.isArray(deliveredRuns) || deliveredRuns.length !== baselineHits.length
    || !Array.isArray(sourceRecords) || sourceRecords.length > 5
    || !Number.isInteger(topK) || topK < baselineHits.length || topK > 5
    || !Number.isInteger(maxChars) || maxChars < 200 || maxChars > 12_000
    || !Number.isInteger(maxRadius) || maxRadius < 0 || maxRadius > 20) {
    return fallback("invalid_input_or_fence");
  }
  const sources = new Map();
  for (const record of sourceRecords) {
    if (!sourcePath(record?.path) || !digest(record?.sourceHash)
      || typeof record.text !== "string" || sha256(record.text) !== record.sourceHash
      || sources.has(record.path)) return fallback("source_proof_invalid");
    const lines = sourceLines(record.text);
    if (!lines) return fallback("source_encoding_unsupported");
    sources.set(record.path, { hash: record.sourceHash, lines });
  }
  const windows = [];
  const selectedIds = new Set();
  const generation = baselineHits[0]?.metadata?.source_generation;
  if (perFile && (!Number.isInteger(generation) || generation < 1)) {
    return fallback("selected_identity_invalid");
  }
  for (const [index, hit] of baselineHits.entries()) {
    if (!(perFile ? validPerFileHit(hit, generation) : validHit(hit, publicationFence))
      || selectedIds.has(hit.chunk_id)) {
      return fallback("selected_identity_invalid");
    }
    selectedIds.add(hit.chunk_id);
    const source = sources.get(hit.metadata.source_path);
    if (!source || source.hash !== hit.metadata.source_hash
      || !exactRun(deliveredRuns[index], hit, source.lines)) {
      return fallback("delivered_source_mismatch");
    }
    windows.push({
      order: index, path: hit.metadata.source_path, hash: hit.metadata.source_hash,
      start: deliveredRuns[index].startLine, end: deliveredRuns[index].endLine,
      lines: source.lines, contributors: [hit], merged: false,
    });
  }
  const protectedChars = windows.reduce(
    (count, item) => count + item.lines.slice(item.start - 1, item.end).join("\n").length, 0,
  );
  if (protectedChars > maxChars) return fallback("control_exceeds_budget");
  // Merge only physically adjacent/overlapping spans from the exact same
  // source. The frozen source bytes resolve overlap; no fabricated line is used.
  let changed = !perFile;
  while (changed) {
    changed = false;
    for (let left = 0; left < windows.length && !changed; left += 1) {
      for (let right = left + 1; right < windows.length; right += 1) {
        const a = windows[left];
        const b = windows[right];
        if (a.path !== b.path || a.hash !== b.hash
          || a.start > b.end + 1 || b.start > a.end + 1) continue;
        a.start = Math.min(a.start, b.start);
        a.end = Math.max(a.end, b.end);
        a.contributors.push(...b.contributors);
        a.merged = true;
        windows.splice(right, 1);
        changed = true;
        break;
      }
    }
  }
  const chars = () => windows.reduce(
    (count, item) => count + item.lines.slice(item.start - 1, item.end).join("\n").length, 0,
  );
  if (chars() > maxChars) return fallback("merged_control_exceeds_budget");
  let addedLineCount = 0;
  let completedShortSource = false;
  if (perFile) {
    // One already-selected short file may be completed from verified source
    // bytes. This is label-blind and never adds a new file or candidate.
    for (const window of [...windows].sort((a, b) => a.order - b.order)) {
      const same = windows.filter((item) => item.path === window.path && item.hash === window.hash);
      if (same.length < 2) continue;
      const fullText = window.lines.join("\n");
      if (fullText.length > 4096) continue;
      const currentChars = same.reduce((count, item) =>
        count + item.lines.slice(item.start - 1, item.end).join("\n").length, 0);
      const controlLines = new Set(same.flatMap((item) =>
        Array.from({ length: item.end - item.start + 1 }, (_, offset) => item.start + offset)));
      if (controlLines.size === window.lines.length
        || chars() - currentChars + fullText.length > maxChars) continue;
      window.start = 1;
      window.end = window.lines.length;
      window.contributors = same.flatMap((item) => item.contributors);
      window.merged = true;
      for (const item of same) {
        if (item !== window) windows.splice(windows.indexOf(item), 1);
      }
      addedLineCount += window.lines.length - controlLines.size;
      completedShortSource = true;
      break;
    }
  }
  if (!windows.some((item) => item.merged) && !completedShortSource) {
    return fallback(perFile ? "no_same_source_merge_or_short_source" : "no_same_source_merge");
  }
  // Merged windows are eligible for bounded adjacent context. Prefer earlier
  // source lines; this deterministic choice uses no query or expected answer.
  for (const window of windows.filter((item) => item.merged)) {
    const originalStart = window.start;
    const originalEnd = window.end;
    for (let line = originalStart - 1; line >= Math.max(1, originalStart - maxRadius); line -= 1) {
      if (windows.some((other) => other !== window && other.path === window.path
        && other.hash === window.hash && line >= other.start && line <= other.end + 1)) break;
      window.start = line;
      if (chars() > maxChars) { window.start = line + 1; break; }
      addedLineCount += 1;
    }
    for (let line = originalEnd + 1; line <= Math.min(window.lines.length, originalEnd + maxRadius); line += 1) {
      if (windows.some((other) => other !== window && other.path === window.path
        && other.hash === window.hash && line >= other.start - 1 && line <= other.end)) break;
      window.end = line;
      if (chars() > maxChars) { window.end = line - 1; break; }
      addedLineCount += 1;
    }
  }
  windows.sort((a, b) => a.order - b.order);
  const identityTag = perFile
    ? `per-file-source/v1:${generation}`
    : publicationFence.publication_digest;
  const hits = windows.map((item) => proposedHit(item, identityTag));
  if (hits.some((hit) => hit === null) || hits.length > topK || chars() > maxChars) {
    return fallback("proposal_unrenderable");
  }
  return {
    hits, fallbackHits: baselineHits, usedPacking: true,
    reason: "proposal_requires_canonical_render_validation",
    excerptChars: chars(), addedLineCount,
  };
}

/** Reject a canonical render that clips only newly added source lines. */
export function canonicalCoalescingDeliveryComplete(proposal, observed, delivered) {
  return proposal?.usedPacking === true && Array.isArray(proposal.hits)
    && Array.isArray(observed) && observed.length === proposal.hits.length
    && observed.every((item) => item?.formatted?.truncated !== true)
    && delivered && Array.isArray(delivered.runs)
    && delivered.runs.length === proposal.hits.length
    && delivered.excerptChars === proposal.excerptChars;
}
