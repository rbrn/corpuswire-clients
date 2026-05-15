import * as vscode from "vscode";
import { CorpusWireClient, CorpusWireHttpError } from "@corpuswire/sdk";
import type { EnhancePromptRequest, PromptOutputMode, PromptRewriteResult } from "@corpuswire/sdk";

const CONFIG_SECTION = "corpuswireContextEngine";
const FALLBACK_BASE_URL = "http://127.0.0.1:8000";
const VALID_OUTPUT_MODES: ReadonlySet<string> = new Set<string>([
  "generic",
  "copilot",
  "claude-code",
  "sequential",
]);

// Extend PromptRewriteResult with fields that older server versions may return under
// different names so the extension degrades gracefully across backend versions.
type PromptRewriteResultCompat = PromptRewriteResult & {
  rewritten_prompt?: string;
  augmented_prompt?: string;
};

// ---------------------------------------------------------------------------
// Webview message shapes (extension ↔ webview)
// ---------------------------------------------------------------------------
interface EnhanceMessage { type: "enhance"; prompt: string }
interface InsertMessage  { type: "insert";  text: string }
type WebviewInbound = EnhanceMessage | InsertMessage;

interface ResultMessage  { type: "result";  text: string }
interface ErrorMessage   { type: "error";   message: string }
interface LoadingMessage { type: "loading"; value: boolean }
interface SeedMessage    { type: "seed";    prompt: string }
type WebviewOutbound = ResultMessage | ErrorMessage | LoadingMessage | SeedMessage;

// ---------------------------------------------------------------------------
// Singleton webview panel
// ---------------------------------------------------------------------------
class ContextEnginePanel {
  static readonly viewType = "corpuswireContextEngine.panel";
  private static _current: ContextEnginePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const seed = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.document.getText(
          vscode.window.activeTextEditor.selection,
        )
      : "";

    if (ContextEnginePanel._current) {
      ContextEnginePanel._current._panel.reveal(column);
      if (seed.trim()) {
        ContextEnginePanel._current._post({ type: "seed", prompt: seed });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ContextEnginePanel.viewType,
      "CorpusWire Context Engine",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    ContextEnginePanel._current = new ContextEnginePanel(panel, context, seed);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _context: vscode.ExtensionContext,
    initialSeed: string,
  ) {
    this._panel = panel;
    this._panel.webview.html = buildWebviewHtml(panel.webview, initialSeed);

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: unknown) => void this._handleMessage(msg as WebviewInbound),
      null,
      this._disposables,
    );
  }

  private _post(msg: WebviewOutbound): void {
    void this._panel.webview.postMessage(msg);
  }

  private async _handleMessage(msg: WebviewInbound): Promise<void> {
    if (msg.type === "insert") {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await editor.edit((b) => b.replace(editor.selection, msg.text));
      } else {
        void vscode.window.showWarningMessage("No active editor to insert into.");
      }
      return;
    }

    if (msg.type === "enhance") {
      const resource = vscode.window.activeTextEditor?.document.uri;
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
      const baseUrl = resolveBaseUrl(config.get<string>("baseUrl", ""));
      const workspaceId = config.get<string>("workspaceId", "").trim();
      const outputMode = resolveOutputMode(config.get<string>("outputMode", "generic"));

      const client = new CorpusWireClient({ baseUrl, endpointMode: "v1-only" });
      const request: EnhancePromptRequest = {
        prompt: msg.prompt,
        outputMode,
        ...(workspaceId ? { workspaceId } : {}),
      };

      this._post({ type: "loading", value: true });
      try {
        const result = await client.enhance(request);
        const text = resolveReplacement(result);
        if (!text) {
          throw new Error(result.generation_error ?? "The service returned no enhanced prompt.");
        }
        this._post({ type: "result", text });
      } catch (error) {
        this._post({ type: "error", message: formatError(error, baseUrl) });
      } finally {
        this._post({ type: "loading", value: false });
      }
    }
  }

  private _dispose(): void {
    ContextEnginePanel._current = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------
function buildWebviewHtml(webview: vscode.Webview, seed: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const escapedSeed = escapeHtml(seed);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CorpusWire Context Engine</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      height: 100vh;
    }
    h2 { margin: 0; font-size: 1.1em; font-weight: 600; }
    label { font-size: 0.85em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; display: block; }
    textarea {
      width: 100%;
      flex: 1;
      min-height: 120px;
      resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 8px;
      font-family: inherit;
      font-size: inherit;
      line-height: 1.5;
    }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
    textarea[readonly] { background: var(--vscode-textBlockQuote-background, var(--vscode-input-background)); opacity: 0.9; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button {
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: inherit;
      font-family: inherit;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    #status {
      font-size: 0.85em;
      min-height: 1.2em;
      color: var(--vscode-descriptionForeground);
    }
    #status.error { color: var(--vscode-errorForeground); }
    #result-section { display: none; flex-direction: column; gap: 8px; flex: 1; }
    #result-section.visible { display: flex; }
    .section { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  </style>
</head>
<body>
  <h2>CorpusWire Context Engine</h2>

  <div class="section">
    <label for="prompt">Base prompt</label>
    <textarea id="prompt" rows="8" placeholder="Enter or paste a prompt, or select text in an editor first…">${escapedSeed}</textarea>
  </div>

  <div class="row">
    <button id="enhance-btn">Enhance</button>
    <span id="status"></span>
  </div>

  <div id="result-section">
    <div class="section">
      <label for="result">Enhanced prompt</label>
      <textarea id="result" rows="8" readonly></textarea>
    </div>
    <div class="row">
      <button id="insert-btn">Insert into editor</button>
      <button id="copy-btn" class="secondary">Copy</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const promptEl      = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'));
    const enhanceBtn    = /** @type {HTMLButtonElement}  */ (document.getElementById('enhance-btn'));
    const statusEl      = document.getElementById('status');
    const resultSection = document.getElementById('result-section');
    const resultEl      = /** @type {HTMLTextAreaElement} */ (document.getElementById('result'));
    const insertBtn     = /** @type {HTMLButtonElement}  */ (document.getElementById('insert-btn'));
    const copyBtn       = /** @type {HTMLButtonElement}  */ (document.getElementById('copy-btn'));

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.className = isError ? 'error' : '';
    }

    function setLoading(value) {
      enhanceBtn.disabled = value;
      enhanceBtn.textContent = value ? 'Enhancing…' : 'Enhance';
      if (value) setStatus('Sending to CorpusWire…', false);
    }

    enhanceBtn.addEventListener('click', () => {
      const prompt = promptEl.value.trim();
      if (!prompt) { setStatus('Enter a prompt first.', true); return; }
      setStatus('', false);
      resultSection.classList.remove('visible');
      vscode.postMessage({ type: 'enhance', prompt });
    });

    insertBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'insert', text: resultEl.value });
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(resultEl.value);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch {
        copyBtn.textContent = 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'loading') { setLoading(msg.value); return; }
      if (msg.type === 'result') {
        resultEl.value = msg.text;
        resultSection.classList.add('visible');
        setStatus('Enhanced successfully.', false);
        return;
      }
      if (msg.type === 'error') { setStatus(msg.message, true); return; }
      if (msg.type === 'seed' && msg.prompt.trim()) { promptEl.value = msg.prompt; }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "corpuswireContextEngine.openPanel",
      () => ContextEnginePanel.createOrShow(context),
    ),
    vscode.commands.registerCommand(
      "corpuswireContextEngine.enhancePrompt",
      enhanceSelectedPrompt,
    ),
  );
}

