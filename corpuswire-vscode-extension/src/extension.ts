import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  CorpusWireClient,
  CorpusWireHttpError,
} from "@corpuswire/sdk";
import type {
  EnhancePromptRequest,
  IndexWorkspaceRequest,
  PromptRewriteResult,
  RemoteWorkspaceFile,
} from "@corpuswire/sdk";
import {
  buildRemoteServiceHeaders,
  readSettings,
} from "./configuration.js";
import type { ExtensionSettings } from "./configuration.js";

type PromptRewriteResultWithCompatibilityFields = PromptRewriteResult & {
  augmented_prompt?: unknown;
  rewritten_prompt?: unknown;
};

const INDEX_INCLUDE_GLOB = "**/*.{md,txt,csv,pdf,java,py,sh,cjs,js,jsx,mjs,ts,tsx,json,toml,yaml,yml}";
const INDEX_EXCLUDE_GLOB = "{**/.git/**,**/.vscode/**,**/node_modules/**,**/dist/**,**/build/**,**/target/**,**/__pycache__/**}";

interface PromptEnhancementOutcome {
  replacement: string;
  usedLocalFallback: boolean;
}

interface PanelEnhanceMessage {
  type: "enhance";
  prompt: string;
}

interface PanelInsertMessage {
  type: "insert";
  text: string;
}

type PanelInboundMessage = PanelEnhanceMessage | PanelInsertMessage;

interface PanelResultMessage {
  type: "result";
  text: string;
  usedLocalFallback: boolean;
}

interface PanelErrorMessage {
  type: "error";
  message: string;
}

interface PanelLoadingMessage {
  type: "loading";
  value: boolean;
}

interface PanelSeedMessage {
  type: "seed";
  prompt: string;
}

type PanelOutboundMessage =
  | PanelResultMessage
  | PanelErrorMessage
  | PanelLoadingMessage
  | PanelSeedMessage;

class PromptEnhancerPanel {
  static readonly viewType = "corpuswire.promptPanel";
  private static current: PromptEnhancerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static createOrShow(): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const seed = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection)
      : "";

    if (PromptEnhancerPanel.current) {
      PromptEnhancerPanel.current.panel.reveal(column);
      if (seed.trim()) {
        PromptEnhancerPanel.current.post({ type: "seed", prompt: seed });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PromptEnhancerPanel.viewType,
      "CorpusWire Prompt Enhancer",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    PromptEnhancerPanel.current = new PromptEnhancerPanel(panel, seed);
  }

  private constructor(panel: vscode.WebviewPanel, initialSeed: string) {
    this.panel = panel;
    this.panel.webview.html = buildPromptPanelHtml(initialSeed);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.handleMessage(message as PanelInboundMessage),
      null,
      this.disposables,
    );
  }

  private post(message: PanelOutboundMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: PanelInboundMessage): Promise<void> {
    if (message.type === "insert") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("No active editor to insert into.");
        return;
      }

      await editor.edit((builder) => builder.replace(editor.selection, message.text));
      return;
    }

    if (message.type !== "enhance") {
      return;
    }

    await runPromptEnhancement(message.prompt, (msg) => this.post(msg));
  }

  private dispose(): void {
    PromptEnhancerPanel.current = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}

class PromptEnhancerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "corpuswire.promptView";
  private view: vscode.WebviewView | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    const seed = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection)
      : "";
    webviewView.webview.html = buildPromptPanelHtml(seed);

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message as PanelInboundMessage);
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  seedFromActiveEditor(): void {
    if (!this.view) {
      return;
    }
    const seed = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection)
      : "";
    if (seed.trim()) {
      void this.view.webview.postMessage({ type: "seed", prompt: seed } satisfies PanelSeedMessage);
    }
  }

  private post(message: PanelOutboundMessage): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  private async handleMessage(message: PanelInboundMessage): Promise<void> {
    if (message.type === "insert") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("No active editor to insert into.");
        return;
      }

      await editor.edit((builder) => builder.replace(editor.selection, message.text));
      return;
    }

    if (message.type !== "enhance") {
      return;
    }

    await runPromptEnhancement(message.prompt, (msg) => this.post(msg));
  }
}

