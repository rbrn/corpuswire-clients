CLI 0.1.5-beta.4 fixes Ctrl+P rewrites timing out on the bare `cw` start screen.

- Prompt editor: Ctrl+P rewrites now get a 3-minute deadline instead of the watch client's 30-second limit, so model-backed rewrites of long prompts (about 30 s on the personal service) no longer fail with "Watch HTTP request timed out." Ctrl+C still cancels. Every other watch request keeps its existing deadline. `cw enhance` was not affected.

The archive bundles MCP 0.1.5-beta.2 and SDK 0.1.6, unchanged since the 0.1.5-beta.2 release. Install it together with those archives.

Known limit: the macOS watch-mode test failures listed for 0.1.5-beta.2 are unchanged. One-shot commands work.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.41-beta.1.
