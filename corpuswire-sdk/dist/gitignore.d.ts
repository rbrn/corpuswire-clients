/**
 * Match workspace paths against git ignore rules (CRP-001 M3.1 client parity).
 *
 * This mirrors the server's `corpuswire.ingest.gitignore.GitIgnoreMatcher`: the
 * root `.gitignore`, nested `.gitignore` files (each relative to its own
 * directory) and `.git/info/exclude`. Precedence follows git: a deeper
 * `.gitignore` beats a shallower one, the root `.gitignore` beats
 * `.git/info/exclude`, and inside one file the last matching pattern wins. A
 * path inside an ignored directory stays ignored even when a later pattern
 * negates it, because git never descends into an ignored directory.
 *
 * Not covered, as on the server: `core.excludesFile`, `core.ignorecase`
 * (matching is always case-sensitive) and the git index (a tracked file that
 * matches an ignore pattern is still treated as ignored).
 *
 * The gitwildmatch translation is written here so the SDK keeps zero runtime
 * dependencies. The shared fixture `tests/fixtures/gitignore_cases.json`
 * (vendored from the server repository) pins the behavior for both languages.
 */
export declare const GITIGNORE_FILENAME = ".gitignore";
export declare const GIT_INFO_EXCLUDE_PATH = ".git/info/exclude";
/** Returns the text of a workspace-relative ignore file, or null/undefined when it does not exist. */
export type GitIgnoreFileReader = (relativePath: string) => string | null | undefined;
/** Decide whether workspace-relative POSIX paths are ignored by git rules. */
export declare class GitIgnoreMatcher {
    private readonly readFile;
    private readonly files;
    private readonly directories;
    /** Ignore files are loaded lazily through `readFile` and cached for the matcher's lifetime. */
    constructor(readFile: GitIgnoreFileReader);
    /** Build a matcher from in-memory ignore files keyed by relative path. */
    static fromSources(sources: Readonly<Record<string, string>>): GitIgnoreMatcher;
    /** Return whether git would ignore the path (or one of its directories). */
    isIgnored(relativePath: string, options?: {
        isDir?: boolean;
    }): boolean;
    private isDirectoryIgnored;
    private decideEntry;
    private load;
}