async function runPromptEnhancement(
  prompt: string,
  post: (message: PanelOutboundMessage) => void,
): Promise<void> {
  const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const settings = readSettings(resource);
  for (const warning of settings.configurationWarnings) {
    void vscode.window.showWarningMessage(warning);
  }

  const enhancerService = settings.services.enhancer;
  const client = new CorpusWireClient({
    baseUrl: enhancerService.url,
    endpointMode: "v1-only",
    defaultHeaders: buildRemoteServiceHeaders(enhancerService),
  });
  const request = buildEnhancementRequest(prompt, settings);

  post({ type: "loading", value: true });
  try {
    const outcome = await enhancePromptWithFallback(client, request);
    post({
      type: "result",
      text: outcome.replacement,
      usedLocalFallback: outcome.usedLocalFallback,
    });
  } catch (error) {
    post({ type: "error", message: formatEnhancementError(error, enhancerService.url) });
  } finally {
    post({ type: "loading", value: false });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const enhanceDisposable = vscode.commands.registerCommand(
    "corpuswire.enhancePrompt",
    enhanceSelectedPrompt,
  );
  const indexDisposable = vscode.commands.registerCommand(
    "corpuswire.indexWorkspace",
    indexCurrentWorkspace,
  );
  const panelDisposable = vscode.commands.registerCommand(
    "corpuswire.openPanel",
    () => PromptEnhancerPanel.createOrShow(),
  );
  const legacyEnhanceDisposable = vscode.commands.registerCommand(
    "corpuswireContextEngine.enhancePrompt",
    enhanceSelectedPrompt,
  );
  const legacyPanelDisposable = vscode.commands.registerCommand(
    "corpuswireContextEngine.openPanel",
    () => PromptEnhancerPanel.createOrShow(),
  );

  const viewProvider = new PromptEnhancerViewProvider();
  const viewDisposable = vscode.window.registerWebviewViewProvider(
    PromptEnhancerViewProvider.viewType,
    viewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const focusPanelDisposable = vscode.commands.registerCommand(
    "corpuswire.focusPanel",
    async () => {
      await vscode.commands.executeCommand("corpuswire.promptView.focus");
      viewProvider.seedFromActiveEditor();
    },
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(sparkle) Enhance Prompt";
  statusBar.tooltip = "Open the CorpusWire Prompt Enhancer widget";
  statusBar.command = "corpuswire.focusPanel";
  statusBar.show();

  context.subscriptions.push(
    enhanceDisposable,
    indexDisposable,
    panelDisposable,
    legacyEnhanceDisposable,
    legacyPanelDisposable,
    viewDisposable,
    focusPanelDisposable,
    statusBar,
  );
  registerRemoteIndexWatchers(context);
}

export function deactivate(): void {
  // VS Code does not require cleanup for this extension.
}

async function indexCurrentWorkspace(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage("Open a workspace before running CorpusWire: Index Workspace.");
    return;
  }

  const settings = readSettings(workspaceFolder.uri);
  const workspaceId = settings.remoteIndexing.workspaceId;
  if (!workspaceId) {
    void vscode.window.showWarningMessage("Configure a stable remote indexing workspace ID before indexing.");
    return;
  }

  const indexerService = settings.services.indexer;
  const client = new CorpusWireClient({
    baseUrl: indexerService.url,
    endpointMode: "v1-only",
    defaultHeaders: buildRemoteServiceHeaders(indexerService),
  });

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Indexing workspace with CorpusWire",
        cancellable: false,
      },
      async () => {
        const files = await collectWorkspaceFiles(workspaceFolder);
        await client.indexWorkspace({
          workspace: {
            workspaceId,
            displayRoot: workspaceFolder.uri.toString(),
            name: workspaceFolder.name,
          },
          mode: "full",
          client: {
            name: "corpuswire-vscode-extension",
            transport: "vscode.workspace.fs",
            maxConcurrentUploads: settings.remoteIndexing.maxConcurrentUploads,
            batchBytes: settings.remoteIndexing.batchBytes,
          },
          maxConcurrentUploads: settings.remoteIndexing.maxConcurrentUploads,
          batchBytes: settings.remoteIndexing.batchBytes,
          files,
        } satisfies IndexWorkspaceRequest);
      },
    );
    void vscode.window.showInformationMessage("Workspace indexed with CorpusWire.");
  } catch (error) {
    void vscode.window.showWarningMessage(formatIndexingError(error, indexerService.url));
  }
}

