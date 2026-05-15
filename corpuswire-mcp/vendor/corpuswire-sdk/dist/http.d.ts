import type { EnhanceErrorEnvelope, FetchLike } from "./types.js";
export declare class CorpusWireHttpError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly responseBody: string;
    readonly requestId: string | null;
    readonly durationMs: number | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly errorDetail: unknown;
    readonly errorEnvelope: EnhanceErrorEnvelope | null;
    constructor(status: number, statusText: string, responseBody: string, options?: {
        requestId?: string | null;
        durationMs?: number | null;
        errorCode?: string | null;
        errorMessage?: string | null;
        errorDetail?: unknown;
        errorEnvelope?: EnhanceErrorEnvelope | null;
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
export declare function buildHeaders(defaultHeaders?: Record<string, string>, basicAuth?: string, initHeaders?: HeadersInit): Headers;
export declare function requestJson<T>(options: RequestJsonOptions): Promise<T>;
