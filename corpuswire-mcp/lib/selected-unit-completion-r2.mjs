import { createHash } from "node:crypto";

// Experimental r2 pure proposal planner. Source-path safety, publication identity,
// rendering, packet budgets, and comparison with v2 remain caller obligations.
const STOP = new Set(`about after against also and are before between can code current does evidence explain file find for from function how implementation into method module process return show source system test tests that the their then these this through what when where which with without would`.split(" "));
const hash = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const terms = (s) => new Set((s.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
  .filter((t) => t.length >= 4 && !STOP.has(t)));
const intersection = (a, b) => [...a].filter((v) => b.has(v));
const validText = (s) => typeof s === "string" && s.length > 0
  && Buffer.from(s, "utf8").toString("utf8") === s
  && !/[\r\u0000\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u.test(s);
const linesOf = (s) => {
  const lines = s.split("\n");
  if (s.endsWith("\n")) lines.pop();
  return lines;
};
const digest = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const validLine = (n) => Number.isSafeInteger(n) && n > 0;

function parse(lines) {
  const headings = [];
  const fences = [];
  let open = null;
  const listContentIndents = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      if (marker && marker[1][0] === open.char && marker[1].length >= open.length
        && marker[2].trim() === "") {
        fences.push({ startLine: open.startLine, endLine: i + 1 });
        open = null;
      }
      continue;
    }
    // Preserve ordinary container body lines as section content. We do not
    // interpret headings or fences in a block quote or list item as top-level
    // boundaries. A list ends only when nonblank content dedents below the
    // content column established by its marker. Retain outer list columns
    // across nested list items so a dedented continuation is still contained.
    const quoteLine = /^ {0,3}>[ \t]?/.test(line);
    const listMarker = /^( {0,3})(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(line);
    const indent = /^ */.exec(line)[0].length;
    if (!quoteLine && line.trim() !== "") {
      while (listContentIndents.length && listContentIndents.at(-1) > indent)
        listContentIndents.pop();
    }
    const listContinuation = !listMarker && listContentIndents.length > 0
      && (line.trim() === "" || indent >= listContentIndents.at(-1));
    const containerLine = quoteLine || Boolean(listMarker) || listContinuation;
    const body = quoteLine ? line.replace(/^ {0,3}>[ \t]?/, "")
      : listMarker ? line.slice(listMarker[0].length)
        : listContinuation ? line.slice(listContentIndents.at(-1)) : line;
    // Setext rules, raw HTML blocks, and nested fences are outside this
    // intentionally narrow parser, including when nested in containers.
    if (containerLine && (/^(?:=+|-{2,})\s*$/.test(body.trim())
      || /^<\/?[A-Za-z][\w:-]*(?:\s|>|\/)/.test(body.trimStart())
      || /^(`{3,}|~{3,})/.test(body.trimStart()))) return null;
    if (listMarker) listContentIndents.push(listMarker[0].length);
    else if (!listContinuation && !quoteLine && line.trim() !== "") listContentIndents.length = 0;
    if (containerLine) continue;
    if (marker) {
      // Backtick info strings containing backticks are not valid openers.
      if (marker[1][0] === "`" && marker[2].includes("`")) return null;
      open = { char: marker[1][0], length: marker[1].length, startLine: i + 1 };
      continue;
    }
    // Raw HTML and Setext syntax still make boundaries uncertain.
    if (/^ {0,3}<\/?[A-Za-z][\w:-]*(?:\s|>|\/)/.test(line)
      || /^ {0,3}(?:=+|-+)\s*$/.test(line)) return null;
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
    if (heading) {
      const title = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (!title) return null;
      headings.push({ startLine: i + 1, level: heading[1].length, title });
    }
  }
  if (open) return null;
  const sections = headings.map((heading, index) => {
    const next = headings[index + 1];
    // A section with a nested heading is not a leaf.
    if (next && next.level > heading.level) return null;
    return { ...heading, endLine: next ? next.startLine - 1 : lines.length };
  }).filter(Boolean);
  return { headings, sections, fences };
}

function enclosingHeading(headings, line) {
  const stack = [];
  for (const heading of headings) {
    if (heading.startLine > line) break;
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.at(-1) ?? null;
}

/**
 * Propose complete source units from authenticated source text and selected
 * pre-padding runs. All intervals and coreLineKeys use one-based physical lines.
 * The caller must render candidate packets and enforce host-level budgets.
 */
export function planSelectedUnitCompletion({ sources, selectedRuns, query }) {
  const abstain = (reason) => ({ units: [], reason });
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 5
    || !Array.isArray(selectedRuns) || selectedRuns.length === 0 || selectedRuns.length > 5
    || typeof query !== "string" || !query.trim()) return abstain("invalid_input");
  const queryTerms = terms(query);
  if (queryTerms.size < 2) return abstain("insufficient_query_terms");
  const sourceMap = new Map();
  for (const source of sources) {
    if (typeof source?.sourceId !== "string" || !source.sourceId
      || sourceMap.has(source.sourceId) || !digest(source.sourceHash)
      || !validText(source.text) || hash(source.text) !== source.sourceHash) {
      return abstain("source_mismatch");
    }
    const lines = linesOf(source.text);
    const parsed = parse(lines);
    sourceMap.set(source.sourceId, { ...source, lines, parsed });
  }
  if (sourceMap.size > 5) return abstain("invalid_input");
  const proposals = [];
  const seenRuns = new Set();
  for (const [hitOrder, run] of selectedRuns.entries()) {
    const source = sourceMap.get(run?.sourceId);
    if (!source || !validLine(run.startLine) || !validLine(run.endLine)
      || run.endLine < run.startLine || run.endLine > source.lines.length
      || !source.parsed) return abstain("invalid_or_uncertain_core");
    const runKey = `${run.sourceId}:${run.startLine}:${run.endLine}`;
    if (seenRuns.has(runKey)) continue;
    seenRuns.add(runKey);
    const selectedBody = source.lines.slice(run.startLine - 1, run.endLine).join("\n");
    const units = [];
    for (const section of source.parsed.sections) {
      if (section.startLine <= run.startLine && section.endLine >= run.endLine)
        units.push({ kind: "atx-leaf", ...section, heading: section.title });
    }
    for (const fence of source.parsed.fences) {
      if (fence.startLine <= run.startLine && fence.endLine >= run.endLine) {
        const parent = enclosingHeading(source.parsed.headings, fence.startLine);
        if (parent) units.push({ kind: "fenced-block", ...fence, heading: parent.title });
      }
    }
    units.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine)
      || a.startLine - b.startLine);
    for (const unit of units) {
      if (unit.startLine === run.startLine && unit.endLine === run.endLine) continue;
      const content = source.lines.slice(unit.startLine - 1, unit.endLine).join("\n");
      if (unit.endLine - unit.startLine + 1 > 160 || content.length > 8_000) continue;
      const headingWitness = intersection(queryTerms, terms(unit.heading));
      const bodyWitness = intersection(queryTerms, terms(`${unit.heading}\n${selectedBody}`));
      if (headingWitness.length === 0 || bodyWitness.length < 2) continue;
      proposals.push({
        kind: unit.kind, sourceId: source.sourceId, sourceHash: source.sourceHash,
        startLine: unit.startLine, endLine: unit.endLine, text: content,
        hitOrder, coreRuns: [{ startLine: run.startLine, endLine: run.endLine }],
        coreLineKeys: Array.from({ length: run.endLine - run.startLine + 1 }, (_, i) =>
          `${source.sourceId}:${source.sourceHash}:${run.startLine + i}`),
        witness: { headingTerms: headingWitness, selectedBodyTerms: bodyWitness },
      });
      break;
    }
  }
  proposals.sort((a, b) => a.hitOrder - b.hitOrder
    || (a.endLine - a.startLine) - (b.endLine - b.startLine)
    || a.startLine - b.startLine);
  const unique = new Map();
  for (const proposal of proposals) {
    const key = `${proposal.sourceId}:${proposal.sourceHash}:${proposal.startLine}:${proposal.endLine}`;
    const existing = unique.get(key);
    if (existing) {
      existing.coreRuns.push(...proposal.coreRuns);
      existing.coreLineKeys = [...new Set([...existing.coreLineKeys, ...proposal.coreLineKeys])];
    } else unique.set(key, proposal);
  }
  const units = [...unique.values()].slice(0, 2);
  return { units, reason: units.length ? "proposal_requires_renderer_validation" : "no_eligible_unit" };
}