function registerRemoteIndexWatchers(context: vscode.ExtensionContext): void {
  const settings = readSettings(vscode.workspace.workspaceFolders?.[0]?.uri);
  if (!settings.remoteIndexing.enabled || !settings.remoteIndexing.autoWatch) {
    return;
  }

  const pendingChangedUris = new Map<string, vscode.Uri>();
  const pendingDeletedPaths = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    const changedUris = [...pendingChangedUris.values()];
    const deletedPaths = [...pendingDeletedPaths.values()];
    pendingChangedUris.clear();
    pendingDeletedPaths.clear();
    timer = undefined;
    void sendIncrementalIndexUpdate(changedUris, deletedPaths);
  };
  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, 1000);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(INDEX_INCLUDE_GLOB);
  watcher.onDidCreate((uri) => {
    pendingChangedUris.set(uri.toString(), uri);
    schedule();
  });
  watcher.onDidChange((uri) => {
    pendingChangedUris.set(uri.toString(), uri);
    schedule();
  });
  watcher.onDidDelete((uri) => {
    const relativePath = relativePathForUri(uri);
    if (relativePath) {
      pendingDeletedPaths.add(relativePath);
    }
    pendingChangedUris.delete(uri.toString());
    schedule();
  });

  context.subscriptions.push(watcher);
}

async function sendIncrementalIndexUpdate(changedUris: vscode.Uri[], deletedPaths: string[]): Promise<void> {
  const resource = changedUris[0] ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const settings = readSettings(resource);
  if (!settings.remoteIndexing.enabled || !settings.remoteIndexing.workspaceId) {
    return;
  }

  const indexerService = settings.services.indexer;
  const client = new CorpusWireClient({
    baseUrl: indexerService.url,
    endpointMode: "v1-only",
    defaultHeaders: buildRemoteServiceHeaders(indexerService),
  });
  const files = await collectUriFiles(changedUris);
  await client.indexWorkspace({
    workspace: {
      workspaceId: settings.remoteIndexing.workspaceId,
      displayRoot: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
      name: vscode.workspace.workspaceFolders?.[0]?.name,
    },
    mode: "incremental",
    client: {
      name: "corpuswire-vscode-extension",
      transport: "vscode.workspace.fs",
    },
    maxConcurrentUploads: settings.remoteIndexing.maxConcurrentUploads,
    batchBytes: settings.remoteIndexing.batchBytes,
    files,
    deletedPaths,
  });
}

async function collectWorkspaceFiles(workspaceFolder: vscode.WorkspaceFolder): Promise<RemoteWorkspaceFile[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, INDEX_INCLUDE_GLOB),
    new vscode.RelativePattern(workspaceFolder, INDEX_EXCLUDE_GLOB),
  );
  return collectUriFiles(uris);
}

async function collectUriFiles(uris: vscode.Uri[]): Promise<RemoteWorkspaceFile[]> {
  const files: RemoteWorkspaceFile[] = [];
  for (const uri of uris) {
    const relativePath = relativePathForUri(uri);
    if (!relativePath) {
      continue;
    }
    try {
      const [stat, content] = await Promise.all([
        vscode.workspace.fs.stat(uri),
        vscode.workspace.fs.readFile(uri),
      ]);
      files.push({
        relativePath,
        content,
        mtimeNs: Math.trunc(stat.mtime * 1_000_000),
      });
    } catch {
      // Files can disappear between watcher events and upload; the next event heals state.
    }
  }
  return files;
}

function relativePathForUri(uri: vscode.Uri): string | null {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return null;
  }
  return vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
}

