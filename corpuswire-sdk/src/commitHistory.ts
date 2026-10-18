/**
 * Render recent git commits as virtual Markdown documents (CRP-001 M2.1 client upload).
 *
 * This mirrors the server's `corpuswire.ingest.commit_history`: one document per
 * commit at `.corpuswire/commits/<full sha>.md` with the subject and body, the
 * author name, the ISO author date, the parents and the diff stat per changed
 * path. Diff bodies are never read; email addresses are removed from the
 * author and the message; bodies are capped at 4,000 characters, the path list
 * at 200 entries and the commit count at 2,000. A commit that touches a path
 * the server refuses to index (dot directories, ignored build/vendor
 * directories, sensitive Terraform files and, when enabled, `.gitignore`
 * matches) is skipped entirely.
 *
 * The SDK has no runtime dependencies, so running git is injected: callers
 * pass `runGit(args)` (resolving to stdout, or null on any failure) and,
 * for shallow clones, `readTextFile(path)`. Only 40-character SHA-1 commits
 * are produced, because the remote indexer accepts exactly
 * `.corpuswire/commits/<40 hex>.md`.
 */

import { inventorySha256 } from "./inventory.js";
import type { GitIgnoreMatcher } from "./gitignore.js";

export const COMMIT_DOCUMENT_PREFIX = ".corpuswire/commits/";
export const COMMIT_HISTORY_MAX_COMMITS_CAP = 2000;
export const COMMIT_HISTORY_DEFAULT_SINCE_DAYS = 365;
export const COMMIT_HISTORY_GIT_TIMEOUT_MS = 60_000;
const MAX_BODY_CHARACTERS = 4000;
const MAX_LISTED_PATHS = 200;

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const RECORD_MARKER = "C";
// %H sha, %P parents, %an author name, %aI strict ISO author date, %B message.
const LOG_FORMAT = "%x1eC%x1f%H%x1f%P%x1f%an%x1f%aI%x1f%B%x1f";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)$/;
// Python's str.isspace() set, so strip() and `\s` behave as on the server.
const PY_SPACE = " \\t\\n\\r\\x0b\\x0c\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EMAIL_PATTERN = new RegExp(`[${PY_SPACE}]*<?[A-Za-z0-9._%+\\-]+@[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+>?`, "g");
const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`);
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`);

const IGNORED_DIR_NAMES = new Set([
  ".beads", ".git", ".idea", ".mypy_cache", ".openclaw", ".pytest_cache", ".ruff_cache",
  ".tmp-tests", ".trash", ".vscode", "__pycache__", "build", "dist", "node_modules", "obj",
  "Pods", "target",
]);
const SAFE_IGNORED_DIRECTORY_PATHS = new Set([".vscode/mcp.json.example"]);

export interface CommitFileStat {
  path: string;
  /** null for a binary file. */
  insertions: number | null;
  deletions: number | null;
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  author: string;
  /** Strict ISO 8601 author date as git prints it, e.g. 2026-10-17T12:00:00+02:00. */
  authoredAt: string;
  subject: string;
  body: string;
  files: CommitFileStat[];
  shallowBoundary: boolean;
}

export interface CommitDocument {
  relativePath: string;
  content: Uint8Array;
  text: string;
  sha256: string;
  /** Author date in nanoseconds since the epoch, used as the document timestamp. */
  mtimeNs: number;
  sha: string;
}

export type CommitHistoryGitRunner = (args: string[]) => Promise<string | null>;

export interface CommitHistoryOptions {
  runGit: CommitHistoryGitRunner;
  /** Reads a file that git names by path (relative paths are relative to the workspace root). */
  readTextFile?: (path: string) => Promise<string | null>;
  sinceDays?: number;
  maxCommits?: number;
  gitignore?: GitIgnoreMatcher;
  now?: Date;
}

export function commitDocumentPath(sha: string): string {
  return `${COMMIT_DOCUMENT_PREFIX}${sha}.md`;
}

/** Return whether a path names a client-generated commit document. */
export function isCommitDocumentPath(relativePath: string): boolean {
  return /^\.corpuswire\/commits\/[0-9a-f]{40}\.md$/.test(relativePath);
}

/** Git config overrides placed before every commit-history command. */
export const COMMIT_HISTORY_GIT_CONFIG = Object.freeze(["-c", "log.showSignature=false", "-c", "core.quotepath=off"]);

