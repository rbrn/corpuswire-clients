// Pure helpers for the one-keystroke enhancement and the @corpuswire chat
// participant (CRP-001 L2.1). Nothing here imports `vscode`, so the node test
// runner can load it directly.

export const ENHANCE_PREVIEW_COMMAND = "corpuswire.enhancePromptWithPreview";
export const CHAT_PARTICIPANT_ID = "corpuswire.enhancer";
export const CHAT_PARTICIPANT_SETTING = "chatParticipant.enabled";
export const CHAT_USE_PROMPT_COMMAND = "corpuswire.chat.useEnhancedPrompt";
export const CHAT_COPY_PROMPT_COMMAND = "corpuswire.chat.copyEnhancedPrompt";
export const PREVIEW_SCHEME = "corpuswire-preview";

export type EnhanceSource = "selection" | "input";

export interface EnhancePreviewArgs {
  source?: unknown;
}

/**
 * Chooses where the prompt comes from. The keybinding passes an explicit
 * source from its `when` clause, because VS Code keeps the last editor as
 * `activeTextEditor` while focus is in a terminal or the chat input. From the
 * command palette (no argument), a non-empty selection wins.
 */
export function resolveEnhanceSource(args: unknown, selectedText: string | undefined): EnhanceSource {
  const requested = typeof args === "object" && args !== null ? (args as EnhancePreviewArgs).source : undefined;
  const hasSelection = typeof selectedText === "string" && selectedText.trim().length > 0;
  return requested !== "input" && hasSelection ? "selection" : "input";
}

/** A Markdown code fence that cannot be closed early by backticks in the text. */
export function fenceText(text: string, language = "text"): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${fence}${language}\n${body}${fence}`;
}

export interface ChatEnhanceSummary {
  usedLocalFallback: boolean;
  qualityStatus: string;
  qualityMessage: string;
}

/** The participant's reply: one status line, then the rewrite in a fence. */
export function formatChatEnhanceResponse(rewrite: string, summary: ChatEnhanceSummary): string {
  const source = summary.usedLocalFallback ? "CorpusWire (local fallback)" : "CorpusWire";
  const marker = summary.qualityStatus === "grounded" ? "" : " ⚠";
  return `**Enhanced by ${source}.**${marker} ${summary.qualityMessage}\n\n${fenceText(rewrite)}\n`;
}

export const CHAT_EMPTY_PROMPT_REPLY =
  "Type the prompt to enhance after `@corpuswire`, for example `@corpuswire add tests for the sync queue`.";

export interface Disposable {
  dispose(): unknown;
}

/**
 * Keeps one registration alive while a setting is on: `sync(true)` creates it
 * once, `sync(false)` disposes it. Used for the chat participant so that
 * turning `corpuswire.chatParticipant.enabled` off removes it without a reload.
 */
export class ToggleRegistration implements Disposable {
  private current: Disposable | undefined;

  constructor(private readonly create: () => Disposable | undefined) {}

  get active(): boolean {
    return this.current !== undefined;
  }

  sync(enabled: boolean): void {
    if (enabled && !this.current) {
      this.current = this.create();
    } else if (!enabled && this.current) {
      const previous = this.current;
      this.current = undefined;
      previous.dispose();
    }
  }

  dispose(): void {
    this.sync(false);
  }
}
