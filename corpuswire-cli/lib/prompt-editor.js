import { createInterface as createReadlineInterface } from "node:readline/promises";
import { appendPromptClarification, isUsefulClarification } from "./prompt-clarification.js";

/**
 * Edit a terminal draft and optionally replace it with contextual enhancement.
 * Enter returns the draft; this function never executes it. The supplied
 * enhance(prompt) callback must resolve to a nonempty rewritten string.
 * Cancellation rejects with code PROMPT_CANCELLED.
 *
 * createInterface is injectable and otherwise uses node:readline/promises.
 * Rewritten and initial drafts may contain newlines; ordinary terminal input
 * follows readline's Enter-to-submit behavior. Use file/stdin CLI input for
 * reliably importing a multiline task.
 */
export async function editPrompt({
  enhance,
  input = process.stdin,
  output = process.stderr,
  createInterface = createReadlineInterface,
  initialPrompt = "",
  prompt = "› ",
  assessPrompt = () => null,
  clarifyOnStart = false,
} = {}) {
  if (typeof enhance !== "function") throw new TypeError("Prompt editor requires an enhance callback.");
  const originalRawMode = input.isRaw;
  const originallyFlowing = input.readableFlowing === true;
  const readline = createInterface({
    input, output, terminal: true, historySize: 0, prompt,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = false;
    let revision = 0;
    let lastDraft = String(initialPrompt);
    let acceptAfterRewrite = false;
    let clarification = null;

    const replaceDraft = (draft) => {
      // These public properties avoid rl.write interpreting embedded newlines
      // as Enter and submitting a rewritten prompt before it can be reviewed.
      readline.line = draft;
      readline.cursor = draft.length;
      lastDraft = draft;
      readline.prompt(true);
    };
    const status = (message) => {
      output.write(`\n${message}\n`);
      readline.prompt(true);
    };
    const rememberEdits = () => {
      if (readline.line !== lastDraft) {
        revision += 1;
        lastDraft = readline.line;
        acceptAfterRewrite = false;
      }
    };
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      readline.removeListener("line", onLine);
      readline.removeListener("SIGINT", onCancel);
      readline.removeListener("close", onCancel);
      readline.removeListener("error", onError);
      readline.close();
      if (typeof originalRawMode === "boolean" && typeof input.setRawMode === "function"
          && input.isRaw !== originalRawMode) input.setRawMode(originalRawMode);
      if (originallyFlowing) input.resume();
    };
    const finish = (draft, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(draft);
    };
    const onCancel = () => {
      output.write("\n");
      const error = new Error("Prompt entry cancelled.");
      error.code = "PROMPT_CANCELLED";
      finish(undefined, error);
    };
    const onError = (error) => finish(undefined, error);
    const rewrite = async () => {
      if (pending) return;
      if (clarification) {
        status("Answer the scope question and press Enter before rewriting.");
        return;
      }
      rememberEdits();
      const draft = readline.line;
      if (!draft.trim()) {
        status("Type a prompt before pressing Ctrl+P.");
        return;
      }
      const assessment = assessPrompt(draft);
      if (assessment?.status === "needs_clarification") {
        clarification = assessment;
        acceptAfterRewrite = false;
        status(`More detail needed before rewriting:\n${assessment.questions[0].question}`);
        replaceDraft("");
        return;
      }
      const startedAtRevision = revision;
      pending = true;
      status("Rewriting with workspace context… You can keep editing.");
      try {
        const rewritten = await enhance(draft);
        if (settled) return;
        pending = false;
        rememberEdits();
        if (revision !== startedAtRevision || readline.line !== draft) {
          acceptAfterRewrite = false;
          status("Your draft changed while rewriting; it was preserved. Press Ctrl+P to rewrite it.");
          return;
        }
        if (typeof rewritten !== "string" || !rewritten.trim()) {
          throw new Error("Empty rewritten prompt.");
        }
        replaceDraft(rewritten);
        if (acceptAfterRewrite) finish(rewritten);
        else status("Rewritten. Review or edit the draft, then press Enter to accept.");
      } catch {
        if (settled) return;
        pending = false;
        acceptAfterRewrite = false;
        status("Rewriting failed. Your draft is preserved; press Ctrl+P to retry.");
      }
    };
    const onKeypress = (_text, key = {}) => {
      if (settled) return;
      if (key.ctrl && key.name === "p") {
        void rewrite();
        return;
      }
      rememberEdits();
    };
    const onLine = (line) => {
      if (settled) return;
      if (clarification) {
        if (!isUsefulClarification(line, clarification.original_prompt)) {
          status(`Describe the intended scope, or request an overview.\n${clarification.questions[0].question}`);
          return;
        }
        const clarifiedPrompt = appendPromptClarification(clarification.original_prompt, line);
        clarification = null;
        replaceDraft(clarifiedPrompt);
        void rewrite();
        return;
      }
      if (pending) {
        // readline clears its buffer before emitting line. Restore that exact
        // draft and wait for the pending replacement before accepting.
        if (line !== lastDraft) {
          revision += 1;
          lastDraft = line;
        }
        replaceDraft(line);
        acceptAfterRewrite = true;
        status("Waiting for the rewrite before accepting. Ctrl+C cancels.");
        return;
      }
      if (!line.trim()) {
        status("Type a prompt, or press Ctrl+C to cancel.");
        return;
      }
      finish(line);
    };

    readline.on("line", onLine);
    readline.on("SIGINT", onCancel);
    readline.on("close", onCancel);
    readline.on("error", onError);
    input.on("keypress", onKeypress);
    output.write("Enter a prompt. Ctrl+P rewrites with workspace context; Enter accepts; Ctrl+C cancels.\n");
    output.write("For multiline task input, use --prompt-file or --stdin.\n");
    replaceDraft(lastDraft);
    if (clarifyOnStart && lastDraft) void rewrite();
  });
}
