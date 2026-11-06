SDK 0.1.6 adds `ensureWorkspace()` and `selfOnboard()`. `ensureWorkspace()` asks the engine (`POST /v1/workspaces/ensure`) to register a folder's workspace, and `selfOnboard()` creates a tenant and token on a local service. `cw init` uses both.

Breaking: the review-context v1/v2 methods (request, poll, status, purge, capabilities, telemetry), the GitHub provider binding helpers and their types are removed, because the engine archived the review sidecar. The Codebase catalog methods and the review-context/v1 error envelope are kept.

Validation: 242 SDK tests pass (1 skipped) and `tsc` is clean.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.40-beta.1.
