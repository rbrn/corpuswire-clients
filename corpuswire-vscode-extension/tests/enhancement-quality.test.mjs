import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { assessEnhancementQuality } from "../dist/enhancement-quality.js";
import { hasAuthorizationHeader } from "../dist/service-auth.js";

const authSource = (await readFile(new URL("../dist/service-auth.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
const extensionSource = await readFile(new URL("../dist/extension.js", import.meta.url), "utf8");
const authStart = extensionSource.indexOf("async function buildAuthenticatedServiceHeaders(");
const authEnd = extensionSource.indexOf("\nclass PromptEnhancerPanel", authStart);
assert.ok(authStart > 0 && authEnd > authStart);

function cliResolver(execFile) {
  return new Function("execFile", `${authSource}\nreturn resolveCliBearerToken;`)(execFile);
}

function headerResolver(resolveToken) {
  return new Function("buildRemoteServiceHeaders", "hasAuthorizationHeader", "resolveCliBearerToken",
    `${extensionSource.slice(authStart, authEnd)}; return buildAuthenticatedServiceHeaders;`)(
    (service) => ({ ...service.headers }), hasAuthorizationHeader, resolveToken,
  );
}

function result(overrides = {}) {
  return {
    retrieved_chunks: [{ chunk_id: "one" }],
    citations: ["src/example.ts#function-run"],
    retrieval_warning: null,
    retrieval_confidence: 0.72,
    retrieval_not_found: false,
    ...overrides,
  };
}

test("reports a cited retrieval result as grounded", () => {
  const quality = assessEnhancementQuality(result());

  assert.equal(quality.status, "grounded");
  assert.match(quality.message, /Grounded in 1 workspace chunk/);
  assert.match(quality.message, /72% confidence/);
});

test("does not present stale retrieval as successful", () => {
  const quality = assessEnhancementQuality(result({
    retrieval_warning: "Index freshness is unknown because the pre-read sync timed out.",
  }));

  assert.equal(quality.status, "degraded");
  assert.match(quality.message, /pre-read sync timed out/);
  assert.match(quality.message, /reconcile the index/i);
});

test("reports a context-free rewrite as ungrounded", () => {
  const quality = assessEnhancementQuality(result({
    retrieved_chunks: [],
    citations: [],
    retrieval_not_found: true,
  }));

  assert.equal(quality.status, "ungrounded");
  assert.match(quality.message, /No workspace context was found/);
});

test("reports low-confidence or uncited results as degraded", () => {
  const quality = assessEnhancementQuality(result({
    citations: [],
    retrieval_confidence: 0.21,
  }));

  assert.equal(quality.status, "degraded");
  assert.match(quality.message, /21%/);
  assert.match(quality.message, /no source citations/);
});

test("CLI bearer lookup uses the resource CLI/service URL and retains installed safety bounds", async () => {
  const calls = [];
  const resolve = cliResolver((executable, args, options, callback) => {
    calls.push({ executable, args, options });
    callback(null, "  synthetic-fixture-token\n");
  });
  assert.equal(await resolve("https://fixture.example/index", " /fixture/corpuswire "), "synthetic-fixture-token");
  assert.deepEqual(calls[0].args, ["auth", "token", "--base-url", "https://fixture.example/index"]);
  assert.equal(calls[0].executable, "/fixture/corpuswire");
  assert.deepEqual(calls[0].options, { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
  await resolve("https://fixture.example/index", "  ");
  assert.equal(calls[1].executable, "corpuswire");
});

test("CLI absence and empty token output preserve unauthenticated fallback without exposing errors", async () => {
  const missing = cliResolver((_executable, _args, _options, callback) => callback(new Error("synthetic executable unavailable")));
  const empty = cliResolver((_executable, _args, _options, callback) => callback(null, " \n"));
  assert.equal(await missing("https://fixture.example"), null);
  assert.equal(await empty("https://fixture.example"), null);
});

test("explicit Authorization of any case takes precedence without invoking the CLI", async () => {
  const build = headerResolver(async () => { throw new Error("Explicit Authorization must skip CLI lookup"); });
  for (const header of ["Authorization", "authorization", "AUTHORIZATION"]) {
    const headers = { [header]: "Basic synthetic-fixture", "X-Fixture": "safe" };
    assert.deepEqual(await build({ auth: { cliPath: "/fixture/cli" } }, { url: "https://fixture.example", headers }), headers);
  }
});

test("service header fallback adds CLI bearer only for the selected resource and service URL", async () => {
  const calls = [];
  const build = headerResolver(async (url, cliPath) => { calls.push({ url, cliPath }); return "synthetic-fixture-token"; });
  const headers = await build({ auth: { cliPath: "/fixture/root-two-cli" } }, {
    url: "https://fixture.example/root-two", headers: { "X-Fixture": "safe" },
  });
  assert.deepEqual(calls, [{ url: "https://fixture.example/root-two", cliPath: "/fixture/root-two-cli" }]);
  assert.deepEqual(headers, { "X-Fixture": "safe", Authorization: "Bearer synthetic-fixture-token" });
  const unavailable = headerResolver(async () => null);
  assert.deepEqual(await unavailable({ auth: { cliPath: "/fixture/cli" } }, { url: "https://fixture.example", headers: { "X-Fixture": "safe" } }), { "X-Fixture": "safe" });
});

test("manifest retains resource-scoped CLI auth configuration from installed 0.1.7", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.contributes.configuration.properties["corpuswire.auth.cliPath"].default, "corpuswire");
  assert.equal(manifest.contributes.configuration.properties["corpuswire.auth.cliPath"].scope, "resource");
});
