import { createHash } from "node:crypto";

// RQT-110 P1 only. This planner has no live MCP integration. The canonical
// renderer must compare its delivered lines with the control before adoption.
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

function scopeIdentity(scope) {
  if (!scope || scope.identity_version !== "v2" || scope.publication_state !== "published") return null;
  const names = ["tenant_id", "codebase_id", "repository_id", "repository_set_id", "snapshot_id", "revision"];
  if (names.some((name) => !nonempty(scope[name]))) return null;
  if (!Number.isInteger(scope.generation) || scope.generation < 1) return null;
  if (!Array.isArray(scope.authorized_repository_ids)
    || !scope.authorized_repository_ids.includes(scope.repository_id)
    || scope.authorized_repository_ids.some((id) => !nonempty(id))
    || scope.authorized_repository_ids.join("\0") !== [...scope.authorized_repository_ids].sort().join("\0")) return null;
  if (scope.content_layer === "snapshot" && scope.overlay_id != null) return null;
  if (scope.content_layer === "overlay" && !nonempty(scope.overlay_id)) return null;
  if (scope.content_layer !== "snapshot" && scope.content_layer !== "overlay") return null;
  return JSON.stringify([
    scope.identity_version, scope.tenant_id, scope.codebase_id, scope.repository_id,
    scope.repository_set_id, scope.authorized_repository_ids, scope.snapshot_id,
    scope.overlay_id ?? null, scope.generation, scope.content_layer,
    scope.revision, scope.publication_state,
  ]);
}

function publicationFenceIdentity(fence) {
  if (!fence || Array.isArray(fence)
    || fence.schema_version !== "rqt110-frozen-publication-fence/v1"
    || !Object.hasOwn(fence, "overlay_id") || fence.overlay_id !== null) return null;
  const names = [
    "tenant_id", "served_workspace_id", "storage_workspace_id", "collection",
    "repository_id",
  ];
  if (names.some((name) => !nonempty(fence[name]))) return null;
  if (!isDigest(fence.source_snapshot_digest) || !isDigest(fence.publication_digest)
    || !Number.isInteger(fence.manifest_revision) || fence.manifest_revision < 1
    || !Number.isInteger(fence.generation) || fence.generation < 1) return null;
  return JSON.stringify([
    fence.schema_version, fence.tenant_id, fence.served_workspace_id,
    fence.storage_workspace_id, fence.collection, fence.manifest_revision,
    fence.repository_id, fence.source_snapshot_digest, fence.publication_digest,
    fence.generation, fence.overlay_id,
  ]);
}

function sourceFromHit(hit, publicationFence) {
  const metadata = hit?.metadata;
  const scope = publicationFence
    ? publicationFenceIdentity(publicationFence)
    : scopeIdentity(metadata?.index_scope);
  const path = metadata?.source_path;
  const hash = metadata?.source_hash;
  if (!scope || !nonempty(path) || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || !isDigest(hash) || !nonempty(hit?.chunk_id)) return null;
  return {
    scope, path, hash,
    key: JSON.stringify([scope, path, hash]),
    selectorKey: publicationFence
      ? JSON.stringify([
        publicationFence.repository_id, publicationFence.source_snapshot_digest,
        publicationFence.overlay_id, path, hash,
      ])
      : JSON.stringify([
        metadata.index_scope.repository_id, metadata.index_scope.snapshot_id,
        metadata.index_scope.overlay_id ?? null, path, hash,
      ]),
  };
}

