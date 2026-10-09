import { randomUUID, createHash } from "node:crypto";
import * as vscode from "vscode";
import {
  CorpusWireClient,
  isRetrievalExcludedPath,
  CorpusWireHttpError,
} from "@corpuswire/sdk";
import type {
  EnhancePromptRequest,
  IndexWorkspaceRequest,
  PromptRewriteResult,
  RemoteWorkspaceFile,
  InventoryScan,
  RemoteIndexCommitResponse,
  RemoteIndexStatus,
  WorkspaceDiagnosis,
} from "@corpuswire/sdk";
import {
  buildRemoteServiceHeaders,
  readSettings,
} from "./configuration.js";
import type { ExtensionSettings, RemoteServiceSettings } from "./configuration.js";
import {
  assessEnhancementQuality,
} from "./enhancement-quality.js";
import { hasAuthorizationHeader, resolveCliBearerToken } from "./service-auth.js";
import { INDEX_INCLUDE_GLOB } from "./index-discovery.js";
import type {
  EnhancementQuality,
  EnhancementQualityStatus,
} from "./enhancement-quality.js";

type PromptRewriteResultWithCompatibilityFields = PromptRewriteResult & {
  augmented_prompt?: unknown;
  rewritten_prompt?: unknown;
};

const INDEX_EXCLUDE_GLOB = "{**/.git/**,**/.vscode/**,**/node_modules/**,**/dist/**,**/build/**,**/target/**,**/__pycache__/**}";