async function enhanceSelectedPrompt(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open an editor and select a prompt to enhance.");
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  if (selection.isEmpty || selectedText.trim().length === 0) {
    void vscode.window.showWarningMessage("Select prompt text before running CorpusWire: Enhance Prompt.");
    return;
  }

  const settings = readSettings(editor.document.uri);
  for (const warning of settings.configurationWarnings) {
    void vscode.window.showWarningMessage(warning);
  }

  const enhancerService = settings.services.enhancer;
  const client = new CorpusWireClient({
    baseUrl: enhancerService.url,
    endpointMode: "v1-only",
    defaultHeaders: buildRemoteServiceHeaders(enhancerService),
  });
  const request = buildEnhancementRequest(selectedText, settings);

  let usedLocalFallback = false;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Enhancing prompt with CorpusWire",
        cancellable: false,
      },
      async () => {
        const outcome = await enhancePromptWithFallback(client, request);
        usedLocalFallback = outcome.usedLocalFallback;

        const replaced = await editor.edit((editBuilder) => {
          editBuilder.replace(selection, outcome.replacement);
        });

        if (!replaced) {
          throw new Error("VS Code could not replace the selected text.");
        }
      },
    );

    void vscode.window.showInformationMessage(
      usedLocalFallback
        ? "Prompt enhanced with CorpusWire local fallback because generation was unavailable."
        : "Prompt enhanced with CorpusWire.",
    );
  } catch (error) {
    void vscode.window.showWarningMessage(formatEnhancementError(error, enhancerService.url));
  }
}

function buildEnhancementRequest(prompt: string, settings: ExtensionSettings): EnhancePromptRequest {
  const request: EnhancePromptRequest = {
    prompt,
    outputMode: settings.outputMode,
    topK: settings.topK,
    localOnly: settings.localOnly,
  };

  if (settings.remoteIndexing.enabled && settings.remoteIndexing.workspaceId) {
    request.workspaceId = settings.remoteIndexing.workspaceId;
  } else if (settings.repoPath) {
    request.repoPath = settings.repoPath;
  }

  return request;
}

async function enhancePromptWithFallback(
  client: CorpusWireClient,
  request: EnhancePromptRequest,
): Promise<PromptEnhancementOutcome> {
  let result: PromptRewriteResult;
  try {
    result = await client.enhance(request);
  } catch (error) {
    if (request.localOnly || !isGenerationSetupRejection(error)) {
      throw error;
    }

    const localResult = await client.enhance({ ...request, localOnly: true });
    const localReplacement = resolveReplacementPrompt(localResult);
    if (localReplacement) {
      return { replacement: localReplacement, usedLocalFallback: true };
    }

    throw error;
  }

  const replacement = resolveFinalReplacementPrompt(result);
  if (replacement) {
    return { replacement, usedLocalFallback: false };
  }

  if (!request.localOnly && result.generation_error) {
    const localResult = await client.enhance({ ...request, localOnly: true });
    const localReplacement = resolveReplacementPrompt(localResult);
    if (localReplacement) {
      return { replacement: localReplacement, usedLocalFallback: true };
    }
  }

  const fallbackPrompt = resolveFallbackPrompt(result);
  if (fallbackPrompt) {
    return { replacement: fallbackPrompt, usedLocalFallback: false };
  }

  throw new Error(result.generation_error ?? "corpuswire returned no enhanced prompt.");
}

