const EXPLICIT_SCOPE = /\b(?:overview|overall|workspace[- ]wide|end[- ]to[- ]end|entire|all\s+(?:services|components|modules)|across|within|using|when|during|between)\b|\b(?:in|for|from|through|on)\s+(?!it\b|this\b|that\b)\S+/i;
const CONCRETE_REFERENCE = /`[^`]+`|(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b\w+\.(?:py|js|ts|java|go|rs|md|json)\b|\b(?:[A-Z][a-z0-9]+){2,}\w*\b|\b[a-z]+[A-Z]\w*\b|#\d+\b|\b[0-9a-f]{7,40}\b/;
const GENERIC_MODIFIERS = /\b(?:a|an|the|our|current|existing|service|application|system|project|backend|frontend)\b/gi;
const VAGUE_ANSWER = /^(?:yes|no|maybe|whatever|anything|it|this|that|not sure|i(?:'|’)m not sure|i (?:do not|don't|don’t) know|idk|you decide)[.!?]*$/i;

function normalizeQuestion(prompt) {
  return prompt.replace(/\s+/g, " ").trim()
    .replace(/^(?:please\s+|(?:can|could|would) you(?: please)?\s+)/i, "")
    .replace(/[?.!]+$/, "")
    .replace(/\s+(?:exactly|in general)$/i, "")
    .replace(/\s+(?:in|within|for) (?:this|the|our|current) (?:project|repo(?:sitory)?|workspace|codebase|system)$/i, "");
}

function explanationSubject(normalized) {
  const match = normalized.match(/^(?:how (?:does|do) (.+?) work|how (?:is|are) (.+?) (?:implemented|configured|handled|managed)|(?:explain|describe|tell me about) (.+?))$/i);
  return match?.slice(1).find(Boolean)?.trim();
}

/** Identify broad requests whose intended scope cannot be safely inferred. */
export function assessPromptSufficiency(prompt) {
  let request = prompt;
  let labeledAnswer;
  while ((labeledAnswer = [...request.matchAll(/\n\n?User clarification:\s*\n/g)].at(-1))) {
    const original = request.slice(0, labeledAnswer.index);
    const answer = request.slice(labeledAnswer.index + labeledAnswer[0].length);
    if (isUsefulClarification(answer, original)) return null;
    request = original;
  }
  const normalized = normalizeQuestion(request);
  if (!normalized || EXPLICIT_SCOPE.test(normalized) || CONCRETE_REFERENCE.test(normalized)) return null;

  const subject = explanationSubject(normalized);
  const substantiveSubject = subject?.replace(GENERIC_MODIFIERS, " ").trim();
  // A stated aspect (e.g. audit logging, HTTP logging, logging levels) already
  // narrows an explanation. Generic role words such as "service" do not.
  const broadExplanation = substantiveSubject && /^[\p{L}\p{N}_-]+$/u.test(substantiveSubject);
  const action = normalized.match(/^(?:(?:please|can you|could you)\s+)?(?:fix|improve|update|refactor|debug|implement|add|change)\s+(.+?)[?.!]*$/i);
  const actionSubject = action?.[1].replace(GENERIC_MODIFIERS, " ").trim();
  const broadAction = actionSubject && /^[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+)?$/u.test(actionSubject);
  const missingTarget = /^(?:(?:please|can you|could you)\s+)?(?:fix|improve|update|refactor|debug|implement|add|change)(?:\s+(?:it|this|that|something|the (?:bug|issue|code|feature|system)))?[?.!]*$/i.test(normalized);
  const topicOnly = /^[\p{L}\p{N}_-]+[?.!]*$/u.test(normalized);
  if (!broadExplanation && !broadAction && !missingTarget && !topicOnly) return null;

  const logging = /\b(?:logging|logs)\b/i.test(subject ?? normalized);
  const question = missingTarget || broadAction
    ? "Which component or behavior should change, and what outcome do you want?"
    : logging
      ? "Which part of logging should this cover: application/runtime logs, HTTP access logs, audit events, or an overview across the selected workspace?"
      : subject
        ? `What should the explanation of ${subject} focus on: a particular component, configuration, runtime flow, or an overview across the selected workspace?`
        : `What do you want to do with “${normalized}”, and which component or behavior should this cover?`;
  return {
    status: "needs_clarification", source: "heuristic", original_prompt: prompt,
    questions: [{ id: "scope", question }],
  };
}

/** Require an actual choice or description rather than an unresolved answer. */
export function isUsefulClarification(answer, originalPrompt = "") {
  if (typeof answer !== "string" || !/[\p{L}\p{N}]/u.test(answer) || VAGUE_ANSWER.test(answer.trim())) return false;
  const compare = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const original = normalizeQuestion(originalPrompt);
  const subject = explanationSubject(original)
    ?? original.match(/^(?:fix|improve|update|refactor|debug|implement|add|change)\s+(.+)$/i)?.[1];
  return compare(answer) !== compare(originalPrompt) && compare(answer) !== compare(subject ?? "");
}

/** Keep the original request intact and label the user's additional intent. */
export function appendPromptClarification(originalPrompt, answer) {
  if (!isUsefulClarification(answer, originalPrompt)) throw new Error("Describe the intended scope, or explicitly request a workspace-wide overview.");
  return `${originalPrompt}\n\nUser clarification:\n${answer.trim()}`;
}