function windowFromHit(hit, rank, order = rank, publicationFence = undefined) {
  const source = sourceFromHit(hit, publicationFence);
  if (!source) return { reason: "invalid_source_identity" };
  const metadata = hit.metadata;
  const projection = metadata.extras?.corpuswire_display_lines;
  const { scope, path, hash, key, selectorKey } = source;
  if (!projection || projection.schema_version !== "corpuswire-complete-source-lines/v1"
    || projection.source_hash !== hash
    || !Number.isInteger(projection.start_line) || !Number.isInteger(projection.end_line)
    || projection.start_line < 1 || projection.end_line < projection.start_line
    || !Number.isInteger(metadata.start_line) || !Number.isInteger(metadata.end_line)
    || typeof projection.text !== "string" || !projection.text.trim()
    || Buffer.byteLength(projection.text, "utf8") > 16_000
    || projection.text_sha256 !== sha256(projection.text)
    || projection.text.split("\n").length !== projection.end_line - projection.start_line + 1
    || typeof hit.text !== "string" || !hit.text.trim()) return { reason: "unverified_projection" };
  const direct = projection.mapping_kind === undefined
    && !projection.text.endsWith("\n")
    && projection.start_line >= metadata.start_line
    && projection.end_line <= metadata.end_line
    && projection.text.includes(hit.text.trim());
  let sourceContext = false;
  if (projection.mapping_kind === "source-context/v1"
    && projection.chunk_text_sha256 === sha256(hit.text)
    && projection.start_line <= metadata.start_line
    && projection.end_line >= metadata.end_line
    && metadata.start_line - projection.start_line <= 3
    && projection.end_line - metadata.end_line <= 3
    && (projection.start_line < metadata.start_line || projection.end_line > metadata.end_line)) {
    const projectionLines = projection.text.split("\n");
    const beforeCount = metadata.start_line - projection.start_line;
    const afterCount = projection.end_line - metadata.end_line;
    const before = projectionLines.slice(0, beforeCount);
    const after = projectionLines.slice(projectionLines.length - afterCount);
    const core = projectionLines.slice(beforeCount, projectionLines.length - afterCount).join("\n");
    const markdown = path.toLowerCase().endsWith(".md");
    const permitted = (line) => !line.trim()
      || (markdown && /^#{1,6}\s+\S/.test(line.replace(/\r$/, "")));
    sourceContext = core.includes(hit.text.trim())
      && before.every(permitted) && after.every(permitted);
  }
  if (!direct && !sourceContext) return {
    reason: projection.mapping_kind && projection.mapping_kind !== "source-context/v1"
      ? "unsupported_mapping" : "unverified_projection",
  };
  const lines = projection.text.split("\n");
  return {
    window: {
      key, selectorKey, scope, path, hash, start: projection.start_line, end: projection.end_line,
      lines, contributors: [{ id: hit.chunk_id, rank }], hit, order,
    },
  };
}

function mergeWindows(left, right) {
  const start = Math.min(left.start, right.start);
  const end = Math.max(left.end, right.end);
  const lines = Array(end - start + 1);
  for (const window of [left, right]) {
    for (let line = window.start; line <= window.end; line += 1) {
      const text = window.lines[line - window.start];
      const offset = line - start;
      if (lines[offset] !== undefined && lines[offset] !== text) return null;
      lines[offset] = text;
    }
  }
  if (lines.some((line) => line === undefined)) return null;
  const contributors = new Map();
  for (const item of [...left.contributors, ...right.contributors]) {
    const prior = contributors.get(item.id);
    if (prior === undefined || item.rank < prior) contributors.set(item.id, item.rank);
  }
  return {
    ...left, start, end, lines,
    contributors: [...contributors].map(([id, rank]) => ({ id, rank }))
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)),
    order: Math.min(left.order, right.order),
  };
}

function insertWindow(windows, proposed) {
  let pending = proposed;
  let remaining = [...windows];
  let merged = true;
  while (merged) {
    merged = false;
    const next = [];
    for (const current of remaining) {
      if (current.key !== pending.key || current.end + 1 < pending.start
        || pending.end + 1 < current.start) {
        next.push(current);
        continue;
      }
      const combined = mergeWindows(current, pending);
      if (!combined) return { reason: "conflicting_source_lines" };
      pending = combined;
      merged = true;
    }
    remaining = next;
  }
  remaining.push(pending);
  remaining.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key) || a.start - b.start);
  return { windows: remaining };
}

function excerptCharacters(windows) {
  return windows.reduce((total, window) => total + window.lines.join("\n").length, 0);
}

function contributorCounts(windows) {
  const bySource = new Map();
  let total = 0;
  for (const window of windows) {
    const count = window.contributors.length;
    total += count;
    bySource.set(window.selectorKey, (bySource.get(window.selectorKey) ?? 0) + count);
  }
  return { total, bySource };
}