/** Environment overrides for commit-history git commands (merge into the caller's environment). */
export function commitHistoryGitEnvironment(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  // Never let an inherited repository override point git at another tree.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/** Return one document per eligible recent commit, newest first. */
export async function loadCommitHistoryDocuments(options: CommitHistoryOptions): Promise<CommitDocument[]> {
  const records = await readCommitHistory(options);
  const documents: CommitDocument[] = [];
  for (const record of records) {
    if (!SHA1_PATTERN.test(record.sha)) continue;
    if (record.files.some((stat) => isCommitPathExcluded(stat.path, options.gitignore))) continue;
    documents.push(await renderCommitDocument(record));
  }
  return documents;
}

/** Read recent commits; resolves to [] on any git failure. */
export async function readCommitHistory(options: CommitHistoryOptions): Promise<CommitRecord[]> {
  const sinceDays = options.sinceDays ?? COMMIT_HISTORY_DEFAULT_SINCE_DAYS;
  const limit = Math.max(0, Math.min(Math.trunc(options.maxCommits ?? COMMIT_HISTORY_MAX_COMMITS_CAP), COMMIT_HISTORY_MAX_COMMITS_CAP));
  if (!Number.isFinite(limit) || limit === 0 || !(sinceDays > 0)) return [];
  const run = async (args: string[]): Promise<string | null> => {
    try {
      return await options.runGit(args);
    } catch {
      return null;
    }
  };
  if (await run(["rev-parse", "--is-inside-work-tree"]) !== "true\n") return [];
  const prefix = await run(["rev-parse", "--show-prefix"]);
  if (prefix === null) return [];
  // Limit a subdirectory workspace to its own commits. The repository root
  // uses no pathspec, so git's history simplification never hides commits.
  const pathspec = prefix.trim() ? ["--", "."] : [];
  const cutoff = new Date((options.now ?? new Date()).getTime() - sinceDays * 86_400_000);
  const logArgs = [
    "log", "-z", "--no-renames", "--numstat", "--relative", `--format=${LOG_FORMAT}`,
    `--since=${cutoff.toISOString()}`, `--max-count=${limit}`,
  ];
  let output = await run([...logArgs, "--diff-merges=first-parent", ...pathspec]);
  // Older git (< 2.31) has no --diff-merges; merges then carry no stat.
  if (output === null) output = await run([...logArgs, ...pathspec]);
  if (output === null) return [];
  const shallow = await shallowBoundaries(run, options.readTextFile);
  return parseCommitLog(output, shallow).slice(0, limit);
}

/** Parse `git log -z --numstat` output written with the commit-history format. */
export function parseCommitLog(output: string, shallow: ReadonlySet<string> = new Set()): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const raw of output.split(RECORD_SEPARATOR)) {
    const record = parseRecord(raw, shallow);
    if (record) records.push(record);
  }
  return records;
}

function parseRecord(raw: string, shallow: ReadonlySet<string>): CommitRecord | null {
  if (!raw.startsWith(RECORD_MARKER + FIELD_SEPARATOR)) return null;
  const parts = splitLimit(raw, FIELD_SEPARATOR, 6);
  if (parts.length !== 7) return null;
  const [, rawSha, parentsText, author, dateText, message, statsText] = parts;
  const sha = pyStrip(rawSha);
  if (!SHA_PATTERN.test(sha)) return null;
  let authoredAt = pyStrip(dateText);
  if (!ISO_DATE_PATTERN.test(authoredAt) || !Number.isFinite(Date.parse(authoredAt))) return null;
  if (authoredAt.endsWith("Z")) authoredAt = `${authoredAt.slice(0, -1)}+00:00`;
  const parents = parentsText.split(/\s+/).filter((parent) => SHA_PATTERN.test(parent));
  const cleaned = pyStrip(stripEmails(message));
  const newline = cleaned.indexOf("\n");
  const subject = newline === -1 ? cleaned : cleaned.slice(0, newline);
  const body = newline === -1 ? "" : cleaned.slice(newline + 1);
  const boundary = shallow.has(sha);
  return {
    sha,
    parents,
    author: pyStrip(stripEmails(author)),
    authoredAt,
    subject: pyStrip(subject),
    body: pyStrip(body),
    files: boundary ? [] : parseNumstat(statsText),
    shallowBoundary: boundary,
  };
}

function parseNumstat(statsText: string): CommitFileStat[] {
  const stats: CommitFileStat[] = [];
  const seen = new Set<string>();
  for (const rawEntry of statsText.split("\0")) {
    const entry = rawEntry.replace(/^\n+|\n+$/g, "");
    if (!entry) continue;
    const columns = splitLimit(entry, "\t", 2);
    if (columns.length !== 3 || !columns[2] || seen.has(columns[2])) continue;
    const [added, deleted, path] = columns;
    seen.add(path);
    stats.push({
      path,
      insertions: /^[0-9]+$/.test(added) ? Number.parseInt(added, 10) : null,
      deletions: /^[0-9]+$/.test(deleted) ? Number.parseInt(deleted, 10) : null,
    });
  }
  return stats;
}