async function buildAuthenticatedServiceHeaders(
  settings: ExtensionSettings,
  service: RemoteServiceSettings,
): Promise<Record<string, string>> {
  const headers = buildRemoteServiceHeaders(service);
  if (hasAuthorizationHeader(headers)) {
    return headers;
  }
  if (vscode.workspace.isTrusted !== true) {
    return headers;
  }
  const token = await resolveCliBearerToken(service.url, settings.auth.cliPath);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

interface PromptEnhancementOutcome {
  replacement: string;
  usedLocalFallback: boolean;
  quality: EnhancementQuality;
}

interface PanelEnhanceMessage {
  type: "enhance";
  prompt: string;
}

interface PanelInsertMessage {
  type: "insert";
  text: string;
}

interface PanelCheckStatusMessage {
  type: "check-status";
}

interface PanelIndexMessage {
  type: "index-workspace";
}

interface PanelGetModelMessage {
  type: "get-model";
}

interface PanelSetModelMessage {
  type: "set-model";
  model: string;
}

type PanelInboundMessage =
  | PanelEnhanceMessage
  | PanelInsertMessage
  | PanelCheckStatusMessage
  | PanelIndexMessage
  | PanelGetModelMessage
  | PanelSetModelMessage;

interface PanelResultMessage {
  type: "result";
  text: string;
  usedLocalFallback: boolean;
  qualityStatus: EnhancementQualityStatus;
  qualityMessage: string;
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

type IndexStatusState = "unknown" | "checking" | "not-indexed" | "indexed" | "stale" | "indexing" | "error";

interface PanelIndexStatusMessage {
  type: "index-status";
  state: IndexStatusState;
  message: string;
  workspaceId?: string;
  lastIndexedAt?: string | null;
  ageSeconds?: number | null;
  code_ready?: boolean;
  documentation_pending?: boolean;
  other_pending?: boolean;
  roots?: PanelIndexRootStatus[];
}

interface PanelIndexRootStatus {
  name: string;
  workspaceId: string;
  state: IndexStatusState;
  message: string;
  code_ready: boolean;
  documentation_pending: boolean;
  other_pending: boolean;
}

interface PanelModelMessage {
  type: "model";
  ok: boolean;
  model?: string;
  configuredModel?: string;
  overridden?: boolean;
  error?: string;
}

type PanelOutboundMessage =
  | PanelResultMessage
  | PanelErrorMessage
  | PanelLoadingMessage
  | PanelSeedMessage
  | PanelIndexStatusMessage
  | PanelModelMessage;

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

    if (message.type === "check-status") {
      await runIndexStatusCheck((msg) => this.post(msg));
      return;
    }

    if (message.type === "index-workspace") {
      await runIndexWorkspaceFromPanel((msg) => this.post(msg));
      return;
    }

    if (message.type === "get-model") {
      await runFetchModel((msg) => this.post(msg));
      return;
    }

    if (message.type === "set-model") {
      await runSetModel((msg) => this.post(msg), message.model);
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

    if (message.type === "check-status") {
      await runIndexStatusCheck((msg) => this.post(msg));
      return;
    }

    if (message.type === "index-workspace") {
      await runIndexWorkspaceFromPanel((msg) => this.post(msg));
      return;
    }

    if (message.type === "get-model") {
      await runFetchModel((msg) => this.post(msg));
      return;
    }

    if (message.type === "set-model") {
      await runSetModel((msg) => this.post(msg), message.model);
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
    defaultHeaders: await buildAuthenticatedServiceHeaders(settings, enhancerService),
  });
  const request = buildEnhancementRequest(prompt, settings);

  post({ type: "loading", value: true });
  try {
    const outcome = await enhancePromptWithFallback(client, request);
    post({
      type: "result",
      text: outcome.replacement,
      usedLocalFallback: outcome.usedLocalFallback,
      qualityStatus: outcome.quality.status,
      qualityMessage: outcome.quality.message,
    });
  } catch (error) {
    post({ type: "error", message: formatEnhancementError(error, enhancerService.url) });
  } finally {
    post({ type: "loading", value: false });
  }
}

interface CollectedWorkspaceFiles {
  files: RemoteWorkspaceFile[];
  skippedLargeFiles: number;
  skippedPolicyFiles: number;
  inventoryScan?: InventoryScan;
}

async function runIndexStatusCheck(post: (message: PanelOutboundMessage) => void): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    post({ type: "index-status", state: "unknown", message: "No workspace folder is open." });
    return;
  }
  try {
    const roots = folders.map((folder) => ({ folder, settings: readSettings(folder.uri) }))
      .filter(({ settings }) => folders.length === 1 || settings.remoteIndexing.enabled);
    if (roots.length === 0) {
      post({ type: "index-status", state: "unknown", message: "No workspace folders have remote indexing enabled." });
      return;
    }
    assertDistinctIndexRoots(roots);
    post({ type: "index-status", state: "checking", message: `Checking ${roots.length} workspace folder(s)…` });
    const rootStatuses: PanelIndexRootStatus[] = new Array(roots.length);
    let nextRoot = 0;
    const checkRoot = async (): Promise<void> => {
      while (nextRoot < roots.length) {
        const index = nextRoot++;
        const { folder, settings } = roots[index];
        const workspaceId = settings.remoteIndexing.workspaceId!;
        try {
          const client = new CorpusWireClient({
            baseUrl: settings.services.indexer.url,
            endpointMode: "v1-only",
            defaultHeaders: await buildAuthenticatedServiceHeaders(settings, settings.services.indexer),
          });
          const diagnosis = await client.diagnoseWorkspace({ workspaceId });
          rootStatuses[index] = indexRootStatus(folder.name, workspaceId, diagnosis);
        } catch (error) {
          rootStatuses[index] = {
            name: folder.name, workspaceId, state: "error",
            message: `Could not diagnose index: ${error instanceof Error ? error.message : String(error)}`,
            code_ready: false, documentation_pending: false, other_pending: false,
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_INDEX_ROOTS, roots.length) }, checkRoot));
    const ready = rootStatuses.filter((root) => root.state === "indexed");
    const documentationPending = rootStatuses.some((root) => root.documentation_pending);
    const otherPending = rootStatuses.some((root) => root.other_pending);
    const allReady = ready.length === rootStatuses.length;
    const state = allReady ? "indexed" : rootStatuses.some((root) => root.state === "error")
      ? "error" : rootStatuses.some((root) => root.state === "stale") ? "stale" : "not-indexed";
    const pendingMessage = [documentationPending ? "Documentation pending" : "", otherPending ? "Other files pending" : ""]
      .filter(Boolean).join("; ");
    const details = rootStatuses.map((root) => `${root.name}: ${root.message}`).join("; ");
    post({
      type: "index-status", state,
      message: `${ready.length}/${rootStatuses.length} workspace folder(s) ${allReady && (documentationPending || otherPending) ? "code ready to serve" : "ready"}.${pendingMessage ? ` ${pendingMessage}.` : ""} ${details}`,
      workspaceId: roots.length === 1 ? roots[0].settings.remoteIndexing.workspaceId : undefined,
      code_ready: allReady,
      documentation_pending: documentationPending,
      other_pending: otherPending,
      roots: rootStatuses,
    });
  } catch (error) {
    post({ type: "index-status", state: "error", message: error instanceof Error ? error.message : String(error), code_ready: false });
  }
}

