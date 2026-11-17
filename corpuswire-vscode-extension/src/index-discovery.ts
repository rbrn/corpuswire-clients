// VS Code glob matching is case-sensitive on some filesystems. Expand each
// filename letter to a character class so scanning and watching agree with
// the server's case-insensitive supported-file registry.
const extensions = [
  "md", "txt", "csv", "pdf", "bat", "scala", "sh", "cjs", "js", "jsx", "mjs",
  "cts", "mts", "ts", "tsx", "java", "kt", "kts", "py", "pyi", "hcl", "tf",
  "html", "htm", "json", "jsonl", "ndjson", "toml", "yaml", "yml",
];

// VS Code's native glob matcher does not support nested brace alternatives.
// Keep each branch complete so the outer group also works for file watchers.
const patterns = [
  ...extensions.map((extension) => `**/*.${extension}`),
  "**/mvnw",
  "**/gradlew",
  "**/*.json.example",
];

function caseInsensitiveGlob(globPatterns: readonly string[]): string {
  return `{${globPatterns.map((pattern) =>
    pattern.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`),
  ).join(",")}}`;
}

// Kept byte-for-byte: the scan's ignore digest embeds this glob, and the server
// rejects deltas whose selection policy digest differs from its coverage.
export const INDEX_INCLUDE_GLOB = caseInsensitiveGlob(patterns);

// IDX-004: build files (`build.gradle.kts` is already covered by `kts`). Full scans use this
// glob only when the server reports build_files_enabled; isRetrievalExcludedPath still
// removes lockfiles, Maven settings and secret-named build files.
const buildFileExtensions = ["xml", "properties", "gradle"];
export const INDEX_INCLUDE_GLOB_WITH_BUILD_FILES = caseInsensitiveGlob([
  ...patterns,
  ...buildFileExtensions.map((extension) => `**/*.${extension}`),
]);
