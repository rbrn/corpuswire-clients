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

export const INDEX_INCLUDE_GLOB = `{${patterns.map((pattern) =>
  pattern.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`),
).join(",")}}`;