export function deactivate(): void {
  // VS Code does not require explicit cleanup for this extension.
}

async function enhanceSelectedPrompt(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage(
      "Open a file and select a base prompt before running CorpusWire Context Engine: Enhance Prompt.",
    );
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (selection.isEmpty || selectedText.trim().length === 0) {
    void vscode.window.showWarningMessage(
      "Select prompt text before running CorpusWire Context Engine: Enhance Prompt.",
    );
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, editor.document.uri);
  const baseUrl = resolveBaseUrl(config.get<string>("baseUrl", ""));
  const workspaceId = config.get<string>("workspaceId", "").trim();
  const outputMode = resolveOutputMode(config.get<string>("outputMode", "generic"));

  const client = new CorpusWireClient({ baseUrl, endpointMode: "v1-only" });

  const request: EnhancePromptRequest = {
    prompt: selectedText,
    outputMode,
    ...(workspaceId ? { workspaceId } : {}),
  };

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CorpusWire Context Engine: enhancing prompt…",
        cancellable: false,
      },
      async () => {
        const result = await client.enhance(request);
        const replacement = resolveReplacement(result);

        if (!replacement) {
          throw new Error(
            result.generation_error ??
              "The CorpusWire service returned no enhanced prompt.",
          );
        }

        const replaced = await editor.edit((builder) => {
          builder.replace(selection, replacement);
        });

        if (!replaced) {
          throw new Error("VS Code could not apply the text replacement.");
        }
      },
    );

    void vscode.window.showInformationMessage(
      "Prompt enhanced with CorpusWire Context Engine.",
    );
  } catch (error) {
    void vscode.window.showErrorMessage(formatError(error, baseUrl));
  }
}

/**
 * Return the best available replacement text from the enhancement result.
 *
 * Priority:
 * 1. `enhanced_prompt`  – fully context-grounded LLM rewrite (preferred)
 * 2. `rewritten_prompt` / `augmented_prompt` – legacy field aliases
 * 3. `enhancement_prompt` – locally assembled retrieval prompt (deterministic fallback)
 */
function resolveReplacement(result: PromptRewriteResult): string | null {
  const compat = result as PromptRewriteResultCompat;
  return (
    firstNonEmpty(compat.enhanced_prompt, compat.rewritten_prompt, compat.augmented_prompt) ??
    firstNonEmpty(compat.enhancement_prompt) ??
    null
  );
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) {
      return v;
    }
  }
  return null;
}

/**
 * Resolve the effective base URL:
 * 1. VS Code setting  `corpuswireContextEngine.baseUrl` (if non-empty)
 * 2. Environment variable `CORPUSWIRE_BASE_URL`
 * 3. Hard-coded localhost default
 */
function resolveBaseUrl(configured: string): string {
  const trimmed = configured.trim();
  if (trimmed) {
    return trimmed;
  }
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  return env?.CORPUSWIRE_BASE_URL?.trim() || FALLBACK_BASE_URL;
}

function resolveOutputMode(raw: string): PromptOutputMode {
  return VALID_OUTPUT_MODES.has(raw) ? (raw as PromptOutputMode) : "generic";
}

function formatError(error: unknown, baseUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ENOTFOUND")
  ) {
    return (
      `Cannot reach the CorpusWire service at ${baseUrl}. ` +
      `Verify corpuswireContextEngine.baseUrl or the CORPUSWIRE_BASE_URL environment variable.`
    );
  }
  if (error instanceof CorpusWireHttpError) {
    return `CorpusWire rejected the enhancement request: ${error.message}`;
  }
  return `Prompt enhancement failed: ${message}`;
}
