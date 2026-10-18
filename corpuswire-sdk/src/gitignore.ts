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

export const GITIGNORE_FILENAME = ".gitignore";
export const GIT_INFO_EXCLUDE_PATH = ".git/info/exclude";

/** Returns the text of a workspace-relative ignore file, or null/undefined when it does not exist. */
export type GitIgnoreFileReader = (relativePath: string) => string | null | undefined;

interface GitIgnoreRule {
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

/** Parse one ignore file into rules, in file order. */
function parseIgnoreFile(text: string): GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    const rule = parseIgnoreLine(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseIgnoreLine(rawLine: string): GitIgnoreRule | null {
  let line = stripTrailingSpaces(rawLine);
  if (!line || line.startsWith("#")) return null;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }
  let directoryOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    directoryOnly = true;
    line = line.replace(/\/+$/, "");
  }
  if (!line) return null;
  // A slash at the start or in the middle anchors the pattern to the
  // directory of the ignore file; otherwise it matches a name at any depth.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.replace(/^\/+/, "");
  if (!line) return null;
  const body = anchored ? translateAnchored(line) : `(?:.*/)?${translateSegment(line)}`;
  try {
    return { regex: new RegExp(`^${body}$`, "s"), negated, directoryOnly };
  } catch {
    return null;
  }
}

/** Drop unescaped trailing spaces, as git does. */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

function translateAnchored(pattern: string): string {
  const segments = pattern.split("/");
  let regex = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (segment === "**") {
      if (last) {
        // `dir/**` matches everything inside `dir`, not `dir` itself; a bare
        // `/**` matches everything.
        regex += ".+";
        continue;
      }
      // Leading or middle `**/`: zero or more directories.
      regex += "(?:.*/)?";
      continue;
    }
    regex += translateSegment(segment);
    if (!last) regex += "/";
  }
  return regex;
}

/** Translate one path segment's glob (no slashes) to a regex fragment. */
function translateSegment(segment: string): string {
  let regex = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\") {
      index += 1;
      if (index < segment.length) regex += escapeRegex(segment[index]);
      continue;
    }
    if (char === "*") {
      while (segment[index + 1] === "*") index += 1;
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    if (char === "[") {
      const parsed = translateClass(segment, index);
      if (parsed) {
        regex += parsed.regex;
        index = parsed.end;
        continue;
      }
      // An unterminated bracket expression never matches (git's wildmatch).
      regex += "(?!)";
      continue;
    }
    regex += escapeRegex(char);
  }
  return regex;
}

function translateClass(segment: string, start: number): { regex: string; end: number } | null {
  let index = start + 1;
  let negated = false;
  if (segment[index] === "!" || segment[index] === "^") {
    negated = true;
    index += 1;
  }
  let body = "";
  let first = true;
  while (index < segment.length) {
    const char = segment[index];
    if (char === "]" && !first) {
      if (!body) return null;
      return { regex: `(?!/)[${negated ? "^" : ""}${body}]`, end: index };
    }
    first = false;
    if (char === "\\" && index + 1 < segment.length) {
      index += 1;
      body += escapeClassChar(segment[index]);
    } else if (char === "-" && body && segment[index + 1] !== "]" && index + 1 < segment.length) {
      body += "-";
    } else {
      body += escapeClassChar(char);
    }
    index += 1;
  }
  return null;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

function escapeClassChar(char: string): string {
  return /[\]\\^\-[]/.test(char) ? `\\${char}` : char;
}

/** Return true (ignored), false (negated) or null (no rule matched). */
function decide(rules: readonly GitIgnoreRule[], entryPath: string, isDir: boolean): boolean | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule.directoryOnly && !isDir) continue;
    if (rule.regex.test(entryPath)) return !rule.negated;
  }
  return null;
}

/** Decide whether workspace-relative POSIX paths are ignored by git rules. */
export class GitIgnoreMatcher {
  private readonly readFile: GitIgnoreFileReader;
  private readonly files = new Map<string, GitIgnoreRule[] | null>();
  private readonly directories = new Map<string, boolean>();

  /** Ignore files are loaded lazily through `readFile` and cached for the matcher's lifetime. */
  constructor(readFile: GitIgnoreFileReader) {
    this.readFile = readFile;
  }

  /** Build a matcher from in-memory ignore files keyed by relative path. */
  static fromSources(sources: Readonly<Record<string, string>>): GitIgnoreMatcher {
    const files = new Map(Object.entries(sources));
    return new GitIgnoreMatcher((relativePath) => files.get(relativePath));
  }

  /** Return whether git would ignore the path (or one of its directories). */
  isIgnored(relativePath: string, options: { isDir?: boolean } = {}): boolean {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) return false;
    const parts = normalized.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (this.isDirectoryIgnored(parts.slice(0, depth).join("/"))) return true;
    }
    if (options.isDir === true) return this.isDirectoryIgnored(normalized);
    return this.decideEntry(parts, false);
  }

  private isDirectoryIgnored(directory: string): boolean {
    let cached = this.directories.get(directory);
    if (cached === undefined) {
      cached = this.decideEntry(directory.split("/"), true);
      this.directories.set(directory, cached);
    }
    return cached;
  }

  private decideEntry(parts: readonly string[], isDir: boolean): boolean {
    // Highest precedence first: the deepest .gitignore among the entry's
    // parent directories, up to the root one, then .git/info/exclude.
    for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
      const base = parts.slice(0, depth).join("/");
      const rules = this.load(base ? `${base}/${GITIGNORE_FILENAME}` : GITIGNORE_FILENAME);
      if (!rules) continue;
      const decision = decide(rules, parts.slice(depth).join("/"), isDir);
      if (decision !== null) return decision;
    }
    const exclude = this.load(GIT_INFO_EXCLUDE_PATH);
    if (exclude) {
      const decision = decide(exclude, parts.join("/"), isDir);
      if (decision !== null) return decision;
    }
    return false;
  }

  private load(relativePath: string): GitIgnoreRule[] | null {
    if (!this.files.has(relativePath)) {
      let text: string | null | undefined;
      try {
        text = this.readFile(relativePath);
      } catch {
        text = null;
      }
      this.files.set(relativePath, typeof text === "string" ? parseIgnoreFile(text) : null);
    }
    return this.files.get(relativePath) ?? null;
  }
}
