import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PromptOutputMode } from "@corpuswire/sdk";

export const CONFIG_SECTION = "corpuswire";
const LEGACY_CONTEXT_ENGINE_CONFIG_SECTION = "corpuswireContextEngine";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_OUTPUT_MODE: PromptOutputMode = "generic";
const DEFAULT_TOP_K = 5;
const DEFAULT_API_KEY_HEADER = "Authorization";
const DEFAULT_USER_CONFIG_PATHS = [
  "~/.config/corpuswire/vscode-extension.json",
  "~/.corpuswire/vscode-extension.json",
];

type ConfigRecord = Record<string, unknown>;

export type RemoteServiceName = "indexer" | "enhancer" | "semanticSearch";

export interface RemoteServiceSettings {
  url: string;
  apiKey: string;
  apiKeyHeader: string;
  basicAuth: string;
  headers: Record<string, string>;
}

export interface ExtensionSettings {
  baseUrl: string;
  repoPath?: string;
  topK: number;
  outputMode: PromptOutputMode;
  localOnly: boolean;
  remoteIndexing: RemoteIndexingSettings;
  services: Record<RemoteServiceName, RemoteServiceSettings>;
  configurationWarnings: string[];
}

export interface RemoteIndexingSettings {
  enabled: boolean;
  autoWatch: boolean;
  workspaceId?: string;
  maxConcurrentUploads: number;
  batchBytes: number;
}

interface HomeConfiguration {
  values: ConfigRecord;
  warnings: string[];
}

interface LegacyContextEngineSettings {
  baseUrl: string;
  workspaceId: string;
  outputMode: string;
}

export function readSettings(resource?: vscode.Uri): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const legacyContextEngineSettings = readLegacyContextEngineSettings(resource);
  const homeConfiguration = loadHomeConfiguration(readConfiguredUserConfigPath(config));
  const workspaceFolder = resolveWorkspaceFolder(resource);
  const workspaceFolderPath = workspaceFolder?.uri.fsPath;
  const configuredRepoPath = readConfiguredString(config, homeConfiguration.values, "repoPath", "");
  const baseUrl = normalizeUrl(
    readConfiguredString(
      config,
      homeConfiguration.values,
      "baseUrl",
      legacyContextEngineSettings.baseUrl || DEFAULT_BASE_URL,
    ),
    DEFAULT_BASE_URL,
  );
  const serviceDefaults = readServiceDefaults(config, homeConfiguration.values, baseUrl);
  const configuredWorkspaceId = readConfiguredString(
    config,
    homeConfiguration.values,
    "remoteIndexing.workspaceId",
    "",
  );
  const workspaceId = configuredWorkspaceId || legacyContextEngineSettings.workspaceId || workspaceFolder?.uri.toString();

  return {
    baseUrl,
    repoPath: resolveRepoPath(configuredRepoPath, workspaceFolderPath),
    topK: normalizeTopK(readConfiguredNumber(config, homeConfiguration.values, "topK", DEFAULT_TOP_K)),
    outputMode: normalizeOutputMode(
      readConfiguredString(
        config,
        homeConfiguration.values,
        "outputMode",
        legacyContextEngineSettings.outputMode || DEFAULT_OUTPUT_MODE,
      ),
    ),
    localOnly: readConfiguredBoolean(config, homeConfiguration.values, "localOnly", false),
    remoteIndexing: {
      enabled: readConfiguredBoolean(
        config,
        homeConfiguration.values,
        "remoteIndexing.enabled",
        Boolean(legacyContextEngineSettings.workspaceId),
      ),
      autoWatch: readConfiguredBoolean(config, homeConfiguration.values, "remoteIndexing.autoWatch", false),
      workspaceId,
      maxConcurrentUploads: normalizePositiveInteger(
        readConfiguredNumber(config, homeConfiguration.values, "remoteIndexing.maxConcurrentUploads", 4),
        4,
      ),
      batchBytes: normalizePositiveInteger(
        readConfiguredNumber(config, homeConfiguration.values, "remoteIndexing.batchBytes", 4_194_304),
        4_194_304,
      ),
    },
    services: {
      indexer: readRemoteServiceSettings(config, homeConfiguration.values, "indexer", serviceDefaults),
      enhancer: readRemoteServiceSettings(config, homeConfiguration.values, "enhancer", serviceDefaults),
      semanticSearch: readRemoteServiceSettings(config, homeConfiguration.values, "semanticSearch", serviceDefaults),
    },
    configurationWarnings: homeConfiguration.warnings,
  };
}

