// VS Code glob matching is case-sensitive on some filesystems. Expand each
// filename letter to a character class so scanning and watching agree with
// the server's case-insensitive supported-file registry.
const patterns = [
  "**/*.{md,txt,csv,pdf,bat,scala,sh,cjs,js,jsx,mjs,cts,mts,ts,tsx,java,kt,kts,py,pyi,hcl,tf,html,htm,json,jsonl,ndjson,toml,yaml,yml}",
  "**/{mvnw,gradlew}",
  "**/*.json.example",
];

export const INDEX_INCLUDE_GLOB = `{${patterns.map((pattern) =>
  pattern.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`),
).join(",")}}`;
