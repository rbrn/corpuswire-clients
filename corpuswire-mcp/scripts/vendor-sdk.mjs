#!/usr/bin/env node

import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
  throw new Error("Usage: node clients/corpuswire-mcp/scripts/vendor-sdk.mjs --write|--check");
}

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientsRoot = path.resolve(mcpRoot, "..");
const sdkDist = path.join(clientsRoot, "corpuswire-sdk", "dist");
const vendorDist = path.join(mcpRoot, "vendor", "corpuswire-sdk", "dist");
const files = Object.freeze([
  "client.d.ts",
  "client.js",
  "http.d.ts",
  "http.js",
  "inventory.js",
  "inventory.d.ts",
  "index.d.ts",
  "index.js",
  "types.d.ts",
  "types.js",
]);

if (mode === "--write") {
  await mkdir(vendorDist, { recursive: true });
  for (const file of files) {
    await copyFile(path.join(sdkDist, file), path.join(vendorDist, file));
  }
  console.log(`Vendored ${files.length} deterministic SDK artifacts into ${vendorDist}`);
} else {
  const mismatches = [];
  for (const file of files) {
    const [source, vendored] = await Promise.all([
      readFile(path.join(sdkDist, file)),
      readFile(path.join(vendorDist, file)),
    ]);
    if (!source.equals(vendored)) {
      mismatches.push(file);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Vendored SDK artifacts are stale: ${mismatches.join(", ")}`);
  }
  console.log(`Verified byte parity for ${files.length} vendored SDK artifacts`);
}