function indexRootStatus(name: string, workspaceId: string, diagnosis: WorkspaceDiagnosis): PanelIndexRootStatus {
  const coverage = diagnosis.index.coverage;
  const index = diagnosis.index as WorkspaceDiagnosis["index"] & { readiness?: string };
  const errors = diagnosis.checks.filter((check) => check.status === "error");
  const healthWarnings = index.health_warnings ?? [];
  const healthClear = healthWarnings.length === 0;
  const blocked = diagnosis.status === "blocked" || !diagnosis.can_retrieve || Boolean(diagnosis.qdrant_error)
    || errors.length > 0 || index.health_status === "error";
  const codeReady = index.health_status === "ok" && healthClear && coverage?.code_ready === true && diagnosis.index.indexed
    && (coverage.state === "verified" || (coverage.state === "pending" && index.readiness === "code_ready"
      && coverage.reason_codes.length === 1 && coverage.reason_codes[0] === "background_ingestion_pending"));
  // Legacy servers may omit health fields; explicit degraded health must still block full readiness.
  const fullReady = (index.health_status == null || index.health_status === "ok") && healthClear && diagnosis.index.indexed && (coverage
    ? coverage.state === "verified" || coverage.state === "not_applicable"
    : index.readiness === "ready" || diagnosis.status === "ready");
  const warnings = diagnosis.checks.filter((check) => check.status === "warning");
  const ready = diagnosis.status === "ready" && !blocked && (codeReady || fullReady) && warnings.length === 0;
  const state = ready ? "indexed" : blocked ? "error" : diagnosis.index.indexed ? "stale" : "not-indexed";
  return {
    name, workspaceId, state,
    message: ready ? codeReady && coverage?.state !== "verified" ? formatCodeReadyMessage({ coverage }) : "Fully indexed"
      : errors[0]?.message ?? diagnosis.qdrant_error ?? warnings[0]?.message ?? healthWarnings[0] ?? "Index readiness is not verified.",
    code_ready: ready && codeReady,
    documentation_pending: coverage?.documentation_pending === true,
    other_pending: coverage?.other_pending === true,
  };
}

async function runFetchModel(post: (message: PanelOutboundMessage) => void): Promise<void> {
  const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const settings = readSettings(resource);
  const enhancerService = settings.services.enhancer;
  const client = new CorpusWireClient({
    baseUrl: enhancerService.url,
    endpointMode: "v1-only",
    defaultHeaders: await buildAuthenticatedServiceHeaders(settings, enhancerService),
  });
  try {
    const state = await client.getLlmModel();
    post({
      type: "model",
      ok: true,
      model: state.model,
      configuredModel: state.configured_model,
      overridden: state.overridden,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    post({
      type: "model",
      ok: false,
      error: `GET ${enhancerService.url}/llm/model failed: ${detail}`,
    });
  }
}

async function runSetModel(
  post: (message: PanelOutboundMessage) => void,
  model: string,
): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) {
    post({ type: "model", ok: false, error: "Model name must not be empty." });
    return;
  }
  const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const settings = readSettings(resource);
  const enhancerService = settings.services.enhancer;
  const client = new CorpusWireClient({
    baseUrl: enhancerService.url,
    endpointMode: "v1-only",
    defaultHeaders: await buildAuthenticatedServiceHeaders(settings, enhancerService),
  });
  try {
    const state = await client.setLlmModel(trimmed);
    post({
      type: "model",
      ok: true,
      model: state.model,
      configuredModel: state.configured_model,
      overridden: state.overridden,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    post({
      type: "model",
      ok: false,
      error: `POST ${enhancerService.url}/llm/model failed: ${detail}`,
    });
  }
}

async function runIndexWorkspaceFromPanel(post: (message: PanelOutboundMessage) => void): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    post({ type: "index-status", state: "error", message: "Open a workspace folder before indexing." });
    return;
  }

  const settings = readSettings(workspaceFolder.uri);
  const workspaceId = settings.remoteIndexing.workspaceId || workspaceFolder.uri.toString();

  post({ type: "index-status", state: "indexing", message: "Indexing workspace…", workspaceId });

  try {
    await indexCurrentWorkspace();
  } catch (error) {
    post({
      type: "index-status",
      state: "error",
      message: `Indexing failed: ${error instanceof Error ? error.message : String(error)}`,
      workspaceId,
    });
    return;
  }

  await runIndexStatusCheck(post);
}

