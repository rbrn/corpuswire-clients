import assert from "node:assert/strict";
import test from "node:test";

import { deriveDefaultWorkspaceId } from "../dist/workspace-identity.js";

test("derives a stable local Docker identity for a local workspace", () => {
  assert.equal(
    deriveDefaultWorkspaceId({
      scheme: "file",
      name: "Health",
      uri: "file:///Users/example/health",
    }),
    "local-docker://health#main",
  );
});

test("normalizes local workspace names into safe slugs", () => {
  assert.equal(
    deriveDefaultWorkspaceId({
      scheme: "file",
      name: "AI Account Balance",
      uri: "file:///Users/example/AI%20Account%20Balance",
    }),
    "local-docker://ai-account-balance#main",
  );
});

test("preserves non-file workspace identities", () => {
  assert.equal(
    deriveDefaultWorkspaceId({
      scheme: "vscode-remote",
      name: "remote-project",
      uri: "vscode-remote://ssh-remote+host/workspace",
    }),
    "vscode-remote://ssh-remote+host/workspace",
  );
});