function genericV2SourceCap(candidateHits, publicationFence) {
  const identities = new Set();
  for (const hit of candidateHits.slice(0, 10)) {
    const source = sourceFromHit(hit, publicationFence);
    if (!source) return null;
    identities.add(source.selectorKey);
  }
  return identities.size >= 5 ? 3 : 2;
}

function emittedHit(window) {
  if (window.contributors.length === 1) return window.hit;
  const text = window.lines.join("\n");
  // The current Node verifier accepts a trailing empty line only as an
  // original source-context mapping. A union has no such mapping proof.
  if (text.endsWith("\n")) return null;
  const ids = window.contributors.map(({ id }) => id);
  const digest = sha256(JSON.stringify([window.key, window.start, window.end, sha256(text), ids]));
  const metadata = window.hit.metadata;
  return {
    ...window.hit,
    chunk_id: `bundle:${digest}`,
    text,
    metadata: {
      ...metadata,
      start_line: window.start,
      end_line: window.end,
      extras: {
        ...metadata.extras,
        corpuswire_display_lines: {
          schema_version: "corpuswire-complete-source-lines/v1",
          source_hash: window.hash,
          start_line: window.start,
          end_line: window.end,
          text,
          text_sha256: sha256(text),
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
 * Pure, conservative feasibility planner over already ranked first-32 hits.
 * Input: { baselineHits: SearchHit[], candidateHits: SearchHit[], topK?: 1..5,
 *          maxChars?: integer, publicationFence?: FrozenPublicationFenceV1 }.
 * `baselineHits` are the unchanged generic-v2
 * result in delivery order. `candidateHits` are the first 32 stage-two hits in
 * original rank order. Each mergeable hit needs path, source hash, and
 * metadata.extras.corpuswire_display_lines with observed text. V2 hits also
 * need metadata.index_scope. Frozen v1 hits require `publicationFence` with
 * schema_version rqt110-frozen-publication-fence/v1, tenant_id,
 * served_workspace_id, storage_workspace_id, collection, manifest_revision,
 * repository_id, source_snapshot_digest, publication_digest, generation and
 * overlay_id:null. Every v1 hit must have null index_scope and the same
 * source_generation. The caller must independently verify that this fence is
 * bound to the exact captured query response and frozen source manifest. The
 * pure function cannot authenticate a supplied fence and must not be used as
 * a production trust boundary.
 * The first 10 candidate hits determine the
 * existing generic-v2 source cap; those hits need full v2 source identity.
 * Their projections may be unsupported and will then be rejected individually.
 * No labels are read.
 * Output: { hits: SearchHit[], fallbackHits: original SearchHit[],
 *           usedPacking: boolean, reason: string,
 *           rejected: {rank: number, reason: string}[], excerptChars: number|null }.
 * `hits` are only a proposal. The caller must render both control and proposal,
 * then preserve every actually delivered control line before using the latter.
 */
export function planSourcePacking({
  baselineHits, candidateHits, topK = 5, maxChars = 12_000,
  publicationFence = undefined,
}) {
  const fallback = (reason, rejected = []) => ({
    hits: baselineHits, fallbackHits: baselineHits, usedPacking: false,
    reason, rejected, excerptChars: null,
  });
  if (!Array.isArray(baselineHits) || !Array.isArray(candidateHits)
    || candidateHits.length > 32
    || !Number.isInteger(topK) || topK < 1
    || !Number.isInteger(maxChars) || maxChars < 1
    || baselineHits.length > Math.min(topK, 5)
    || baselineHits.length > 5) return fallback("invalid_input");
  if (baselineHits.length === 0) return fallback("empty_control");
  if (publicationFence !== undefined) {
    if (!publicationFenceIdentity(publicationFence)) return fallback("invalid_publication_fence");
    for (const hit of [...baselineHits, ...candidateHits.slice(0, 32)]) {
      const metadata = hit?.metadata;
      if (metadata?.index_scope != null) return fallback("mixed_scope_mode");
      if (!Number.isInteger(metadata?.source_generation)
        || metadata.source_generation !== publicationFence.generation) {
        return fallback("publication_generation_mismatch");
      }
      for (const [field, fenceField] of [
        ["tenant_id", "tenant_id"], ["workspace_id", "served_workspace_id"],
        ["storage_workspace_id", "storage_workspace_id"], ["collection", "collection"],
        ["repository_id", "repository_id"], ["source_snapshot_digest", "source_snapshot_digest"],
        ["publication_digest", "publication_digest"], ["manifest_revision", "manifest_revision"],
        ["overlay_id", "overlay_id"],
      ]) {
        if (Object.hasOwn(metadata, field) && metadata[field] !== publicationFence[fenceField]) {
          return fallback("publication_metadata_mismatch");
        }
      }
    }
  }
  const budget = Math.min(maxChars, 12_000);
  let windows = [];
  for (const [index, hit] of baselineHits.entries()) {
    const parsed = windowFromHit(hit, index, index, publicationFence);
    if (!parsed.window) return fallback(`baseline_${parsed.reason}`);
    const inserted = insertWindow(windows, parsed.window);
    if (!inserted.windows) return fallback(`baseline_${inserted.reason}`);
    windows = inserted.windows;
  }
  if (excerptCharacters(windows) > budget) return fallback("baseline_exceeds_budget");
  const sourceCap = genericV2SourceCap(candidateHits, publicationFence);
  if (sourceCap === null) return fallback("candidate_source_cap_unverifiable");
  const baselineCounts = contributorCounts(windows);
  if (baselineCounts.total > 8) return fallback("baseline_exceeds_contributors");
  const rejected = [];
  const baselineIds = new Set(baselineHits.map((hit) => hit.chunk_id));
  if (baselineIds.size !== baselineHits.length) return fallback("duplicate_control_ids");
  const usedIds = new Set(baselineIds);
  for (const [index, hit] of candidateHits.slice(0, 32).entries()) {
    if (usedIds.has(hit?.chunk_id)) continue;
    const parsed = windowFromHit(hit, index, baselineHits.length + index, publicationFence);
    if (!parsed.window) {
      rejected.push({ rank: index, reason: parsed.reason });
      continue;
    }
    const before = windows.reduce((total, window) => total + window.lines.length, 0);
    const inserted = insertWindow(windows, parsed.window);
    if (!inserted.windows) {
      rejected.push({ rank: index, reason: inserted.reason });
      continue;
    }
    const after = inserted.windows.reduce((total, window) => total + window.lines.length, 0);
    if (after <= before) {
      rejected.push({ rank: index, reason: "no_new_lines" });
      continue;
    }
    const counts = contributorCounts(inserted.windows);
    const sourceCount = counts.bySource.get(parsed.window.selectorKey) ?? 0;
    const sourceLimit = Math.max(sourceCap, baselineCounts.bySource.get(parsed.window.selectorKey) ?? 0);
    const mirror = windows.some((window) => window.key !== parsed.window.key
      && window.hash === parsed.window.hash
      && window.start === parsed.window.start && window.end === parsed.window.end);
    let reason = null;
    if (mirror) reason = "mirror_removed";
    else if (sourceCount > sourceLimit) reason = "source_cap";
    else if (counts.total > 8) reason = "contributor_budget";
    else if (inserted.windows.length > Math.min(topK, 5)) reason = "window_budget";
    else if (excerptCharacters(inserted.windows) > budget) reason = "character_budget";
    if (reason) {
      rejected.push({ rank: index, reason });
      continue;
    }
    windows = inserted.windows;
    usedIds.add(hit.chunk_id);
  }
  const hits = windows.map(emittedHit);
  if (hits.some((hit) => hit === null)) return fallback("union_not_renderable", rejected);
  const usedPacking = hits.length !== baselineHits.length
    || hits.some((hit, index) => hit !== baselineHits[index]);
  return {
    hits: usedPacking ? hits : baselineHits,
    fallbackHits: baselineHits,
    usedPacking,
    reason: usedPacking ? "proposal_requires_renderer_validation" : "no_safe_addition",
    rejected,
    excerptChars: excerptCharacters(windows),
  };
}

// RQT-110B is an offline proposal only. The caller must authenticate the
// supplied delivered runs and every projection against the frozen source,
// then render both arms and retain the control on any delivered-line loss.
const RENDERER_AWARE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "how", "why",
  "what", "where", "when", "which", "does", "can", "are", "was", "were",
  "has", "have", "had", "about",
]);

function rendererAwareTokens(value) {
  const tokens = value.normalize("NFKC").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter((token) => token.length >= 2 && !RENDERER_AWARE_STOPWORDS.has(token)));
}

function rendererAwareBundle(window, sourceProofs = undefined) {
  const text = window.lines.join("\n");
  if (!text.trim()) return null;
  const terminalLf = text.endsWith("\n");
  if (terminalLf && (!sourceProofs?.get(window.key)?.blankLfLines.has(window.end)
    || window.lines.at(-1) !== "" || window.end <= window.start)) return null;
  const ids = window.contributors.map(({ id }) => id);
  const digest = sha256(JSON.stringify([
    ...(terminalLf ? ["authenticated-newline-v1"] : []),
    window.queryDigest, window.key, window.start, window.end, sha256(text), ids,
  ]));
  const metadata = window.hit.metadata;
  const hitText = terminalLf ? text.slice(0, -1) : text;
  return {
    ...window.hit,
    chunk_id: `bundle:${digest}`,
    text: hitText,
    metadata: {
      ...metadata,
      start_line: window.start,
      end_line: terminalLf ? window.end - 1 : window.end,
      extras: {
        ...metadata.extras,
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

function rendererAwareSlice(window, start, end, sourceProofs = undefined) {
  const sliced = {
    ...window, start, end,
    lines: window.lines.slice(start - window.start, end - window.start + 1),
  };
  if (sliced.lines.join("\n") !== window.hit.text
    || start !== window.hit.metadata.start_line || end !== window.hit.metadata.end_line
    || window.hit.metadata.extras?.corpuswire_display_lines?.text !== sliced.lines.join("\n")) {
    sliced.hit = rendererAwareBundle(sliced, sourceProofs);
  }
  return sliced.hit ? sliced : null;
}

function rendererAwareTouches(left, right) {
  return left.key === right.key && left.start <= right.end + 1 && right.start <= left.end + 1;
}

function rendererAwareLineCount(windows) {
  return windows.reduce((count, window) => count + window.lines.length, 0);
}

function rendererAwareFullyCovered(windows, proposed) {
  return windows.some((window) => window.key === proposed.key
    && window.start <= proposed.start && window.end >= proposed.end
    && proposed.lines.every((line, index) => window.lines[proposed.start - window.start + index] === line));
}

function rendererAwareInsert(windows, candidate, { budget, topK, sourceCap, baselineCounts }) {
  const before = rendererAwareLineCount(windows);
  const inserted = insertWindow(windows, candidate);
  if (!inserted.windows) return { reason: inserted.reason };
  if (rendererAwareLineCount(inserted.windows) <= before) return { reason: "no_new_lines" };
  const counts = contributorCounts(inserted.windows);
  const sourceLimit = Math.max(sourceCap, baselineCounts.bySource.get(candidate.selectorKey) ?? 0);
  if ((counts.bySource.get(candidate.selectorKey) ?? 0) > sourceLimit) return { reason: "source_cap" };
  if (counts.total > 8) return { reason: "contributor_budget" };
  if (inserted.windows.length > Math.min(topK, 5)) return { reason: "window_budget" };
  if (excerptCharacters(inserted.windows) > budget) return { reason: "character_budget" };
  return inserted;
}

function rendererAwareTrim(core, windows, queryTokens, limits, sourceProofs = undefined) {
  const midpoint = Math.floor((core.start + core.end) / 2);
  const scored = [];
  for (let line = core.start; line <= core.end; line += 1) {
    const sliced = rendererAwareSlice(core, line, line, sourceProofs);
    if (!sliced || rendererAwareInsert(windows, sliced, limits).reason) continue;
    const tokens = rendererAwareTokens(sliced.lines[0]);
    const score = [...tokens].filter((token) => queryTokens.has(token)).length;
    scored.push({ line, score });
  }
  if (scored.length === 0) return null;
  const maxScore = Math.max(...scored.map(({ score }) => score));
  const center = maxScore === 0
    ? scored[0].line
    : scored.filter(({ score }) => score === maxScore)
      .sort((a, b) => Math.abs(a.line - midpoint) - Math.abs(b.line - midpoint)
        || a.line - b.line)[0].line;
  let start = center;
  let end = center;
  while (true) {
    const neighbors = [start - 1, end + 1]
      .filter((line) => line >= core.start && line <= core.end)
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
    let expanded = false;
    for (const line of neighbors) {
      const proposedStart = Math.min(start, line);
      const proposedEnd = Math.max(end, line);
      const sliced = rendererAwareSlice(core, proposedStart, proposedEnd, sourceProofs);
      if (!sliced || rendererAwareInsert(windows, sliced, limits).reason) continue;
      start = proposedStart;
      end = proposedEnd;
      expanded = true;
      break;
    }
    if (!expanded) break;
  }
  return rendererAwareSlice(core, start, end, sourceProofs);
}

function rendererAwarePublicationFailure(hits, fence) {
  if (fence === undefined) return null;
  if (!publicationFenceIdentity(fence)) return "invalid_publication_fence";
  for (const hit of hits) {
    const metadata = hit?.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return "invalid_hit_metadata";
    }
    if (metadata?.index_scope != null) return "mixed_scope_mode";
    if (!Number.isInteger(metadata?.source_generation)
      || metadata.source_generation !== fence.generation) return "publication_generation_mismatch";
    for (const [field, fenceField] of [
      ["tenant_id", "tenant_id"], ["workspace_id", "served_workspace_id"],
      ["storage_workspace_id", "storage_workspace_id"], ["collection", "collection"],
      ["repository_id", "repository_id"], ["source_snapshot_digest", "source_snapshot_digest"],
      ["publication_digest", "publication_digest"], ["manifest_revision", "manifest_revision"],
      ["overlay_id", "overlay_id"],
    ]) {
      if (Object.hasOwn(metadata, field) && metadata[field] !== fence[fenceField]) {
        return "publication_metadata_mismatch";
      }
    }
  }
  return null;
}

function rendererAwareAuthenticatedSources(sourceProofs, publicationFence) {
  const scope = publicationFenceIdentity(publicationFence);
  if (!scope || !sourceProofs || Array.isArray(sourceProofs)
    || publicationFenceIdentity(sourceProofs.publicationFence) !== scope
    || !Array.isArray(sourceProofs.records) || sourceProofs.records.length > 37) {
    return { reason: "invalid_source_proofs" };
  }
  const bySource = new Map();
  for (const record of sourceProofs.records) {
    const path = record?.path;
    const hash = record?.sourceHash;
    const count = record?.physicalLineCount;
    const blanks = record?.blankLfTerminatedLines;
    if (!nonempty(path) || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((part) => !part || part === "." || part === "..")
      || !isDigest(hash) || !Number.isInteger(count) || count < 1
      || !Array.isArray(blanks)) return { reason: "invalid_source_proofs" };
    const key = JSON.stringify([scope, path, hash]);
    if (bySource.has(key)) return { reason: "duplicate_source_proof" };
    let last = 0;
    for (const line of blanks) {
      if (!Number.isInteger(line) || line <= last || line > count) {
        return { reason: "invalid_source_proofs" };
      }
      last = line;
    }
    bySource.set(key, { physicalLineCount: count, blankLfLines: new Set(blanks) });
  }
  return { bySource };
}

/**
 * Pure RQT-110B proposal from source-authenticated complete delivered runs.
 * `deliveredRuns`: {chunkId, startLine, endLine, text}[] in selected-hit order.
 * The caller owns source-byte authentication and the final two-render check.
 */
function planRendererAwarePackingCore({
  baselineHits, deliveredRuns, candidateHits, query, topK = 5,
  maxChars = 12_000, publicationFence = undefined,
}, sourceProofs = undefined) {
  const fallback = (reason, rejected = []) => ({
    hits: baselineHits, fallbackHits: baselineHits, usedPacking: false,
    reason, rejected, excerptChars: null,
  });
  if (!Array.isArray(baselineHits) || !Array.isArray(deliveredRuns)
    || !Array.isArray(candidateHits) || candidateHits.length > 32
    || typeof query !== "string" || !Number.isInteger(topK) || topK < 1
    || !Number.isInteger(maxChars) || baselineHits.length > Math.min(topK, 5)
    || baselineHits.length > 5) return fallback("invalid_input");
  if (baselineHits.length === 0) return fallback("empty_control");
  const clampedMaxChars = Math.max(200, Math.min(50_000, maxChars));
  if (clampedMaxChars > 12_000) return fallback("request_exceeds_treatment_budget");
  const publicationFailure = rendererAwarePublicationFailure(
    [...baselineHits, ...candidateHits], publicationFence,
  );
  if (publicationFailure) return fallback(publicationFailure);
  const budget = clampedMaxChars;
  const queryDigest = sha256(query);
  const controlById = new Map();
  for (const [index, hit] of baselineHits.entries()) {
    if (!nonempty(hit?.chunk_id) || controlById.has(hit.chunk_id)) return fallback("duplicate_control_ids");
    controlById.set(hit.chunk_id, { hit, index });
  }
  let windows = [];
  let controlScope = null;
  let lastIndex = -1;
  for (const run of deliveredRuns) {
    const selected = controlById.get(run?.chunkId);
    if (!selected || selected.index < lastIndex
      || !Number.isInteger(run?.startLine) || !Number.isInteger(run?.endLine)
      || run.startLine < 1 || run.endLine < run.startLine
      || typeof run.text !== "string" || !run.text.trim()) return fallback("invalid_delivered_run");
    lastIndex = selected.index;
    const parsed = windowFromHit(selected.hit, selected.index, selected.index, publicationFence);
    if (!parsed.window) return fallback(`baseline_${parsed.reason}`);
    parsed.window.queryDigest = queryDigest;
    if (controlScope !== null && parsed.window.scope !== controlScope) return fallback("mixed_control_scope");
    controlScope = parsed.window.scope;
    if (parsed.window.lines.some((line) => line.includes("\r"))) return fallback("crlf_unsupported");
    if (run.startLine < parsed.window.start || run.endLine > parsed.window.end) {
      return fallback("delivered_run_outside_projection");
    }
    const sliced = rendererAwareSlice(parsed.window, run.startLine, run.endLine, sourceProofs);
    if (!sliced || sliced.lines.join("\n") !== run.text) return fallback("delivered_run_mismatch");
    const inserted = insertWindow(windows, sliced);
    if (!inserted.windows) return fallback(`baseline_${inserted.reason}`);
    windows = inserted.windows;
  }
  if (windows.length === 0) return fallback("no_complete_delivered_lines");
  if (windows.length > Math.min(topK, 5)) return fallback("baseline_exceeds_windows");
  if (excerptCharacters(windows) > budget) return fallback("baseline_exceeds_budget");
  const sourceCap = genericV2SourceCap(candidateHits, publicationFence);
  if (sourceCap === null) return fallback("candidate_source_cap_unverifiable");
  const baselineCounts = contributorCounts(windows);
  if (baselineCounts.total > 8) return fallback("baseline_exceeds_contributors");
  const protectedWindows = [...windows];
  const limits = { budget, topK, sourceCap, baselineCounts };
  const queryTokens = rendererAwareTokens(query);
  const rejected = [];
  const donors = [];
  const seenIds = new Set();
  for (const [rank, hit] of candidateHits.entries()) {
    if (!nonempty(hit?.chunk_id) || seenIds.has(hit.chunk_id)) {
      rejected.push({ rank, reason: "duplicate_candidate_id" });
      continue;
    }
    seenIds.add(hit.chunk_id);
    const parsed = windowFromHit(hit, rank, baselineHits.length + rank, publicationFence);
    if (!parsed.window) {
      rejected.push({ rank, reason: parsed.reason });
      continue;
    }
    const projection = parsed.window;
    projection.queryDigest = queryDigest;
    if (projection.scope !== controlScope) {
      rejected.push({ rank, reason: "mixed_scope_mode" });
      continue;
    }
    if (projection.lines.some((line) => line.includes("\r"))) {
      rejected.push({ rank, reason: "crlf_unsupported" });
      continue;
    }
    const { start_line: start, end_line: end } = hit.metadata;
    if (start < projection.start || end > projection.end) {
      rejected.push({ rank, reason: "core_outside_projection" });
      continue;
    }
    if (protectedWindows.some((window) => window.scope === projection.scope
      && window.path === projection.path && window.hash !== projection.hash)) {
      rejected.push({ rank, reason: "source_hash_mismatch" });
      continue;
    }
    let core = rendererAwareSlice(projection, start, end, sourceProofs);
    if (!core) {
      rejected.push({ rank, reason: "unrenderable_core" });
      continue;
    }
    // An empty final line represents a source trailing newline, not a safe
    // direct projection. It may be omitted only for a donor, never a control.
    if (core.lines.at(-1) === ""
      && !sourceProofs?.get(core.key)?.blankLfLines.has(core.end)) {
      if (core.lines.length === 1) {
        rejected.push({ rank, reason: "empty_core" });
        continue;
      }
      core = rendererAwareSlice(projection, start, end - 1, sourceProofs);
      if (!core) {
        rejected.push({ rank, reason: "unrenderable_core" });
        continue;
      }
    }
    if (rendererAwareFullyCovered(protectedWindows, core)) continue;
    donors.push({ rank, core });
  }
  const attempted = new Set();
  const admit = ({ rank, core }, coalescing) => {
    if (windows.some((window) => window.scope === core.scope
      && window.path === core.path && window.hash !== core.hash)) {
      rejected.push({ rank, reason: "source_hash_mismatch" });
      return "rejected";
    }
    const full = rendererAwareInsert(windows, core, limits);
    let selected = core;
    let proposal = full;
    if (full.reason === "character_budget") {
      selected = rendererAwareTrim(core, windows, queryTokens, limits, sourceProofs);
      if (!selected) {
        rejected.push({ rank, reason: "no_fitting_core_line" });
        return "rejected";
      }
      if (coalescing && !protectedWindows.some((window) => rendererAwareTouches(window, selected))) {
        return "deferred";
      }
      proposal = rendererAwareInsert(windows, selected, limits);
    }
    if (proposal.reason) {
      rejected.push({ rank, reason: proposal.reason });
      return "rejected";
    }
    if (coalescing && !protectedWindows.some((window) => rendererAwareTouches(window, selected))) {
      return "deferred";
    }
    windows = proposal.windows;
    return "admitted";
  };
  for (const donor of donors) {
    if (!protectedWindows.some((window) => rendererAwareTouches(window, donor.core))) continue;
    const result = admit(donor, true);
    if (result !== "deferred") attempted.add(donor.rank);
  }
  for (const donor of donors) {
    if (attempted.has(donor.rank)) continue;
    admit(donor, false);
  }
  const hits = windows.map((window) => {
    const text = window.lines.join("\n");
    const projection = window.hit.metadata.extras?.corpuswire_display_lines;
    return window.contributors.length === 1
      && window.hit.text === text
      && window.hit.metadata.start_line === window.start
      && window.hit.metadata.end_line === window.end
      && projection?.text === text
      ? window.hit : rendererAwareBundle(window, sourceProofs);
  });
  if (hits.some((hit) => hit === null)) return fallback("union_not_renderable", rejected);
  const usedPacking = hits.length !== baselineHits.length
    || hits.some((hit, index) => hit !== baselineHits[index]);
  return {
    hits: usedPacking ? hits : baselineHits,
    fallbackHits: baselineHits,
    usedPacking,
    reason: usedPacking ? "proposal_requires_renderer_validation" : "no_safe_addition",
    rejected,
    excerptChars: excerptCharacters(windows),
  };
}

export function planRendererAwarePacking(input) {
  return planRendererAwarePackingCore(input);
}

/** Offline-only variant; the caller must authenticate source proofs and rendered output. */
export function planAuthenticatedNewlinePacking(input) {
  const fallback = (reason) => ({
    hits: input?.baselineHits, fallbackHits: input?.baselineHits,
    usedPacking: false, reason, rejected: [], excerptChars: null,
  });
  const proof = rendererAwareAuthenticatedSources(
    input?.sourceProofs, input?.publicationFence,
  );
  if (!proof.bySource) return fallback(proof.reason);
  return planRendererAwarePackingCore(input, proof.bySource);
}