export function activate(context: vscode.ExtensionContext): void {
  const enhanceDisposable = vscode.commands.registerCommand(
    "corpuswire.enhancePrompt",
    enhanceSelectedPrompt,
  );
  const indexDisposable = vscode.commands.registerCommand(
    "corpuswire.indexWorkspace",
    () => indexCurrentWorkspace(),
  );
  const rebuildDisposable = vscode.commands.registerCommand(
    "corpuswire.rebuildWorkspaceIndex",
    rebuildCurrentWorkspaceIndex,
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
    rebuildDisposable,
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

interface IndexWorkspaceOptions {
  recreateCollection?: boolean;
}

interface IndexWorkspaceRoot {
  folder: vscode.WorkspaceFolder;
  settings: ExtensionSettings;
}

const MAX_CONCURRENT_INDEX_ROOTS = 2;

function indexRootKey(folder: vscode.WorkspaceFolder): string {
  return folder.uri.toString();
}

function indexServiceIdentity(baseUrl: string): string {
  return new URL(baseUrl).href.replace(/\/+$/, "");
}

function assertDistinctIndexRoots(roots: IndexWorkspaceRoot[]): void {
  const identities = new Map<string, string>();
  for (const { folder, settings } of roots) {
    const workspaceId = settings.remoteIndexing.workspaceId;
    if (!workspaceId) {
      throw new Error(`Configure a stable remote indexing workspace ID for ${folder.name} before indexing.`);
    }
    const identity = JSON.stringify([indexServiceIdentity(settings.services.indexer.url), workspaceId]);
    const previousRoot = identities.get(identity);
    if (previousRoot && previousRoot !== indexRootKey(folder)) {
      throw new Error(`Multiple workspace folders use CorpusWire workspace ID ${workspaceId}. Configure a distinct remoteIndexing.workspaceId for each folder before indexing.`);
    }
    identities.set(identity, indexRootKey(folder));
  }
}

function formatCodeReadyMessage(status: Pick<RemoteIndexStatus, "coverage">): string {
  const pending = [];
  if (status.coverage?.documentation_pending) pending.push("documentation pending");
  if (status.coverage?.other_pending) pending.push("other files pending");
  return `Code ready to serve${pending.length > 0 ? ` · ${pending.join(" · ")}` : ""}`;
}

async function rebuildCurrentWorkspaceIndex(): Promise<void> {
  try {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder) => ({ folder, settings: readSettings(folder.uri) }))
      .filter(({ settings }) => folders.length === 1 || settings.remoteIndexing.enabled);
    if (roots.length === 0) {
      void vscode.window.showWarningMessage("Open a workspace with remote indexing enabled before rebuilding its index.");
      return;
    }
    assertDistinctIndexRoots(roots);
    const targets = roots.map(({ folder, settings }) => `${folder.name}: ${settings.remoteIndexing.workspaceId}`).join("\n");
    const selection = await vscode.window.showWarningMessage(
      `Rebuild ${roots.length} CorpusWire workspace index(es) by recreating these target collections:\n${targets}\nUse this only after an embedding-model or vector-dimension change.`,
      { modal: true },
      "Rebuild Index",
    );
    if (selection !== "Rebuild Index") return;
    await indexCurrentWorkspace({ recreateCollection: true }, roots);
  } catch (error) {
    void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
  }
}

async function indexCurrentWorkspace(options: IndexWorkspaceOptions = {}, confirmedRoots?: IndexWorkspaceRoot[]): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Open a workspace before running CorpusWire: Index Workspace.");
    return;
  }

  try {
    // An explicit command historically works in a single folder even when automatic indexing is disabled.
    const roots = confirmedRoots ?? folders.map((folder) => ({ folder, settings: readSettings(folder.uri) }))
      .filter(({ settings }) => folders.length === 1 || settings.remoteIndexing.enabled);
    if (roots.length === 0) {
      void vscode.window.showWarningMessage("Enable remote indexing for at least one workspace folder before indexing this multi-folder workspace.");
      return;
    }
    // Validate every participating identity before capabilities, scans, or uploads begin.
    assertDistinctIndexRoots(roots);
    const outcomes: { root: IndexWorkspaceRoot; committed?: RemoteIndexCommitResponse; skippedLargeFiles?: number; error?: unknown }[] = [];
    let cancelled = false;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.recreateCollection
          ? "Rebuilding workspace index with CorpusWire"
          : "Indexing workspace with CorpusWire",
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        const rootPercent = new Map<string, number>();
        let reportedPercent = 0;
        let nextRoot = 0;
        try {
          const work = async (): Promise<void> => {
            while (!controller.signal.aborted && nextRoot < roots.length) {
              const root = roots[nextRoot++];
              const { folder, settings } = root;
              const indexerService = settings.services.indexer;
              try {
                const client = new CorpusWireClient({
                  baseUrl: indexerService.url,
                  endpointMode: "v1-only",
                  defaultHeaders: await buildAuthenticatedServiceHeaders(settings, indexerService),
                });
                const capabilities = await client.getIndexCapabilities();
                if (controller.signal.aborted) throw new Error("Indexing cancelled before scan started.");
                const maxFileSizeBytes = Math.min(settings.remoteIndexing.maxFileSizeBytes, capabilities.max_file_size_bytes);
                progress.report({ message: `${folder.name} · scanning workspace` });
                const collected = await collectWorkspaceFiles(folder, maxFileSizeBytes, controller.signal);
                if (controller.signal.aborted) throw new Error("Indexing cancelled before upload started.");
                let codeReadyMessage = "";
                const committed = await client.indexWorkspace({
                  workspace: {
                    workspaceId: settings.remoteIndexing.workspaceId!,
                    displayRoot: folder.uri.toString(),
                    name: folder.name,
                  },
                  mode: "full",
                  client: {
                    name: "corpuswire-vscode-extension",
                    transport: "vscode.workspace.fs",
                    maxConcurrentUploads: settings.remoteIndexing.maxConcurrentUploads,
                    batchBytes: settings.remoteIndexing.batchBytes,
                    maxFileSizeBytes,
                  },
                  maxConcurrentUploads: settings.remoteIndexing.maxConcurrentUploads,
                  batchBytes: settings.remoteIndexing.batchBytes,
                  maxFileSizeBytes,
                  recreateCollection: options.recreateCollection === true,
                  files: collected.files,
                  inventoryScan: collected.inventoryScan,
                  signal: controller.signal,
                  onCodeReady: (status) => {
                    codeReadyMessage = formatCodeReadyMessage(status);
                    progress.report({ message: `${folder.name} · ${codeReadyMessage}` });
                  },
                  onProgress: (event) => {
                    if (event.phase === "completed") codeReadyMessage = "";
                    if (event.overall_percent !== null) {
                      const key = indexRootKey(folder);
                      rootPercent.set(key, Math.max(rootPercent.get(key) ?? 0, event.overall_percent));
                    }
                    const percent = [...rootPercent.values()].reduce((sum, value) => sum + value, 0) / roots.length;
                    const increment = Math.max(0, percent - reportedPercent);
                    reportedPercent = Math.max(reportedPercent, percent);
                    progress.report({ increment, message: `${folder.name} · ${formatIndexProgressMessage(event)}${codeReadyMessage ? ` · ${codeReadyMessage}` : ""}` });
                  },
                } satisfies IndexWorkspaceRequest);
                outcomes.push({ root, committed, skippedLargeFiles: collected.skippedLargeFiles });
              } catch (error) {
                outcomes.push({ root, error });
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_INDEX_ROOTS, roots.length) }, work));
          cancelled = controller.signal.aborted;
        } finally {
          cancellation.dispose();
        }
      },
    );
    for (const outcome of outcomes) {
      const { folder, settings } = outcome.root;
      if (outcome.error) {
        void vscode.window.showWarningMessage(`${folder.name}: ${formatIndexingError(outcome.error, settings.services.indexer.url)}`);
        continue;
      }
      const skippedSuffix = outcome.skippedLargeFiles
        ? ` Skipped ${outcome.skippedLargeFiles} file(s) above the configured size limit.` : "";
      const evidenceSuffix = ` Inventory coverage: ${outcome.committed?.status.coverage?.state ?? "unknown"}; transferred files: ${outcome.committed?.transfer?.files_transferred ?? "unknown"}.`;
      void vscode.window.showInformationMessage(`${folder.name}: Workspace ${options.recreateCollection ? "index rebuilt" : "indexed"} with CorpusWire.${skippedSuffix}${evidenceSuffix}`);
    }
    if (cancelled) void vscode.window.showWarningMessage(`CorpusWire indexing cancelled. Completed ${outcomes.filter((outcome) => outcome.committed).length}/${roots.length} workspace folders.`);
  } catch (error) {
    void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
  }
}