/** Render one commit exactly as the server's `render_commit_document` text. */
export async function renderCommitDocument(record: CommitRecord): Promise<CommitDocument> {
  const text = renderCommitDocumentText(record);
  const content = new TextEncoder().encode(text);
  return {
    relativePath: commitDocumentPath(record.sha),
    content,
    text,
    sha256: await inventorySha256(content),
    mtimeNs: Date.parse(record.authoredAt) * 1_000_000,
    sha: record.sha,
  };
}

export function renderCommitDocumentText(record: CommitRecord): string {
  const shortSha = record.sha.slice(0, 12);
  const subject = record.subject || "(no subject)";
  const listed = record.files.slice(0, MAX_LISTED_PATHS);
  const insertions = record.files.reduce((sum, stat) => sum + (stat.insertions ?? 0), 0);
  const deletions = record.files.reduce((sum, stat) => sum + (stat.deletions ?? 0), 0);
  const lines = [
    `# Commit ${shortSha}: ${subject}`,
    "",
    `- Commit: ${record.sha}`,
    `- Author: ${record.author || "unknown"}`,
    `- Date: ${record.authoredAt}`,
  ];
  if (record.parents.length > 0) lines.push(`- Parents: ${record.parents.map((parent) => parent.slice(0, 12)).join(", ")}`);
  if (record.parents.length > 1) lines.push("- Kind: merge commit; changes are listed against the first parent");
  if (record.shallowBoundary) lines.push("- Changes: unknown (shallow clone boundary)");
  else lines.push(`- Files changed: ${record.files.length} (+${insertions} -${deletions})`);
  lines.push("", "## Message", "", subject);
  if (record.body) {
    let body = record.body;
    const codePoints = Array.from(body);
    if (codePoints.length > MAX_BODY_CHARACTERS) {
      body = `${pyRstrip(codePoints.slice(0, MAX_BODY_CHARACTERS).join(""))}\n\n[message truncated]`;
    }
    lines.push("", body);
  }
  if (listed.length > 0) {
    lines.push("", "## Changed files", "");
    for (const stat of listed) lines.push(`- \`${stat.path}\` ${formatStat(stat)}`);
    if (record.files.length > listed.length) lines.push(`- and ${record.files.length - listed.length} more`);
  }
  return `${lines.join("\n")}\n`;
}

function formatStat(stat: CommitFileStat): string {
  if (stat.insertions === null || stat.deletions === null) return "(binary)";
  return `(+${stat.insertions} -${stat.deletions})`;
}

/**
 * Return whether a changed path makes its commit ineligible: the server's
 * `is_ignored_document_path`, `is_sensitive_terraform_path` and, when a
 * matcher is given, `.gitignore`.
 */
export function isCommitPathExcluded(relativePath: string, gitignore?: GitIgnoreMatcher): boolean {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  const normalized = parts.join("/");
  if (!SAFE_IGNORED_DIRECTORY_PATHS.has(normalized)
    && parts.some((part) => part.startsWith(".") || IGNORED_DIR_NAMES.has(part) || part.startsWith(".venv"))) {
    return true;
  }
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (name.endsWith(".tfvars") || name.endsWith(".tfvars.json") || name.includes(".tfstate")
    || name === "crash.log" || name === "tfplan"
    || name.endsWith(".tfplan") || name.endsWith(".plan") || name.endsWith(".plan.json")) {
    return true;
  }
  return gitignore !== undefined && gitignore.isIgnored(relativePath, { isDir: false });
}

async function shallowBoundaries(
  run: (args: string[]) => Promise<string | null>,
  readTextFile: CommitHistoryOptions["readTextFile"],
): Promise<Set<string>> {
  if (!readTextFile || await run(["rev-parse", "--is-shallow-repository"]) !== "true\n") return new Set();
  const shallowPath = await run(["rev-parse", "--git-path", "shallow"]);
  if (!shallowPath) return new Set();
  let text: string | null;
  try {
    text = await readTextFile(shallowPath.trim());
  } catch {
    text = null;
  }
  return new Set((text ?? "").split(/\s+/).filter((line) => SHA_PATTERN.test(line)));
}

function splitLimit(value: string, separator: string, maxSplit: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (parts.length < maxSplit) {
    const index = rest.indexOf(separator);
    if (index === -1) break;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + separator.length);
  }
  parts.push(rest);
  return parts;
}

function stripEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, "");
}

function pyStrip(text: string): string {
  return text.replace(LEADING_SPACE, "").replace(TRAILING_SPACE, "");
}

function pyRstrip(text: string): string {
  return text.replace(TRAILING_SPACE, "");
}
