import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { CorpusWireClient, requireEnhancedPrompt } from "../dist/index.js";

const execFileAsync = promisify(execFile);

type OpenClawRunOptions = {
  binary?: string;
  executionMode?: "local" | "gateway";
  model: string;
  prompt: string;
  systemPrompt?: string;
};

function buildOpenClawPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }

  return `System instructions:\n${systemPrompt.trim()}\n\nUser prompt:\n${prompt}`;
}

function extractOpenClawText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("outputs" in payload) || !Array.isArray((payload as { outputs: unknown[] }).outputs)) {
    throw new Error("OpenClaw CLI response did not include outputs.");
  }

  const outputs = (payload as { outputs: Array<{ text?: unknown }> }).outputs;
  const texts = outputs
    .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
    .filter((item) => item.length > 0);

  if (texts.length === 0) {
    throw new Error("OpenClaw CLI response did not include output text.");
  }

  return texts.join("\n");
}

async function runOpenClaw(options: OpenClawRunOptions): Promise<string> {
  const command = [
    "capability",
    "model",
    "run",
    "--json",
    `--${options.executionMode ?? "local"}`,
    "--model",
    options.model,
    "--prompt",
    buildOpenClawPrompt(options.prompt, options.systemPrompt),
  ];

  const { stdout } = await execFileAsync(options.binary ?? "openclaw", command);
  return extractOpenClawText(JSON.parse(stdout));
}

async function main(): Promise<void> {
  const client = new CorpusWireClient({
    baseUrl: process.env.CORPUSWIRE_BASE_URL ?? "http://127.0.0.1:8000",
    basicAuth: process.env.CORPUSWIRE_BASIC_AUTH,
  });

  const rewrite = await client.enhance({
    prompt: "Investigate the login failure, trace the root cause, implement the smallest safe fix, and validate it.",
    workspaceId: process.env.CORPUSWIRE_WORKSPACE_ID || undefined,
    repoPath: process.env.CORPUSWIRE_REPO_PATH || undefined,
    outputMode: "claude-code",
    topK: 6,
  });

  const enhancedPrompt = requireEnhancedPrompt(rewrite);
  const generatedText = await runOpenClaw({
    model: process.env.OPENCLAW_MODEL ?? "openai-codex/gpt-5.3-codex",
    binary: process.env.OPENCLAW_BINARY ?? "openclaw",
    executionMode: (process.env.OPENCLAW_EXECUTION_MODE as "local" | "gateway" | undefined) ?? "local",
    prompt: enhancedPrompt,
  });

  console.log(generatedText);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