function isGenerationSetupRejection(error: unknown): boolean {
  if (!(error instanceof CorpusWireHttpError)) {
    return false;
  }

  const message = [
    error.errorMessage,
    error.message,
    error.responseBody,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  return message.includes("OPENCLAW_MODEL or LLM_MODEL is required")
    || message.includes("Prompt rewriting requires a configured generation backend")
    || message.includes("Unsupported GENERATION_PROVIDER")
    || message.includes("Unsupported OPENCLAW_EXECUTION_MODE");
}

function resolveFinalReplacementPrompt(result: PromptRewriteResult): string | null {
  const compatibilityResult = result as PromptRewriteResultWithCompatibilityFields;

  return firstNonEmptyString(
    compatibilityResult.enhanced_prompt,
    compatibilityResult.rewritten_prompt,
    compatibilityResult.augmented_prompt,
  );
}

function resolveFallbackPrompt(result: PromptRewriteResult): string | null {
  return firstNonEmptyString(result.enhancement_prompt);
}

function resolveReplacementPrompt(result: PromptRewriteResult): string | null {
  return firstNonEmptyString(
    resolveFinalReplacementPrompt(result),
    resolveFallbackPrompt(result),
  );
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function formatEnhancementError(error: unknown, baseUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);

  if (isConnectionErrorMessage(message)) {
    return `Could not connect to the configured corpuswire enhancer service at ${baseUrl}. Check the remote service URL and credentials. ${message}`;
  }

  if (error instanceof CorpusWireHttpError) {
    return `corpuswire rejected the enhancement request: ${error.errorMessage ?? message}`;
  }

  return `Prompt enhancement failed: ${message}`;
}

function formatIndexingError(error: unknown, baseUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isConnectionErrorMessage(message)) {
    return `Could not connect to the configured corpuswire indexer service at ${baseUrl}. Check the remote service URL and credentials. ${message}`;
  }
  if (error instanceof CorpusWireHttpError) {
    return `corpuswire rejected the indexing request: ${error.errorMessage ?? message}`;
  }
  return `Workspace indexing failed: ${message}`;
}

function isConnectionErrorMessage(message: string): boolean {
  return message.includes("fetch failed")
    || message.includes("ECONNREFUSED")
    || message.includes("ECONNRESET")
    || message.includes("ENOTFOUND");
}

function buildPromptPanelHtml(initialSeed: string): string {
  const nonce = randomUUID().replace(/-/g, "");
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const escapedSeed = escapeHtml(initialSeed);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CorpusWire Prompt Enhancer</title>
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
    h2 {
      margin: 0;
      font-size: 1.1em;
      font-weight: 600;
    }
    label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      display: block;
    }
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
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    textarea[readonly] {
      background: var(--vscode-textBlockQuote-background, var(--vscode-input-background));
      opacity: 0.9;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
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
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #status {
      font-size: 0.85em;
      min-height: 1.2em;
      color: var(--vscode-descriptionForeground);
    }
    #status.error {
      color: var(--vscode-errorForeground);
    }
    #result-section {
      display: none;
      flex-direction: column;
      gap: 8px;
      flex: 1;
    }
    #result-section.visible {
      display: flex;
    }
    .section {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }
  </style>
</head>
<body>
  <h2>CorpusWire Prompt Enhancer</h2>

  <div class="section">
    <label for="prompt">Base prompt</label>
    <textarea id="prompt" rows="8" placeholder="Enter or paste a prompt, or select text in an editor first">${escapedSeed}</textarea>
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

    const promptEl = document.getElementById('prompt');
    const enhanceBtn = document.getElementById('enhance-btn');
    const statusEl = document.getElementById('status');
    const resultSection = document.getElementById('result-section');
    const resultEl = document.getElementById('result');
    const insertBtn = document.getElementById('insert-btn');
    const copyBtn = document.getElementById('copy-btn');

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.className = isError ? 'error' : '';
    }

    function setLoading(value) {
      enhanceBtn.disabled = value;
      enhanceBtn.textContent = value ? 'Enhancing...' : 'Enhance';
      if (value) {
        setStatus('Sending to CorpusWire...', false);
      }
    }

    enhanceBtn.addEventListener('click', () => {
      const prompt = promptEl.value.trim();
      if (!prompt) {
        setStatus('Enter a prompt first.', true);
        return;
      }
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
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch {
        copyBtn.textContent = 'Copy failed';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'loading') {
        setLoading(message.value);
        return;
      }
      if (message.type === 'result') {
        resultEl.value = message.text;
        resultSection.classList.add('visible');
        setStatus(
          message.usedLocalFallback
            ? 'Enhanced with local fallback.'
            : 'Enhanced successfully.',
          false
        );
        return;
      }
      if (message.type === 'error') {
        setStatus(message.message, true);
        return;
      }
      if (message.type === 'seed' && message.prompt.trim()) {
        promptEl.value = message.prompt;
      }
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
