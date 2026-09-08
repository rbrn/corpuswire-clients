import type { EnhanceErrorEnvelope, IndexTransferSummary, FetchLike, ReviewContextErrorV1 } from "./types.js";
export declare class CorpusWireHttpError extends Error {
    readonly transfer?: IndexTransferSummary;
    readonly status: number;
    readonly statusText: string;
    readonly responseBody: string;
    readonly requestId: string | null;
    readonly durationMs: number | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly errorDetail: unknown;
    readonly errorEnvelope: EnhanceErrorEnvelope | ReviewContextErrorV1 | null;
    readonly retryable: boolean;
    readonly retryAfterSeconds: number | null;
    readonly recoveryGuidance: readonly string[];
    constructor(status: number, statusText: string, responseBody: string, options?: {
        requestId?: string | null;
        durationMs?: number | null;
        errorCode?: string | null;
        errorMessage?: string | null;
        errorDetail?: unknown;
        errorEnvelope?: EnhanceErrorEnvelope | ReviewContextErrorV1 | null;
        retryable?: boolean;
        retryAfterSeconds?: number | null;
        recoveryGuidance?: readonly string[];
    });
}
export interface RequestJsonOptions {
    baseUrl: string;
    paths: string[];
    fetchFn?: FetchLike;
    defaultHeaders?: Record<string, string>;
    basicAuth?: string;
    init?: RequestInit;
    retryAttempts?: number;
    retryDelayMs?: number;
}
export declare function normalizeBaseUrl(baseUrl: string): string;
export declare function createBasicAuthHeader(credentials: string): string;
export declare function createBearerAuthHeader(token: string): string;
export declare function buildHeaders(defaultHeaders?: Record<string, string>, basicAuth?: string, initHeaders?: HeadersInit): Headers;
export declare function requestJson<T>(options: RequestJsonOptions): Promise<T>;
