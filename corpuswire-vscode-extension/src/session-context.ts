import type { EnhanceSessionContext } from "@corpuswire/sdk";

/** Mirrors the server caps for `EnhanceRequest.session`. */
export const MAX_RECENT_EDITS = 50;
export const MAX_SESSION_TEXT_CHARS = 8_000;

/**
 * In-memory, most-recent-first list of saved files per workspace folder.
 * Nothing is persisted; the list is lost when the extension host restarts.
 */
export class RecentEditsTracker {
  private readonly byFolder = new Map<string, string[]>();

  constructor(private readonly limit = MAX_RECENT_EDITS) {}

  record(folderKey: string, relativePath: string): void {
    if (!folderKey || !relativePath) {
      return;
    }
    const current = this.byFolder.get(folderKey) ?? [];
    const next = [relativePath, ...current.filter((entry) => entry !== relativePath)].slice(0, this.limit);
    this.byFolder.set(folderKey, next);
  }

  forget(folderKey: string, relativePath: string): void {
    const current = this.byFolder.get(folderKey);
    if (!current) {
      return;
    }
    this.byFolder.set(folderKey, current.filter((entry) => entry !== relativePath));
  }

  list(folderKey: string): string[] {
    return [...(this.byFolder.get(folderKey) ?? [])];
  }
}

/**
 * Returns `filePath` relative to `folderPath` as a POSIX path, or undefined
 * when the file is not strictly inside the folder. Both inputs are URI paths
 * (forward slashes, as in `vscode.Uri.path`).
 */
export function workspaceRelativePath(folderPath: string, filePath: string): string | undefined {
  const root = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  if (!filePath.startsWith(root)) {
    return undefined;
  }
  const relative = filePath.slice(root.length);
  if (!relative || relative.split("/").some((segment) => segment === "..")) {
    return undefined;
  }
  return relative;
}

export function capSessionText(text: string, limit = MAX_SESSION_TEXT_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

export interface EditorSessionInput {
  /** Workspace-relative path of the active editor's file, if any. */
  activeFile?: string;
  /** Zero-based VS Code selection lines, if a non-empty selection should be sent. */
  selection?: { startLine: number; endLine: number; endCharacter: number; text: string };
  recentEdits?: string[];
}

/**
 * Builds the SDK session from editor state. Converts VS Code's zero-based
 * lines to 1-based inclusive lines (a selection ending at column 0 of a line
 * does not include that line). Returns undefined when there is nothing to
 * send, so the request never carries an empty `session`.
 */
export function buildEditorSession(input: EditorSessionInput): EnhanceSessionContext | undefined {
  const session: EnhanceSessionContext = {};
  if (input.activeFile) {
    session.activeFile = input.activeFile;
  }
  if (input.activeFile && input.selection) {
    const startLine = input.selection.startLine + 1;
    const lastLine = input.selection.endCharacter === 0 && input.selection.endLine > input.selection.startLine
      ? input.selection.endLine - 1
      : input.selection.endLine;
    const endLine = Math.max(startLine, lastLine + 1);
    session.selection = {
      path: input.activeFile,
      startLine,
      endLine,
      ...(input.selection.text.trim() ? { text: capSessionText(input.selection.text) } : {}),
    };
  }
  const recentEdits = (input.recentEdits ?? []).slice(0, MAX_RECENT_EDITS);
  if (recentEdits.length > 0) {
    session.recentEdits = recentEdits;
  }
  return Object.keys(session).length > 0 ? session : undefined;
}

/**
 * True when a server that predates `session` rejected the key itself
 * (FastAPI/pydantic `extra_forbidden` at `body.session`). Validation errors
 * inside a supported `session` are not matched, so they still surface.
 */
export function isLegacySessionRejection(status: number, responseBody: string): boolean {
  if (status !== 422 || !responseBody) {
    return false;
  }
  try {
    const parsed = JSON.parse(responseBody) as { detail?: unknown };
    const details = Array.isArray(parsed.detail) ? parsed.detail : [];
    return details.some((entry) => {
      const item = entry as { type?: unknown; loc?: unknown };
      return item.type === "extra_forbidden"
        && Array.isArray(item.loc)
        && item.loc.length === 2
        && item.loc[0] === "body"
        && item.loc[1] === "session";
    });
  } catch {
    return false;
  }
}
