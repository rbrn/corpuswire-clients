import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const TOKEN_TIMEOUT_MS = 5_000;
const TOKEN_MAX_BUFFER_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const KEYCHAIN_SERVICE = "corpuswire-service-auth-v1";

type ExecFileLike = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

/** Injectable for tests; production uses the real environment and home directory. */
export interface LocalTokenDependencies {
  env?: Record<string, string | undefined>;
  homeDirectory?: string;
  credentialFile?: string;
  platform?: string;
  getuid?: () => number;
  execFile?: ExecFileLike;
}

export function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

/**
 * Resolve a bearer token the same way the `cw` CLI does, then fall back to
 * the configured `corpuswire auth token` helper:
 * 1. `CORPUSWIRE_BEARER_TOKEN` in the extension host environment;
 * 2. for a loopback service only, the owner-only CLI credential file
 *    `~/.local/share/corpuswire/cli-credentials.json`;
 * 3. for a loopback service on macOS, the `corpuswire-service-auth-v1`
 *    keychain item;
 * 4. the `auth.cliPath` helper.
 */
export async function resolveServiceBearerToken(
  baseUrl: string,
  cliPath = "corpuswire",
  dependencies: LocalTokenDependencies = {},
): Promise<string | null> {
  const env = dependencies.env ?? process.env;
  const envToken = env.CORPUSWIRE_BEARER_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  const localToken = await resolveLocalServiceToken(baseUrl, dependencies);
  if (localToken) {
    return localToken;
  }
  return resolveCliBearerToken(baseUrl, cliPath, dependencies.execFile);
}

export async function resolveLocalServiceToken(
  baseUrl: string,
  dependencies: LocalTokenDependencies = {},
): Promise<string | null> {
  const account = loopbackServiceAccount(baseUrl);
  if (!account) {
    return null;
  }
  const credentialFile = dependencies.credentialFile ?? path.join(
    dependencies.homeDirectory ?? homedir(), ".local", "share", "corpuswire", "cli-credentials.json",
  );
  const fileToken = await readPrivateServiceToken(credentialFile, account, dependencies.getuid ?? process.getuid);
  if (fileToken) {
    return fileToken;
  }
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return null;
  }
  const run = dependencies.execFile ?? (execFile as unknown as ExecFileLike);
  return new Promise((resolve) => {
    run(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", timeout: TOKEN_TIMEOUT_MS, maxBuffer: TOKEN_MAX_BUFFER_BYTES },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });
}

export async function resolveCliBearerToken(
  baseUrl: string,
  cliPath = "corpuswire",
  run: ExecFileLike = execFile as unknown as ExecFileLike,
): Promise<string | null> {
  const normalizedCliPath = cliPath.trim() || "corpuswire";
  return new Promise((resolve) => {
    run(
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
        const token = String(stdout).trim();
        resolve(token || null);
      },
    );
  });
}

/** The CLI's credential account key: `scheme://host[:port]/path` without a trailing slash, loopback only. */
export function loopbackServiceAccount(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !LOOPBACK_HOSTS.has(url.hostname)) {
    return null;
  }
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Read the token for `account` from the CLI credential file. The file must be
 * a regular, owner-only file (mode 0600 or stricter) owned by this user;
 * anything else is ignored rather than trusted.
 */
async function readPrivateServiceToken(
  filePath: string,
  account: string,
  getuid: (() => number) | undefined,
): Promise<string | null> {
  const uid = getuid?.();
  const isPrivate = (stats: { isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }) =>
    stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o7177) === 0 && (uid === undefined || stats.uid === uid);
  try {
    if (!isPrivate(await lstat(filePath))) {
      return null;
    }
  } catch {
    return null;
  }
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!isPrivate(stats) || stats.size > TOKEN_MAX_BUFFER_BYTES) {
      return null;
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value?.schemaVersion !== 1 || !value.services || typeof value.services !== "object") {
      return null;
    }
    const token = value.services[account]?.bearerToken;
    return typeof token === "string" && token.trim() && !/[\r\n]/.test(token) ? token.trim() : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
