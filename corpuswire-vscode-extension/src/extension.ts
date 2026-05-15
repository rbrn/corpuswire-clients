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

export function activate(context: vscode.ExtensionContext): void {
  const enhanceDisposable = vscode.commands.registerCommand(
    "corpuswire.enhancePrompt",
    enhanceSelectedPrompt,
  );
  const indexDisposable = vscode.commands.registerCommand(
    "corpuswire.indexWorkspace",
    indexCurrentWorkspace,
  );

  context.subscriptions.push(enhanceDisposable, indexDisposable);
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

  const request: EnhancePromptRequest = {
    prompt: selectedText,
    outputMode: settings.outputMode,
    topK: settings.topK,
    localOnly: settings.localOnly,
  };

  if (settings.remoteIndexing.enabled && settings.remoteIndexing.workspaceId) {
    request.workspaceId = settings.remoteIndexing.workspaceId;
  } else if (settings.repoPath) {
    request.repoPath = settings.repoPath;
  }

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

async function enhancePromptWithFallback(
  client: CorpusWireClient,
  request: EnhancePromptRequest,
): Promise<PromptEnhancementOutcome> {
  const result = await client.enhance(request);
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
