CLI 0.1.5-beta.3 lets the `cw` prompt editor save a draft to a file.

- Prompt editor: Ctrl+S saves the draft to a new Markdown file and shows the path on the status line. The draft stays in the box. Files go to `.corpuswire/prompts/` under the workspace root (with a `.gitignore` so they stay out of git), or to `$CORPUSWIRE_PROMPT_DIR` when set. Files are owner-only and never overwritten. The key is listed in the shortcut row and the `?` list.

The archive bundles MCP 0.1.5-beta.2 and SDK 0.1.6, unchanged since the 0.1.5-beta.2 release. Install it together with those archives.

Known limit: the macOS watch-mode test failures listed for 0.1.5-beta.2 are unchanged. One-shot commands work.

Download the archive with its SHA256 file. This is a GitHub prerelease; npm publication is not claimed. The coordinated runtime is v0.1.41-beta.1.
