import type { PromptRewriteResult } from "@corpuswire/sdk";

export type EnhancementQualityStatus = "grounded" | "degraded" | "ungrounded";

export interface EnhancementQuality {
  status: EnhancementQualityStatus;
  message: string;
  retrievedChunkCount: number;
  citationCount: number;
  confidence: number | null;
}

const DEFAULT_MINIMUM_CONFIDENCE = 0.35;
const MAX_WARNING_LENGTH = 240;

export function assessEnhancementQuality(
  result: PromptRewriteResult,
  minimumConfidence = DEFAULT_MINIMUM_CONFIDENCE,
): EnhancementQuality {
  const retrievedChunkCount = result.retrieved_chunks.length;
  const citationCount = result.citations.length;
  const confidence = typeof result.retrieval_confidence === "number"
    ? result.retrieval_confidence
    : null;
  const retrievalWarning = result.retrieval_warning?.trim() || "";

  if (result.retrieval_not_found === true || retrievedChunkCount === 0) {
    return {
      status: "ungrounded",
      message: "No workspace context was found. The rewrite only clarifies the original prompt; index or reconcile this workspace before relying on repository details.",
      retrievedChunkCount,
      citationCount,
      confidence,
    };
  }

  const degradationReasons: string[] = [];
  if (retrievalWarning) {
    degradationReasons.push(truncateWarning(retrievalWarning));
  }
  if (confidence !== null && confidence < minimumConfidence) {
    degradationReasons.push(`retrieval confidence is ${formatConfidence(confidence)}`);
  }
  if (citationCount === 0) {
    degradationReasons.push("no source citations were returned");
  }

  if (degradationReasons.length > 0) {
    return {
      status: "degraded",
      message: `Workspace context may be degraded: ${degradationReasons.join("; ")}. Review the retrieved paths or reconcile the index.`,
      retrievedChunkCount,
      citationCount,
      confidence,
    };
  }

  const confidenceText = confidence === null ? "confidence unavailable" : `${formatConfidence(confidence)} confidence`;
  return {
    status: "grounded",
    message: `Grounded in ${retrievedChunkCount} workspace chunk${retrievedChunkCount === 1 ? "" : "s"} with ${citationCount} citation${citationCount === 1 ? "" : "s"} (${confidenceText}).`,
    retrievedChunkCount,
    citationCount,
    confidence,
  };
}

function formatConfidence(confidence: number): string {
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

function truncateWarning(warning: string): string {
  if (warning.length <= MAX_WARNING_LENGTH) {
    return warning;
  }
  return `${warning.slice(0, MAX_WARNING_LENGTH - 1).trimEnd()}…`;
}
