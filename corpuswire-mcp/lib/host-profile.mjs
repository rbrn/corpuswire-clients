// Host detection, protocol negotiation and tool metadata shared by every MCP
// host (Claude Code, GitHub Copilot in VS Code and the CLI, Codex). Nothing here
// changes retrieval; it only decides labels, defaults and standard metadata.

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);

const HOSTS = Object.freeze({
  "claude-code": { id: "claude-code", surface: "claude-code", defaultOutputMode: "claude-code" },
  "vscode-copilot": { id: "vscode-copilot", surface: "vscode", defaultOutputMode: "copilot" },
  "copilot-cli": { id: "copilot-cli", surface: "copilot-cli", defaultOutputMode: "copilot" },
  codex: { id: "codex", surface: "codex", defaultOutputMode: "generic" },
  // Unknown hosts keep the pre-detection labels and defaults.
  unknown: { id: "unknown", surface: "codex", defaultOutputMode: "generic" },
});

/** Map an `initialize` clientInfo name, or a CORPUSWIRE_HOST override, to a host profile. */
export function detectHost(clientInfo, override) {
  const forced = typeof override === "string" ? override.trim().toLowerCase() : "";
  if (forced) return HOSTS[forced] ?? HOSTS.unknown;
  const name = typeof clientInfo?.name === "string" ? clientInfo.name.trim().toLowerCase() : "";
  if (!name) return HOSTS.unknown;
  if (name === "claude-code" || name.startsWith("claude-code")) return HOSTS["claude-code"];
  if (name.startsWith("visual studio code")) return HOSTS["vscode-copilot"];
  if (name.includes("copilot")) return HOSTS["copilot-cli"];
  if (name.includes("codex")) return HOSTS.codex;
  return HOSTS.unknown;
}

/** Answer with the requested version when supported, otherwise the newest supported one. */
export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export const SERVER_INSTRUCTIONS = [
  "CorpusWire is a semantic index of this workspace's code and documents.",
  "Call corpuswire_search before reading unfamiliar code or when you need to find where something is defined, configured or documented; it returns ranked file paths with line ranges and excerpts to read next.",
  "Call corpuswire_enhance_prompt to turn a short or vague task into an instruction grounded in the files it names.",
  "Each result header names the workspace it searched and where that identity came from; pass workspaceId only when that workspace is wrong.",
  "When results look empty or stale, call corpuswire_doctor.",
].join(" ");

// Annotations follow the MCP tool annotation hints. A tool is read-only when it
// changes nothing in the workspace, the index or the quality ledger. Review
// context requests start a backend job, so they count as writes.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const IDEMPOTENT_WRITE = { ...WRITE, idempotentHint: true };

export const TOOL_METADATA = Object.freeze({
  corpuswire_review_context: { title: "Review context", annotations: WRITE },
  corpuswire_review_context_v2: { title: "Review context (v2)", annotations: WRITE },
  corpuswire_codebase_status: { title: "Codebase status", annotations: READ_ONLY },
  corpuswire_search: { title: "Search workspace context", annotations: READ_ONLY },
  corpuswire_enhance_prompt: { title: "Enhance prompt", annotations: READ_ONLY },
  corpuswire_rate_result: { title: "Rate a retrieval result", annotations: WRITE },
  corpuswire_quality_review: { title: "Quality review", annotations: READ_ONLY },
  corpuswire_confirm_value: { title: "Confirm value", annotations: WRITE },
  corpuswire_value_rollup: { title: "Value rollup", annotations: READ_ONLY },
  corpuswire_version: { title: "Version", annotations: READ_ONLY },
  corpuswire_health: { title: "Backend health", annotations: READ_ONLY },
  corpuswire_diagnose_workspace: { title: "Diagnose workspace", annotations: READ_ONLY },
  corpuswire_doctor: { title: "Readiness doctor", annotations: READ_ONLY },
  corpuswire_sync_delta: { title: "Sync changed paths", annotations: WRITE },
  corpuswire_sync_flush: { title: "Flush pending sync", annotations: IDEMPOTENT_WRITE },
  corpuswire_sync_probe_paths: { title: "Probe sync paths", annotations: READ_ONLY },
  // A reconcile can rebuild the collection when asked, so hosts should confirm it.
  corpuswire_sync_reconcile: { title: "Reconcile workspace index", annotations: { ...IDEMPOTENT_WRITE, destructiveHint: true } },
  corpuswire_sync_git_delta: { title: "Sync git working-tree changes", annotations: WRITE },
  corpuswire_sync_bootstrap: { title: "Bootstrap sync", annotations: WRITE },
  corpuswire_sync_status: { title: "Sync status", annotations: READ_ONLY },
  corpuswire_sync_sessions: { title: "Index sessions", annotations: READ_ONLY },
  corpuswire_sync_abort_session: { title: "Abort index session", annotations: { ...WRITE, destructiveHint: true } },
  corpuswire_index_activity: { title: "Index activity", annotations: READ_ONLY },
});

/** Tools listed by CORPUSWIRE_TOOL_PROFILE=core, for hosts where 23 tools crowd tool choice. */
export const CORE_TOOL_NAMES = Object.freeze(new Set([
  "corpuswire_search",
  "corpuswire_enhance_prompt",
  "corpuswire_doctor",
  "corpuswire_rate_result",
  "corpuswire_sync_delta",
  "corpuswire_sync_flush",
]));

export function readToolProfile(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "core" ? "core" : "full";
}

/** Add titles and annotations to built-in tools and apply the tool profile. */
export function decorateTools(tools, profile = "full") {
  return tools
    .filter((tool) => profile !== "core" || CORE_TOOL_NAMES.has(tool.name))
    .map((tool) => {
      const metadata = TOOL_METADATA[tool.name];
      return metadata ? { ...tool, title: metadata.title, annotations: { title: metadata.title, ...metadata.annotations } } : tool;
    });
}
