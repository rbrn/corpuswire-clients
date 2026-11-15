MCP 0.1.5-beta.3 re-vendors SDK 0.1.7, so the MCP sync tools share the SDK's `reports/retrieval-failures/` exclusion and the `allowSourceSwitch` request field added in #56. The vendored copy was stale on main after #54 and #56.

Known limit: the MCP sync tools still do not read `.gitignore`, wait for git operations or apply the large-rewrite brake. Use `cw` for full reconciles.
