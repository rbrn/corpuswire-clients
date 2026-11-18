VS Code extension 0.1.11 keeps the index current after bulk git changes (rbrn/corpuswire#285, #55).

- The extension watches `.git/HEAD` and `.git/ORIG_HEAD` at each workspace root. A checkout, switch, reset, pull, merge or rebase triggers one full reconciliation of that root, which replaces any queued per-file events. Before this, a `git reset` left the published index stale until the next manual index run.

The package bundles SDK 0.1.7. `vsce package` cannot follow the `file:../corpuswire-sdk` link, so the VSIX is packed from a staging folder holding the compiled extension and a copy of the SDK's `dist`. Install with `code --install-extension corpuswire-vscode-0.1.11.vsix`. Roll back by reinstalling the 0.1.10 VSIX.