function readLegacyContextEngineSettings(resource?: vscode.Uri): LegacyContextEngineSettings {
  const legacyConfig = vscode.workspace.getConfiguration(LEGACY_CONTEXT_ENGINE_CONFIG_SECTION, resource);

  return {
    baseUrl: readLegacyString(legacyConfig, "baseUrl"),
    workspaceId: readLegacyString(legacyConfig, "workspaceId"),
    outputMode: readLegacyString(legacyConfig, "outputMode"),
  };
}

export function buildRemoteServiceHeaders(service: RemoteServiceSettings): Record<string, string> {
  const headers = { ...service.headers };

  if (service.apiKey) {
    setHeaderIfMissing(
      headers,
      service.apiKeyHeader,
      service.apiKeyHeader.toLowerCase() === "authorization" ? `Bearer ${service.apiKey}` : service.apiKey,
    );
  }

  if (service.basicAuth) {
    setHeaderIfMissing(headers, "Authorization", createBasicAuthHeader(service.basicAuth));
  }

  return headers;
}

function readServiceDefaults(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  baseUrl: string,
): RemoteServiceSettings {
  const defaultUrl = normalizeUrl(
    readConfiguredString(config, homeValues, "serviceDefaults.url", baseUrl),
    baseUrl,
  );

  return {
    url: defaultUrl,
    apiKey: readConfiguredString(config, homeValues, "serviceDefaults.apiKey", ""),
    apiKeyHeader: readConfiguredString(config, homeValues, "serviceDefaults.apiKeyHeader", DEFAULT_API_KEY_HEADER)
      || DEFAULT_API_KEY_HEADER,
    basicAuth: readConfiguredString(config, homeValues, "serviceDefaults.basicAuth", ""),
    headers: readConfiguredRecord(config, homeValues, "serviceDefaults.headers", {}),
  };
}

function readRemoteServiceSettings(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  serviceName: RemoteServiceName,
  defaults: RemoteServiceSettings,
): RemoteServiceSettings {
  const prefix = `services.${serviceName}`;

  return {
    url: normalizeUrl(readConfiguredString(config, homeValues, `${prefix}.url`, defaults.url), defaults.url),
    apiKey: readConfiguredString(config, homeValues, `${prefix}.apiKey`, defaults.apiKey),
    apiKeyHeader: readConfiguredString(config, homeValues, `${prefix}.apiKeyHeader`, defaults.apiKeyHeader)
      || defaults.apiKeyHeader,
    basicAuth: readConfiguredString(config, homeValues, `${prefix}.basicAuth`, defaults.basicAuth),
    headers: {
      ...defaults.headers,
      ...readConfiguredRecord(config, homeValues, `${prefix}.headers`, {}),
    },
  };
}

function readConfiguredUserConfigPath(config: vscode.WorkspaceConfiguration): string {
  const configuredPath = readVsCodeScopedValue(config, "userConfigPath");
  return typeof configuredPath === "string" ? configuredPath.trim() : "";
}

