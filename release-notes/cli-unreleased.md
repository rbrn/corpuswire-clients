Unreleased CLI and SDK changes (needs engine `POST /v1/workspaces/ensure`; older engines are handled):

- `cw init` on a local service now registers the folder's workspace and indexes it. `--no-index` keeps the old settings-only behavior. With no saved credential, it creates a tenant through self-onboarding and saves the token, owner-only, in `~/.local/share/corpuswire/cli-credentials.json`.
- When the service refuses a workspace (403) before indexing, `cw` asks the service to register it once and retries. Errors now say whether credentials are missing or the workspace was refused, still without echoing server text.
- Behavior change: `cw search`, `cw enhance` and `cw health` in a folder with no index now keep that folder's workspace and answer without repository context. They no longer fall back to the backend default workspace, which gave context from an unrelated repository.
- SDK: `ensureWorkspace()` and `selfOnboard()`.

Validation: 128 of 138 CLI tests pass. The 10 failures are the watch-mode tests that already fail on the Mac on main (same list). SDK: 242 tests pass and `tsc` is clean.
