import { execFile } from "node:child_process";

const TOKEN_TIMEOUT_MS = 5_000;
const TOKEN_MAX_BUFFER_BYTES = 64 * 1024;

export function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

export async function resolveCliBearerToken(
  baseUrl: string,
  cliPath = "corpuswire",
): Promise<string | null> {
  const normalizedCliPath = cliPath.trim() || "corpuswire";
  return new Promise((resolve) => {
    execFile(
      normalizedCliPath,
      ["auth", "token", "--base-url", baseUrl],
      {
        encoding: "utf8",
        timeout: TOKEN_TIMEOUT_MS,
        maxBuffer: TOKEN_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const token = stdout.trim();
        resolve(token || null);
      },
    );
  });
}
