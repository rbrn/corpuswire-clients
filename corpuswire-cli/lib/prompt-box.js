import { appendPromptClarification, assessPromptSufficiency, isUsefulClarification } from "./prompt-clarification.js";

/**
 * Terminal prompt box for the `cw` start screen and interactive `cw enhance`.
 *
 * The box is a small live region drawn at the bottom of the terminal: a status
 * line, a ruled multiline input with a placeholder, and a shortcut line. Other
 * output goes through log()/raw() so it prints above the box instead of
 * through it. Keys: Ctrl+P rewrites the draft, Enter accepts it, Ctrl+J,
 * Shift+Enter or Alt+Enter adds a new line, ? on an empty draft lists the
 * shortcuts, Ctrl+C clears a draft or exits when the draft is empty.
 *
 * It never runs the prompt. enhance(draft) must resolve to the rewritten text;
 * accept(draft) decides what Enter does (print and copy, or return it).
 */

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const NEWLINE_KEYS = new Set(["\n", `${ESC}\r`, `${ESC}[13;2u`, `${ESC}[27;2;13~`, `${ESC}[13;3u`]);
const CSI = /^\u001b\[[0-9;?]*[ -/]*[@-~]/;
const SS3 = /^\u001bO./;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export const PROMPT_BOX_SHORTCUTS = [
  ["Ctrl+P", "rewrite the draft with this workspace's context"],
  ["Enter", "accept the draft"],
  ["Ctrl+J / Shift+Enter", "new line"],
  ["Ctrl+U", "clear the draft"],
  ["Ctrl+W", "delete the previous word"],
  ["Esc", "close this list or cancel a question"],
  ["Ctrl+C", "clear the draft; on an empty draft, stop"],
];

export function promptEditorEnabled(env = process.env) {
  const value = String(env.CORPUSWIRE_CLI_PROMPT_EDITOR ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(value);
}

function truncate(text, width) {
  const plain = String(text).replace(ANSI, "");
  const chars = Array.from(plain);
  return chars.length <= width ? plain : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** Split one logical line into rows of at most `width` characters. */
function wrapRow(chars, width) {
  if (chars.length === 0) return [[]];
  const rows = [];
  for (let index = 0; index < chars.length; index += width) rows.push(chars.slice(index, index + width));
  // A cursor sitting just past a full row starts a new, empty row.
  if (chars.length % width === 0) rows.push([]);
  return rows;
}

export function createPromptBox({
  input = process.stdin,
  output = process.stdout,
  enhance,
  accept,
  onExit = () => {},
  assessPrompt = assessPromptSufficiency,
  placeholder = "Describe a task, then press Ctrl+P to rewrite it",
  status = "",
  color = true,
} = {}) {
  if (typeof enhance !== "function") throw new TypeError("Prompt box requires an enhance callback.");
  if (typeof accept !== "function") throw new TypeError("Prompt box requires an accept callback.");
  const dim = (text) => (color ? `${ESC}[2m${text}${ESC}[22m` : text);
  const bold = (text) => (color ? `${ESC}[1m${text}${ESC}[22m` : text);

  let chars = [];
  let cursor = 0;
  let revision = 0;
  let workspaceStatus = status;
  let message = "";
  let activity = "";
  let pending = false;
  let rewriteToken = 0;
  let helpOpen = false;
  let clarification = null; // { draft, question }
  let pasting = false;
  let buffer = "";
  let cursorRow = 0;
  let active = false;
  let originalRaw;

  const columns = () => Math.max(20, Number(output.columns) || 80);
  const draft = () => chars.join("");
  const setDraft = (text) => {
    chars = Array.from(String(text).replace(/\r\n?/g, "\n"));
    cursor = chars.length;
  };
  const edited = () => {
    revision += 1;
    helpOpen = false;
  };

  function regionRows() {
    const width = columns();
    const rule = dim("─".repeat(width - 1));
    const rows = [];
    if (workspaceStatus) rows.push({ text: `${dim("●")} ${truncate(workspaceStatus, width - 3)}` });
    const note = activity || message;
    if (note) rows.push({ text: dim(truncate(note, width - 1)) });
    if (clarification) rows.push({ text: bold(truncate(clarification.question, width - 1)) });
    rows.push({ text: rule });
    const prefix = clarification ? "? " : "› ";
    const contentWidth = width - 1 - prefix.length;
    let cursorAt = { row: rows.length, column: prefix.length };
    if (chars.length === 0) {
      rows.push({ text: `${prefix}${dim(truncate(clarification ? "Type your answer and press Enter" : placeholder, contentWidth))}` });
    } else {
      let offset = 0;
      draft().split("\n").forEach((line, lineIndex) => {
        const lineChars = Array.from(line);
        const wrapped = wrapRow(lineChars, contentWidth);
        if (cursor >= offset && cursor <= offset + lineChars.length) {
          const column = cursor - offset;
          cursorAt = { row: rows.length + Math.floor(column / contentWidth), column: prefix.length + (column % contentWidth) };
        }
        wrapped.forEach((segment, segmentIndex) => {
          const lead = lineIndex === 0 && segmentIndex === 0 ? prefix : " ".repeat(prefix.length);
          rows.push({ text: `${lead}${segment.join("")}` });
        });
        offset += lineChars.length + 1;
      });
      // Keep the box shorter than the screen: show a window around the cursor.
      const inputStart = rows.findIndex((row) => row.text === rule) + 1;
      const inputRows = rows.length - inputStart;
      const maxRows = Math.max(3, (Number(output.rows) || 24) - inputStart - 4 - (helpOpen ? PROMPT_BOX_SHORTCUTS.length : 1));
      if (inputRows > maxRows) {
        const cursorIndex = cursorAt.row - inputStart;
        const first = Math.min(Math.max(0, cursorIndex - maxRows + 2), inputRows - maxRows + 1);
        const shown = rows.slice(inputStart + first, inputStart + first + maxRows - 1);
        const hidden = inputRows - shown.length;
        rows.splice(inputStart, inputRows, ...shown, { text: dim(`  … ${hidden} more line${hidden === 1 ? "" : "s"} (↑/↓ to scroll)`) });
        cursorAt = { row: cursorAt.row - first, column: cursorAt.column };
      }
    }
    rows.push({ text: rule });
    if (helpOpen) {
      for (const [key, description] of PROMPT_BOX_SHORTCUTS) rows.push({ text: dim(truncate(` ${key.padEnd(22)} ${description}`, width - 1)) });
    } else {
      const footer = pending ? " Rewriting… · Ctrl+C cancels" : " ? shortcuts · Ctrl+P rewrite · Enter accept · Ctrl+C stop";
      rows.push({ text: dim(truncate(footer, width - 1)) });
    }
    return { rows, cursorAt };
  }

  function erase() {
    let sequence = "";
    if (cursorRow > 0) sequence += `${ESC}[${cursorRow}A`;
    sequence += `\r${ESC}[J`;
    output.write(sequence);
    cursorRow = 0;
  }

  function render() {
    if (!active) return;
    erase();
    const { rows, cursorAt } = regionRows();
    output.write(rows.map((row) => row.text).join("\r\n"));
    const up = rows.length - 1 - cursorAt.row;
    output.write(`${up > 0 ? `${ESC}[${up}A` : ""}\r${cursorAt.column > 0 ? `${ESC}[${cursorAt.column}C` : ""}`);
    cursorRow = cursorAt.row;
  }

  /** Print text above the box. */
  function log(text = "") {
    if (!active) {
      output.write(`${text}\n`);
      return;
    }
    erase();
    output.write(`${String(text).replace(/\r?\n/g, "\r\n")}\r\n`);
    render();
  }

  /** Accept a progress renderer's raw writes: `\r\x1b[2K…` updates the activity line. */
  function raw(text) {
    const value = String(text);
    const transient = value.match(/^\r\u001b\[2K([^\n]*)$/);
    if (transient) {
      activity = transient[1];
      render();
    } else if (value === "\n") {
      if (activity) {
        const finished = activity;
        activity = "";
        log(finished);
      }
    } else if (value) {
      log(value.replace(/\n$/, ""));
    }
  }

  function setStatus(text) {
    workspaceStatus = text;
    render();
  }

  function setMessage(text) {
    message = text;
    render();
  }

  async function rewrite(text) {
    const token = ++rewriteToken;
    const startRevision = revision;
    pending = true;
    message = "Rewriting with workspace context…";
    render();
    try {
      const rewritten = await enhance(text);
      if (!active || token !== rewriteToken) return;
      if (typeof rewritten !== "string" || !rewritten.trim()) throw new Error("The service returned an empty rewrite.");
      if (revision !== startRevision) {
        message = "Kept your edits; the draft changed during the rewrite.";
      } else {
        setDraft(rewritten.replace(/\s+$/, ""));
        revision += 1;
        message = "Rewritten. Edit it, press Ctrl+P again, or Enter to accept.";
      }
    } catch (error) {
      if (!active || token !== rewriteToken) return;
      message = `Rewrite failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (token === rewriteToken) {
        pending = false;
        render();
      }
    }
  }

  function requestRewrite() {
    if (pending) return;
    const text = draft();
    if (!text.trim()) return setMessage("Type a task first.");
    const assessment = assessPrompt(text);
    if (assessment?.status === "needs_clarification") {
      clarification = { draft: text, question: assessment.questions[0].question };
      chars = [];
      cursor = 0;
      message = "";
      edited();
      return render();
    }
    rewrite(text);
  }

  async function submit() {
    if (clarification) {
      const answer = draft();
      if (!isUsefulClarification(answer, clarification.draft)) {
        return setMessage("Describe the scope you want, or ask for a workspace-wide overview.");
      }
      const combined = appendPromptClarification(clarification.draft, answer);
      clarification = null;
      setDraft(combined);
      edited();
      return rewrite(combined);
    }
    const text = draft();
    if (!text.trim() || pending) return;
    chars = [];
    cursor = 0;
    edited();
    message = "";
    render();
    try {
      const result = await accept(text);
      if (active && typeof result === "string") setMessage(result);
    } catch (error) {
      if (active) setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function insert(text) {
    const inserted = Array.from(text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ""));
    if (!inserted.length) return;
    chars.splice(cursor, 0, ...inserted);
    cursor += inserted.length;
    edited();
    render();
  }

  function moveVertical(direction) {
    const lineStart = chars.lastIndexOf("\n", cursor - 1) + 1;
    const column = cursor - lineStart;
    if (direction < 0) {
      if (lineStart === 0) return;
      const previousStart = chars.lastIndexOf("\n", lineStart - 2) + 1;
      cursor = Math.min(previousStart + column, lineStart - 1);
    } else {
      const lineEnd = chars.indexOf("\n", cursor);
      if (lineEnd === -1) return;
      const nextEnd = chars.indexOf("\n", lineEnd + 1);
      cursor = Math.min(lineEnd + 1 + column, nextEnd === -1 ? chars.length : nextEnd);
    }
    render();
  }

  function handleKey(key) {
    if (NEWLINE_KEYS.has(key)) return insert("\n");
    switch (key) {
      case "\r":
        return submit();
      case "\u0010": // Ctrl+P
        return requestRewrite();
      case "\u0003": // Ctrl+C
        if (pending) {
          rewriteToken += 1;
          pending = false;
          message = "Rewrite cancelled.";
          return render();
        }
        if (clarification) {
          setDraft(clarification.draft);
          clarification = null;
          message = "Question cancelled; your draft is back.";
          return render();
        }
        if (chars.length) {
          chars = [];
          cursor = 0;
          edited();
          message = "Draft cleared. Press Ctrl+C again to stop.";
          return render();
        }
        return exit();
      case "\u0004": // Ctrl+D
        return chars.length ? undefined : exit();
      case ESC:
        if (helpOpen) helpOpen = false;
        else if (clarification) {
          setDraft(clarification.draft);
          clarification = null;
        }
        return render();
      case "\u007f":
      case "\b":
        if (cursor === 0) return undefined;
        chars.splice(cursor - 1, 1);
        cursor -= 1;
        edited();
        return render();
      case `${ESC}[3~`:
        if (cursor >= chars.length) return undefined;
        chars.splice(cursor, 1);
        edited();
        return render();
      case `${ESC}[D`:
        cursor = Math.max(0, cursor - 1);
        return render();
      case `${ESC}[C`:
        cursor = Math.min(chars.length, cursor + 1);
        return render();
      case `${ESC}[A`:
        return moveVertical(-1);
      case `${ESC}[B`:
        return moveVertical(1);
      case "\u0001":
      case `${ESC}[H`:
      case `${ESC}OH`:
        cursor = chars.lastIndexOf("\n", cursor - 1) + 1;
        return render();
      case "\u0005":
      case `${ESC}[F`:
      case `${ESC}OF`: {
        const next = chars.indexOf("\n", cursor);
        cursor = next === -1 ? chars.length : next;
        return render();
      }
      case "\u0015": // Ctrl+U
        chars = [];
        cursor = 0;
        edited();
        return render();
      case "\u0017": { // Ctrl+W
        let start = cursor;
        while (start > 0 && /\s/.test(chars[start - 1])) start -= 1;
        while (start > 0 && !/\s/.test(chars[start - 1])) start -= 1;
        chars.splice(start, cursor - start);
        cursor = start;
        edited();
        return render();
      }
      case "?":
        if (chars.length === 0 && !clarification) {
          helpOpen = !helpOpen;
          return render();
        }
        return insert(key);
      default:
        if (key.startsWith(ESC) || /^[\u0000-\u001f]$/.test(key)) return undefined;
        return insert(key);
    }
  }

  /** Split raw input into keys, keeping bracketed pastes literal. */
  function onData(data) {
    buffer += Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    while (buffer.length) {
      if (pasting) {
        const end = buffer.indexOf(PASTE_END);
        if (end === -1) {
          insert(buffer);
          buffer = "";
          return;
        }
        insert(buffer.slice(0, end));
        buffer = buffer.slice(end + PASTE_END.length);
        pasting = false;
        continue;
      }
      if (buffer.startsWith(PASTE_START)) {
        pasting = true;
        buffer = buffer.slice(PASTE_START.length);
        continue;
      }
      let key;
      if (buffer.startsWith(ESC)) {
        const match = [...NEWLINE_KEYS].find((candidate) => candidate.startsWith(ESC) && buffer.startsWith(candidate))
          ?? buffer.match(CSI)?.[0] ?? buffer.match(SS3)?.[0];
        if (match) key = match;
        else if (buffer.length === 1) key = ESC;
        else key = buffer.startsWith(`${ESC}[`) || buffer.startsWith(`${ESC}O`) ? null : ESC;
        if (key === null) return; // incomplete sequence; wait for more input
      } else {
        // Plain text arrives in chunks; split control characters out as keys.
        key = buffer.match(/^[^\u0000-\u001f\u007f?]+/)?.[0] ?? Array.from(buffer)[0];
      }
      buffer = buffer.slice(key.length);
      handleKey(key);
    }
  }

  const onResize = () => render();

  function start() {
    if (active) return box;
    active = true;
    originalRaw = input.isRaw;
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.setEncoding?.("utf8");
    input.on("data", onData);
    input.resume?.();
    output.on?.("resize", onResize);
    output.write(`${ESC}[?2004h`);
    render();
    return box;
  }

  function stop() {
    if (!active) return;
    erase();
    active = false;
    output.write(`${ESC}[?2004l`);
    input.removeListener("data", onData);
    output.removeListener?.("resize", onResize);
    if (typeof input.setRawMode === "function") input.setRawMode(Boolean(originalRaw));
    input.pause?.();
  }

  function exit() {
    stop();
    onExit();
  }

  const box = {
    start, stop, log, raw, render, setStatus, setMessage,
    get draft() { return draft(); },
    get active() { return active; },
    // Exposed for tests and callers that want to seed the draft.
    setDraft(text) { setDraft(text); edited(); render(); },
    handleInput: onData,
  };
  return box;
}

/** Copy text to the system clipboard. Resolves to the tool used, or null. */
export async function copyToClipboard(text, { platform = process.platform, spawnFn } = {}) {
  const spawn = spawnFn ?? (await import("node:child_process")).spawn;
  const candidates = platform === "darwin" ? [["pbcopy", []]]
    : platform === "win32" ? [["clip", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["clip.exe", []]];
  for (const [command, args] of candidates) {
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        resolve(false);
        return;
      }
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    });
    if (ok) return command;
  }
  return null;
}