function formatIndexProgressMessage(event: {
  phase: string;
  elapsed_ms: number;
  phase_completed: number;
  phase_total: number | null;
  unit: string;
  active_heartbeat: boolean;
}): string {
  const elapsedSeconds = (event.elapsed_ms / 1_000).toFixed(1);
  const work = event.phase_total === null
    ? `${event.phase_completed} ${event.unit}`
    : `${event.phase_completed}/${event.phase_total} ${event.unit}`;
  const heartbeat = event.active_heartbeat ? " · active" : "";
  return `${event.phase} · ${work} · ${elapsedSeconds}s${heartbeat}`;
}

function registerRemoteIndexWatchers(context: vscode.ExtensionContext): void {
  interface PendingRoot {
    folder: vscode.WorkspaceFolder;
    changed: Map<string, vscode.Uri>;
    deleted: Set<string>;
    timer?: ReturnType<typeof setTimeout>;
    due: boolean;
    running: boolean;
    controller?: AbortController;
  }
  const pendingRoots = new Map<string, PendingRoot>();
  let activeRoots = 0;
  let disposed = false;

  const schedule = (pending: PendingRoot): void => {
    if (disposed) return;
    if (pending.timer) clearTimeout(pending.timer);
    const settings = readSettings(pending.folder.uri);
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      pending.due = true;
      pump();
    }, settings.remoteIndexing.autoWatchDebounceMs);
  };

  const pump = (): void => {
    if (disposed) return;
    for (const pending of pendingRoots.values()) {
      if (activeRoots >= MAX_CONCURRENT_INDEX_ROOTS) return;
      if (!pending.due || pending.running) continue;
      pending.due = false;
      const settings = readSettings(pending.folder.uri);
      const changedUris = [...pending.changed.values()];
      const deletedPaths = [...pending.deleted];
      pending.changed.clear();
      pending.deleted.clear();
      if (!settings.remoteIndexing.enabled || !settings.remoteIndexing.autoWatch) continue;
      const eventCount = changedUris.length + deletedPaths.length;
      if (eventCount === 0) continue;
      if (eventCount > settings.remoteIndexing.maxAutoWatchFiles) {
        void vscode.window.showWarningMessage(
          `${pending.folder.name}: CorpusWire skipped an auto-index batch with ${eventCount} file events. Run CorpusWire: Index Workspace for bounded full reconciliation.`,
        );
        continue;
      }
      pending.running = true;
      activeRoots += 1;
      pending.controller = new AbortController();
      void sendIncrementalIndexUpdate(pending.folder, changedUris, deletedPaths, pending.controller.signal)
        .catch((error) => {
          if (!disposed) void vscode.window.showWarningMessage(
            `${pending.folder.name}: CorpusWire auto-index update failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          activeRoots -= 1;
          pending.running = false;
          pending.controller = undefined;
          if (pending.changed.size > 0 || pending.deleted.size > 0) schedule(pending);
          pump();
        });
    }
  };

  const enqueue = (uri: vscode.Uri, deleted: boolean): void => {
    if (disposed) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const settings = readSettings(folder.uri);
    if (!settings.remoteIndexing.enabled || !settings.remoteIndexing.autoWatch) return;
    const relativePath = relativePathForUri(uri);
    if (!relativePath || isIndexExcludedPath(relativePath)) return;
    const key = indexRootKey(folder);
    let pending = pendingRoots.get(key);
    if (!pending) {
      pending = { folder, changed: new Map(), deleted: new Set(), due: false, running: false };
      pendingRoots.set(key, pending);
    }
    if (deleted) {
      pending.deleted.add(relativePath);
      pending.changed.delete(uri.toString());
    } else {
      pending.changed.set(uri.toString(), uri);
      pending.deleted.delete(relativePath);
    }
    schedule(pending);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(INDEX_INCLUDE_GLOB);
  watcher.onDidCreate((uri) => enqueue(uri, false));
  watcher.onDidChange((uri) => enqueue(uri, false));
  watcher.onDidDelete((uri) => enqueue(uri, true));

  context.subscriptions.push(watcher, {
    dispose: () => {
      disposed = true;
      for (const pending of pendingRoots.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.controller?.abort();
      }
      pendingRoots.clear();
    },
  });
}

async function sendIncrementalIndexUpdate(
  folder: vscode.WorkspaceFolder,
  changedUris: vscode.Uri[],
  deletedPaths: string[],
  signal?: AbortSignal,
): Promise<void> {
  const settings = readSettings(folder.uri);
  if (!settings.remoteIndexing.enabled || !settings.remoteIndexing.autoWatch || !settings.remoteIndexing.workspaceId) {
    return;
  }
  const roots = (vscode.workspace.workspaceFolders ?? []).map((root) => ({ folder: root, settings: readSettings(root.uri) }))
    .filter(({ settings: rootSettings }) => rootSettings.remoteIndexing.enabled);
  if (!roots.some((root) => indexRootKey(root.folder) === indexRootKey(folder))) return;
  assertDistinctIndexRoots(roots);
  if (changedUris.some((uri) => {
    const actualRoot = vscode.workspace.getWorkspaceFolder(uri);
    return !actualRoot || indexRootKey(actualRoot) !== indexRootKey(folder);
  })) {
    throw new Error("Incremental indexing cannot mix workspace folders.");
  }

  const indexerService = settings.services.indexer;
  const client = new CorpusWireClient({
    baseUrl: indexerService.url,
    endpointMode: "v1-only",
    defaultHeaders: await buildAuthenticatedServiceHeaders(settings, indexerService),
  });
  const collected = await collectUriFiles(changedUris, settings.remoteIndexing.maxFileSizeBytes, false, signal);
  if (signal?.aborted) throw new Error("Indexing cancelled before upload started.");
  if (collected.files.length === 0 && deletedPaths.length === 0) {
    return;
  }
  await client.indexWorkspace({
    workspace: {
      workspaceId: settings.remoteIndexing.workspaceId,
      displayRoot: folder.uri.toString(),
      name: folder.name,
    },
    mode: "incremental",
    client: {
      name: "corpuswire-vscode-extension",
      transport: "vscode.workspace.fs",
    },
    maxConcurrentUploads: settings.remoteIndexing.maxConcurrentUploads,
    batchBytes: settings.remoteIndexing.batchBytes,
    maxFileSizeBytes: settings.remoteIndexing.maxFileSizeBytes,
    files: collected.files,
    deletedPaths,
    signal,
  });
}

async function collectWorkspaceFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  maxFileSizeBytes: number,
  signal?: AbortSignal,
): Promise<CollectedWorkspaceFiles> {
  const startedAt = new Date().toISOString();
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, INDEX_INCLUDE_GLOB),
    new vscode.RelativePattern(workspaceFolder, INDEX_EXCLUDE_GLOB),
  );
  // Nested workspace folders have independent identities and must never appear in this root's inventory.
  const rootUris = uris.filter((uri) => {
    const actualRoot = vscode.workspace.getWorkspaceFolder(uri);
    if (!actualRoot) throw Object.assign(new Error("Workspace scan incomplete"), { code: "scan_incomplete" });
    return indexRootKey(actualRoot) === indexRootKey(workspaceFolder);
  });
  const collected = await collectUriFiles(rootUris, maxFileSizeBytes, true, signal);
  return { ...collected, inventoryScan: {
    complete: true, startedAt, completedAt: new Date().toISOString(),
    excludedFileCount: collected.skippedLargeFiles + collected.skippedPolicyFiles + uris.length - rootUris.length, producer: "corpuswire-vscode-scan/v1",
    ignoreDigest: createHash("sha256").update(JSON.stringify({ include: INDEX_INCLUDE_GLOB, exclude: INDEX_EXCLUDE_GLOB, hiddenPaths: "exclude", retrievalExclusions: "discovery-and-terraform/v1", workspaceRootIsolation: "v1" })).digest("hex"),
  } };
}

async function collectUriFiles(uris: vscode.Uri[], maxFileSizeBytes: number, strict = false, signal?: AbortSignal): Promise<CollectedWorkspaceFiles> {
  const files: RemoteWorkspaceFile[] = [];
  let skippedLargeFiles = 0;
  let skippedPolicyFiles = 0;
  for (const uri of uris) {
    if (signal?.aborted) throw new Error("Indexing cancelled during scan.");
    const relativePath = relativePathForUri(uri);
    if (!relativePath) {
      if (strict) throw Object.assign(new Error("Workspace scan incomplete"), { code: "scan_incomplete" });
      continue;
    }
    if (isIndexExcludedPath(relativePath)) {
      skippedPolicyFiles += 1;
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & (vscode.FileType.Directory | vscode.FileType.SymbolicLink)) !== 0) {
        continue;
      }
      if (stat.size > maxFileSizeBytes) {
        skippedLargeFiles += 1;
        continue;
      }
      const content = await vscode.workspace.fs.readFile(uri);
      const after = await vscode.workspace.fs.stat(uri);
      if (after.size !== stat.size || after.mtime !== stat.mtime || content.length !== stat.size
        || (after.type & vscode.FileType.SymbolicLink) !== 0) throw new Error("File changed during scan");
      files.push({
        relativePath,
        content,
        mtimeNs: Math.trunc(stat.mtime * 1_000_000),
      });
    } catch (cause) {
      if (strict) throw Object.assign(new Error("Workspace scan incomplete", { cause }), { code: "scan_incomplete" });
      // Files can disappear between watcher events and upload; the next event heals state.
    }
  }
  return { files, skippedLargeFiles, skippedPolicyFiles };
}

function relativePathForUri(uri: vscode.Uri): string | null {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return null;
  }
  return vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
}

function isIndexExcludedPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.some((part) => part.startsWith(".") || ["node_modules", "dist", "build", "target", "__pycache__"].includes(part))
    || isRetrievalExcludedPath(relativePath);
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
    defaultHeaders: await buildAuthenticatedServiceHeaders(settings, enhancerService),
  });
  const request = buildEnhancementRequest(selectedText, settings);

  let outcome: PromptEnhancementOutcome | undefined;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Enhancing prompt with CorpusWire",
        cancellable: false,
      },
      async () => {
        const enhancementOutcome = await enhancePromptWithFallback(client, request);
        outcome = enhancementOutcome;

        const replaced = await editor.edit((editBuilder) => {
          editBuilder.replace(selection, enhancementOutcome.replacement);
        });

        if (!replaced) {
          throw new Error("VS Code could not replace the selected text.");
        }
      },
    );

    if (!outcome) {
      throw new Error("CorpusWire returned no prompt enhancement outcome.");
    }
    const resultMessage = outcome.usedLocalFallback
      ? `Prompt enhanced with CorpusWire local fallback. ${outcome.quality.message}`
      : `Prompt enhanced with CorpusWire. ${outcome.quality.message}`;
    if (outcome.quality.status === "grounded") {
      void vscode.window.showInformationMessage(resultMessage);
    } else {
      void vscode.window.showWarningMessage(resultMessage);
    }
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
      return {
        replacement: localReplacement,
        usedLocalFallback: true,
        quality: assessEnhancementQuality(localResult),
      };
    }

    throw error;
  }

  const replacement = resolveFinalReplacementPrompt(result);
  if (replacement) {
    return {
      replacement,
      usedLocalFallback: false,
      quality: assessEnhancementQuality(result),
    };
  }

  if (!request.localOnly && result.generation_error) {
    const localResult = await client.enhance({ ...request, localOnly: true });
    const localReplacement = resolveReplacementPrompt(localResult);
    if (localReplacement) {
      return {
        replacement: localReplacement,
        usedLocalFallback: true,
        quality: assessEnhancementQuality(localResult),
      };
    }
  }

  const fallbackPrompt = resolveFallbackPrompt(result);
  if (fallbackPrompt) {
    return {
      replacement: fallbackPrompt,
      usedLocalFallback: false,
      quality: assessEnhancementQuality(result),
    };
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

  return message.includes("Prompt rewriting requires a configured generation backend")
    || message.includes("Unsupported GENERATION_PROVIDER");
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
    #index-banner {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 10px;
      border-radius: 3px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background));
      font-size: 0.85em;
    }
    #index-banner.hidden { display: none; }
    #index-banner.state-not-indexed,
    #index-banner.state-stale,
    #index-banner.state-error {
      border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground));
    }
    #index-banner.state-indexed {
      border-color: var(--vscode-charts-green, var(--vscode-input-border, transparent));
    }
    #index-banner .row {
      gap: 6px;
    }
    #index-banner .label {
      font-weight: 600;
    }
    #index-banner .label.indexed { color: var(--vscode-charts-green, var(--vscode-foreground)); }
    #index-banner .label.stale,
    #index-banner .label.not-indexed,
    #index-banner .label.error { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
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

  <div id="index-banner" class="hidden">
    <div class="row"><span class="label" id="index-label">Checking index status…</span></div>
    <div id="index-message"></div>
    <div class="row">
      <button id="index-btn" class="secondary">Index Workspace</button>
      <button id="refresh-status-btn" class="secondary">Refresh</button>
    </div>
  </div>

  <div id="model-row" class="row">
    <span class="label">Model:</span>
    <span id="model-current">…</span>
    <input id="model-input" type="text" placeholder="override model id (e.g. gpt-4o-mini)" style="flex:1;min-width:160px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border, transparent);border-radius:2px;padding:4px 6px;" />
    <button id="model-apply" class="secondary">Apply</button>
    <span id="model-status" style="font-size:0.85em;color:var(--vscode-descriptionForeground);"></span>
  </div>
  <div id="model-error" style="display:none;font-size:0.85em;color:var(--vscode-errorForeground);word-break:break-all;"></div>

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
    const indexBanner = document.getElementById('index-banner');
    const indexLabel = document.getElementById('index-label');
    const indexMessage = document.getElementById('index-message');
    const indexBtn = document.getElementById('index-btn');
    const refreshStatusBtn = document.getElementById('refresh-status-btn');
    const modelCurrent = document.getElementById('model-current');
    const modelInput = document.getElementById('model-input');
    const modelApply = document.getElementById('model-apply');
    const modelStatus = document.getElementById('model-status');
    const modelError = document.getElementById('model-error');

    function applyIndexStatus(message) {
      indexBanner.classList.remove('hidden');
      indexBanner.className = 'state-' + message.state;
      indexLabel.className = 'label ' + message.state;
      const labels = {
        unknown: 'Unknown',
        checking: 'Checking…',
        'not-indexed': 'Not indexed',
        indexed: 'Indexed',
        stale: 'Index may be stale',
        indexing: 'Indexing…',
        error: 'Index status error'
      };
      indexLabel.textContent = message.state === 'indexed' && message.code_ready && (message.documentation_pending || message.other_pending)
        ? 'Code ready' : labels[message.state] || message.state;
      indexMessage.textContent = message.message || '';
      const showIndexBtn = ['not-indexed', 'stale', 'indexed', 'error'].includes(message.state);
      indexBtn.style.display = showIndexBtn ? '' : 'none';
      indexBtn.textContent = message.state === 'indexed' ? 'Re-index Workspace' : 'Index Workspace';
      indexBtn.disabled = message.state === 'indexing' || message.state === 'checking';
      refreshStatusBtn.disabled = message.state === 'indexing' || message.state === 'checking';
    }

    indexBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'index-workspace' });
    });
    refreshStatusBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'check-status' });
    });

    modelApply.addEventListener('click', () => {
      const value = modelInput.value.trim();
      if (!value) {
        modelStatus.textContent = 'Enter a model id.';
        return;
      }
      modelApply.disabled = true;
      modelStatus.textContent = 'Applying…';
      vscode.postMessage({ type: 'set-model', model: value });
    });
    modelInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        modelApply.click();
      }
    });

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
        const fallbackLabel = message.usedLocalFallback ? 'Local fallback. ' : '';
        setStatus(fallbackLabel + message.qualityMessage, message.qualityStatus !== 'grounded');
        return;
      }
      if (message.type === 'error') {
        setStatus(message.message, true);
        return;
      }
      if (message.type === 'seed' && message.prompt.trim()) {
        promptEl.value = message.prompt;
      }
      if (message.type === 'index-status') {
        applyIndexStatus(message);
      }
      if (message.type === 'model') {
        modelApply.disabled = false;
        if (message.ok) {
          const overrideTag = message.overridden ? ' (override)' : '';
          modelCurrent.textContent = (message.model || '(unset)') + overrideTag;
          modelInput.placeholder = message.configuredModel || 'override model id';
          if (!modelInput.value) {
            modelInput.value = message.model || '';
          }
          modelStatus.textContent = '';
          modelError.style.display = 'none';
          modelError.textContent = '';
        } else {
          modelCurrent.textContent = '(error)';
          modelStatus.textContent = 'See details below';
          modelError.style.display = '';
          modelError.textContent = message.error || 'Failed to fetch model.';
          console.error('CorpusWire model fetch failed:', message.error);
        }
      }
    });

    // Trigger initial status check on load.
    vscode.postMessage({ type: 'check-status' });
    vscode.postMessage({ type: 'get-model' });
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
