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
import type { GitIgnoreMatcher } from "./gitignore.js";
export declare const COMMIT_DOCUMENT_PREFIX = ".corpuswire/commits/";
export declare const COMMIT_HISTORY_MAX_COMMITS_CAP = 2000;
export declare const COMMIT_HISTORY_DEFAULT_SINCE_DAYS = 365;
export declare const COMMIT_HISTORY_GIT_TIMEOUT_MS = 60000;
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
export declare function commitDocumentPath(sha: string): string;
/** Return whether a path names a client-generated commit document. */
export declare function isCommitDocumentPath(relativePath: string): boolean;
/** Git config overrides placed before every commit-history command. */
export declare const COMMIT_HISTORY_GIT_CONFIG: readonly string[];
/** Environment overrides for commit-history git commands (merge into the caller's environment). */
export declare function commitHistoryGitEnvironment(base: Record<string, string | undefined>): Record<string, string | undefined>;
/** Return one document per eligible recent commit, newest first. */
export declare function loadCommitHistoryDocuments(options: CommitHistoryOptions): Promise<CommitDocument[]>;
/** Read recent commits; resolves to [] on any git failure. */
export declare function readCommitHistory(options: CommitHistoryOptions): Promise<CommitRecord[]>;
/** Parse `git log -z --numstat` output written with the commit-history format. */
export declare function parseCommitLog(output: string, shallow?: ReadonlySet<string>): CommitRecord[];
/** Render one commit exactly as the server's `render_commit_document` text. */
export declare function renderCommitDocument(record: CommitRecord): Promise<CommitDocument>;
export declare function renderCommitDocumentText(record: CommitRecord): string;
/**
 * Return whether a changed path makes its commit ineligible: the server's
 * `is_ignored_document_path`, `is_sensitive_terraform_path` and, when a
 * matcher is given, `.gitignore`.
 */
export declare function isCommitPathExcluded(relativePath: string, gitignore?: GitIgnoreMatcher): boolean;