function readLegacyString(config: vscode.WorkspaceConfiguration, key: string): string {
  const value = readVsCodeScopedValue(config, key);
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function loadHomeConfiguration(configuredPath: string): HomeConfiguration {
  const warnings: string[] = [];
  const candidatePaths = configuredPath
    ? [configuredPath]
    : DEFAULT_USER_CONFIG_PATHS;

  for (const candidatePath of candidatePaths) {
    const expandedPath = expandHomePath(candidatePath);
    if (!fs.existsSync(expandedPath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(expandedPath, "utf8")) as unknown;
      if (!isRecord(parsed)) {
        warnings.push(`CorpusWire user config at ${expandedPath} must contain a JSON object.`);
        return { values: {}, warnings };
      }

      return { values: parsed, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not read CorpusWire user config at ${expandedPath}: ${message}`);
      return { values: {}, warnings };
    }
  }

  return { values: {}, warnings };
}

function readConfiguredString(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  key: string,
  fallback: string,
): string {
  const value = readHierarchicalValue(config, homeValues, key);
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function readConfiguredNumber(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  key: string,
  fallback: number,
): number {
  const value = readHierarchicalValue(config, homeValues, key);
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function readConfiguredBoolean(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  key: string,
  fallback: boolean,
): boolean {
  const value = readHierarchicalValue(config, homeValues, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return fallback;
}

function readConfiguredRecord(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  key: string,
  fallback: Record<string, string>,
): Record<string, string> {
  const inspected = config.inspect<unknown>(key);

  return {
    ...fallback,
    ...normalizeStringRecord(readHomeValue(homeValues, key)),
    ...normalizeStringRecord(inspected?.globalValue),
    ...normalizeStringRecord(inspected?.workspaceValue),
    ...normalizeStringRecord(inspected?.workspaceFolderValue),
  };
}

function readHierarchicalValue(
  config: vscode.WorkspaceConfiguration,
  homeValues: ConfigRecord,
  key: string,
): unknown {
  const vscodeValue = readVsCodeScopedValue(config, key);
  if (vscodeValue !== undefined) {
    return vscodeValue;
  }

  return readHomeValue(homeValues, key);
}

function readVsCodeScopedValue(config: vscode.WorkspaceConfiguration, key: string): unknown {
  const inspected = config.inspect<unknown>(key);

  return firstDefined(
    inspected?.workspaceFolderValue,
    inspected?.workspaceValue,
    inspected?.globalValue,
  );
}

function readHomeValue(homeValues: ConfigRecord, key: string): unknown {
  const fullKeyValue = homeValues[`${CONFIG_SECTION}.${key}`];
  if (fullKeyValue !== undefined) {
    return fullKeyValue;
  }

  const section = isRecord(homeValues[CONFIG_SECTION]) ? homeValues[CONFIG_SECTION] : homeValues;
  const directSectionValue = section[key];
  if (directSectionValue !== undefined) {
    return directSectionValue;
  }

  return getNestedValue(section, key.split("."));
}

function getNestedValue(value: unknown, pathSegments: string[]): unknown {
  let current = value;
  for (const segment of pathSegments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    const headerName = key.trim();
    if (!headerName || entryValue === undefined || entryValue === null) {
      continue;
    }

    const headerValue = String(entryValue).trim();
    if (headerValue) {
      normalized[headerName] = headerValue;
    }
  }

  return normalized;
}

function resolveWorkspaceFolder(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (resource) {
    return vscode.workspace.getWorkspaceFolder(resource);
  }

  return vscode.workspace.workspaceFolders?.[0];
}

function resolveRepoPath(configuredRepoPath: string, workspaceFolder?: string): string | undefined {
  if (!configuredRepoPath) {
    return workspaceFolder;
  }

  const expandedPath = expandHomePath(configuredRepoPath);
  if (workspaceFolder) {
    return expandedPath.replaceAll("${workspaceFolder}", workspaceFolder);
  }

  return expandedPath;
}

function normalizeTopK(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_TOP_K;
  }

  return Math.floor(value);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeOutputMode(value: string | undefined): PromptOutputMode {
  if (
    value === "generic"
    || value === "copilot"
    || value === "claude-code"
    || value === "sequential"
  ) {
    return value;
  }

  return DEFAULT_OUTPUT_MODE;
}

function normalizeUrl(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  return normalized || fallback;
}

function setHeaderIfMissing(headers: Record<string, string>, headerName: string, value: string): void {
  if (findHeaderKey(headers, headerName)) {
    return;
  }

  headers[headerName] = value;
}

function findHeaderKey(headers: Record<string, string>, headerName: string): string | undefined {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalizedHeaderName);
}

function createBasicAuthHeader(credentials: string): string {
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
