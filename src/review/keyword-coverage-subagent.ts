import crypto from "node:crypto";
import { z } from "zod";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import { extractPayloadText } from "../classification/subagent.js";
import { agentSessionsPath, agentWorkspacePath } from "../file-utils.js";
import {
  buildEmbeddedSubagentRunDefaults,
  extractEmbeddedRunError,
} from "../subagent-runtime.js";
import type { ResolvedSkillHarnessPluginConfig, ThinkLevel } from "../types.js";
import {
  replayKeywordPhrase,
  type CoverageCandidateDocument,
} from "./keyword-coverage.js";
import type {
  ReviewTriggerKeywords,
  TriggerKeywordTarget,
} from "./trigger-keywords.js";

export interface KeywordCoverageReviewParams {
  dataRoot: string;
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  messageProvider?: string;
  triggerKeywords: ReviewTriggerKeywords;
  documents: CoverageCandidateDocument[];
  cursor?: Record<TriggerKeywordTarget, number>;
  config: {
    model: string;
    modelFallback?: string;
    thinking: ThinkLevel;
    timeoutMs: number;
  };
  /** Production path: OpenClaw API for embedded agent execution. */
  api?: OpenClawPluginApi;
  modelRef?: { provider: string; model: string };
  pluginConfig?: ResolvedSkillHarnessPluginConfig;
  /**
   * Test/injection path: skip embedded agent and parse this response directly.
   * When set, two-pass model execution is not used.
   */
  modelResponse?: string;
  /** Test-only: inject staged responses for discovery then adjudication. */
  stagedModelResponses?: {
    discovery?: string;
    adjudication?: string;
  };
  toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
  error?: Error;
}

export interface KeywordCoverageDecision {
  target: TriggerKeywordTarget;
  addition?: { phrase: string; supportRefs: string[] };
  removal?: { phrase: string; falsePositiveRefs: string[] };
  outcome: "finding" | "nofinding";
}

export interface KeywordCoverageReviewerResult {
  decisions: KeywordCoverageDecision[];
}

const TRIGGER_KEYWORD_TARGETS = [
  "successful-pattern",
  "behavior-fix",
  "entity-context",
] as const satisfies readonly TriggerKeywordTarget[];

const MAX_ADDITIONS_PER_TARGET = 1;
const MAX_REMOVALS_PER_TARGET = 1;

const OutcomeSchema = z.enum(["finding", "nofinding"]);

const AdditionSchema = z.object({
  phrase: z.string().trim().min(1),
  supportRefs: z.array(z.string().trim().min(1)).min(1),
});

const RemovalSchema = z.object({
  phrase: z.string().trim().min(1),
  falsePositiveRefs: z.array(z.string().trim().min(1)).min(1),
});

const DecisionSchema = z.object({
  target: z.enum(TRIGGER_KEYWORD_TARGETS),
  addition: AdditionSchema.optional(),
  removal: RemovalSchema.optional(),
  outcome: OutcomeSchema,
});

const ResponseSchema = z.object({
  decisions: z.array(DecisionSchema),
});

function escapeXmlContent(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${pad}${line}`))
    .join("\n");
}

function formatDocument(doc: CoverageCandidateDocument): string {
  const lines: string[] = [];
  lines.push(
    `<document ref="${escapeXmlContent(doc.ref)}" target="${escapeXmlContent(doc.target)}">`,
  );
  lines.push(`  <input>${escapeXmlContent(doc.input)}</input>`);
  if (doc.result) {
    lines.push(`  <result>${escapeXmlContent(doc.result)}</result>`);
  }
  if (doc.toolSummary.length > 0) {
    lines.push("  <tools>");
    for (const tool of doc.toolSummary) {
      const status = tool.success === false || tool.error ? "error" : "success";
      lines.push(
        `    <tool name="${escapeXmlContent(tool.name)}" status="${status}" />`,
      );
    }
    lines.push("  </tools>");
  }
  lines.push("</document>");
  return lines.join("\n");
}

function formatCurrentKeywords(triggerKeywords: ReviewTriggerKeywords): string {
  return [
    "<current_keywords>",
    `  <successful_pattern>${escapeXmlContent(JSON.stringify(triggerKeywords.successfulPattern))}</successful_pattern>`,
    `  <behavior_fix>${escapeXmlContent(JSON.stringify(triggerKeywords.behaviorFix))}</behavior_fix>`,
    `  <entity_context>${escapeXmlContent(JSON.stringify(triggerKeywords.entityContext))}</entity_context>`,
    "</current_keywords>",
  ].join("\n");
}

export function buildKeywordCoverageDiscoveryPrompt(
  documents: CoverageCandidateDocument[],
  triggerKeywords: ReviewTriggerKeywords,
): string {
  const candidateBlock =
    documents.length === 0
      ? "  <candidates />"
      : [
          "  <candidates>",
          ...documents.map((doc) => indentBlock(formatDocument(doc), 4)),
          "  </candidates>",
        ].join("\n");

  return [
    "<keyword_coverage_discovery>",
    "  <instructions>",
    "    Propose at most one addition and one removal per target for keyword coverage gaps.",
    "    Targets: successful-pattern, behavior-fix, entity-context.",
    "    Use only document refs from candidates. Do not invent identifiers.",
    "    Prefer durable phrases; reject generic tokens like ok/好/不要.",
    "    Return JSON only. No tools. No file edits.",
    "  </instructions>",
    indentBlock(formatCurrentKeywords(triggerKeywords), 2),
    candidateBlock,
    "  <output_format>",
    "    {",
    '      "decisions": [',
    "        {",
    '          "target": "successful-pattern",',
    '          "addition": { "phrase": "...", "supportRefs": ["ref"] },',
    '          "removal": { "phrase": "...", "falsePositiveRefs": ["ref"] },',
    '          "outcome": "finding"',
    "        }",
    "      ]",
    "    }",
    "  </output_format>",
    "</keyword_coverage_discovery>",
  ].join("\n");
}

export function buildKeywordCoverageAdjudicationPrompt(params: {
  documents: CoverageCandidateDocument[];
  triggerKeywords: ReviewTriggerKeywords;
  discoveryDecisions: KeywordCoverageDecision[];
  replayEvidence: Array<{
    target: TriggerKeywordTarget;
    kind: "addition" | "removal";
    phrase: string;
    matchedRefs: string[];
  }>;
}): string {
  const candidateBlock =
    params.documents.length === 0
      ? "  <candidates />"
      : [
          "  <candidates>",
          ...params.documents.map((doc) => indentBlock(formatDocument(doc), 4)),
          "  </candidates>",
        ].join("\n");

  const discoveryJson = escapeXmlContent(
    JSON.stringify({ decisions: params.discoveryDecisions }),
  );
  const replayJson = escapeXmlContent(JSON.stringify(params.replayEvidence));

  return [
    "<keyword_coverage_adjudication>",
    "  <instructions>",
    "    Confirm or reject discovery proposals after host literal replay.",
    "    Keep at most one addition and one removal per target.",
    "    Reject proposals whose support refs failed host replay or collide with existing keywords.",
    "    Return final JSON decisions only. No tools. No file edits.",
    "  </instructions>",
    indentBlock(formatCurrentKeywords(params.triggerKeywords), 2),
    candidateBlock,
    `  <discovery_proposals>${discoveryJson}</discovery_proposals>`,
    `  <host_replay>${replayJson}</host_replay>`,
    "  <output_format>",
    "    {",
    '      "decisions": [',
    "        {",
    '          "target": "successful-pattern",',
    '          "addition": { "phrase": "...", "supportRefs": ["ref"] },',
    '          "outcome": "finding"',
    "        }",
    "      ]",
    "    }",
    "  </output_format>",
    "</keyword_coverage_adjudication>",
  ].join("\n");
}

/** @deprecated Use buildKeywordCoverageDiscoveryPrompt */
export function buildKeywordCoveragePrompt(
  documents: CoverageCandidateDocument[],
  triggerKeywords: ReviewTriggerKeywords,
): string {
  return buildKeywordCoverageDiscoveryPrompt(documents, triggerKeywords);
}

function validateRefs(
  refs: string[],
  target: TriggerKeywordTarget,
  documents: CoverageCandidateDocument[],
): boolean {
  const validRefs = new Set(
    documents.filter((doc) => doc.target === target).map((doc) => doc.ref),
  );
  return refs.every((ref) => validRefs.has(ref));
}

function deduplicatePhrases(
  decisions: KeywordCoverageDecision[],
): KeywordCoverageDecision[] {
  const seen = new Map<TriggerKeywordTarget, Set<string>>();
  const result: KeywordCoverageDecision[] = [];

  for (const decision of decisions) {
    const targetPhrases = seen.get(decision.target) ?? new Set<string>();
    seen.set(decision.target, targetPhrases);
    let addition = decision.addition;
    let removal = decision.removal;

    if (addition) {
      if (targetPhrases.has(addition.phrase)) addition = undefined;
      else targetPhrases.add(addition.phrase);
    }
    if (removal) {
      if (targetPhrases.has(removal.phrase)) removal = undefined;
      else targetPhrases.add(removal.phrase);
    }

    if (addition || removal || decision.outcome === "nofinding") {
      result.push({
        target: decision.target,
        ...(addition ? { addition } : {}),
        ...(removal ? { removal } : {}),
        outcome: decision.outcome,
      });
    }
  }

  return result;
}

function enforceQuotas(
  decisions: KeywordCoverageDecision[],
): KeywordCoverageDecision[] {
  const counts = new Map<
    TriggerKeywordTarget,
    { additions: number; removals: number }
  >();
  const result: KeywordCoverageDecision[] = [];

  for (const decision of decisions) {
    const targetCounts = counts.get(decision.target) ?? {
      additions: 0,
      removals: 0,
    };
    counts.set(decision.target, targetCounts);
    let addition = decision.addition;
    let removal = decision.removal;

    if (addition) {
      if (targetCounts.additions >= MAX_ADDITIONS_PER_TARGET)
        addition = undefined;
      else targetCounts.additions += 1;
    }
    if (removal) {
      if (targetCounts.removals >= MAX_REMOVALS_PER_TARGET) removal = undefined;
      else targetCounts.removals += 1;
    }

    if (addition || removal || decision.outcome === "nofinding") {
      result.push({
        target: decision.target,
        ...(addition ? { addition } : {}),
        ...(removal ? { removal } : {}),
        outcome: decision.outcome,
      });
    }
  }

  return result;
}

export function parseKeywordCoverageModelResponse(
  modelResponse: string | undefined,
  documents: CoverageCandidateDocument[],
  options: {
    toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
    error?: Error;
    triggerKeywords?: ReviewTriggerKeywords;
  } = {},
): KeywordCoverageReviewerResult | undefined {
  const { toolCalls, error } = options;

  if (toolCalls && toolCalls.length > 0) {
    logger.warn("keyword coverage review rejected: tools were used", {
      toolCount: toolCalls.length,
    });
    return undefined;
  }

  if (error) {
    logger.warn("keyword coverage review failed", { error: error.message });
    return undefined;
  }

  if (!modelResponse || modelResponse.trim() === "") {
    logger.warn("keyword coverage review failed: empty model response");
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(modelResponse);
  } catch (err) {
    logger.warn("keyword coverage review failed: invalid JSON", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  const parseResult = ResponseSchema.safeParse(parsed);
  if (!parseResult.success) {
    logger.warn("keyword coverage review failed: schema validation", {
      errors: parseResult.error.issues,
    });
    return undefined;
  }

  const validDecisions: KeywordCoverageDecision[] = [];

  for (const decision of parseResult.data.decisions) {
    if (
      decision.outcome === "finding" &&
      !decision.addition &&
      !decision.removal
    ) {
      logger.warn(
        "keyword coverage review failed: finding without addition/removal",
        { target: decision.target },
      );
      return undefined;
    }
    if (
      decision.outcome === "nofinding" &&
      (decision.addition || decision.removal)
    ) {
      logger.warn("keyword coverage review failed: nofinding with mutation", {
        target: decision.target,
      });
      return undefined;
    }

    if (
      decision.addition &&
      !validateRefs(decision.addition.supportRefs, decision.target, documents)
    ) {
      logger.warn("keyword coverage review failed: invalid refs in addition", {
        target: decision.target,
        refs: decision.addition.supportRefs,
      });
      return undefined;
    }

    if (
      decision.removal &&
      !validateRefs(
        decision.removal.falsePositiveRefs,
        decision.target,
        documents,
      )
    ) {
      logger.warn("keyword coverage review failed: invalid refs in removal", {
        target: decision.target,
        refs: decision.removal.falsePositiveRefs,
      });
      return undefined;
    }

    if (decision.removal && options.triggerKeywords) {
      const targetKeywords =
        decision.target === "successful-pattern"
          ? options.triggerKeywords.successfulPattern
          : decision.target === "behavior-fix"
            ? options.triggerKeywords.behaviorFix
            : options.triggerKeywords.entityContext;
      const completeRefs = replayKeywordPhrase({
        phrase: decision.removal.phrase,
        target: decision.target,
        documents: documents.filter((doc) => doc.target === decision.target),
        config: {} as never,
        triggerKeywords: options.triggerKeywords,
      })
        .matches.map((document) => document.ref)
        .sort();
      const proposedRefs = [
        ...new Set(decision.removal.falsePositiveRefs),
      ].sort();
      if (
        !targetKeywords.some(
          (keyword) =>
            keyword.toLocaleLowerCase() ===
            decision.removal!.phrase.toLocaleLowerCase(),
        ) ||
        proposedRefs.length !== completeRefs.length ||
        proposedRefs.some((ref, index) => ref !== completeRefs[index])
      ) {
        logger.warn(
          "keyword coverage review failed: incomplete removal evidence",
          {
            target: decision.target,
            phrase: decision.removal.phrase,
          },
        );
        return undefined;
      }
    }

    validDecisions.push(decision);
  }

  return {
    decisions: enforceQuotas(deduplicatePhrases(validDecisions)),
  };
}

function buildReplayEvidence(
  decisions: KeywordCoverageDecision[],
  documents: CoverageCandidateDocument[],
): Array<{
  target: TriggerKeywordTarget;
  kind: "addition" | "removal";
  phrase: string;
  matchedRefs: string[];
}> {
  const evidence: Array<{
    target: TriggerKeywordTarget;
    kind: "addition" | "removal";
    phrase: string;
    matchedRefs: string[];
  }> = [];

  for (const decision of decisions) {
    if (decision.addition) {
      const targetDocs = documents.filter(
        (doc) => doc.target === decision.target,
      );
      const replay = replayKeywordPhrase({
        phrase: decision.addition.phrase,
        target: decision.target,
        documents: targetDocs,
        config: {} as never,
        triggerKeywords: {
          successfulPattern: [],
          behaviorFix: [],
          entityContext: [],
        },
      });
      const matchedRefs = replay.matches.map((match) => match.ref);
      const supportOk = decision.addition.supportRefs.every((ref) =>
        matchedRefs.includes(ref),
      );
      evidence.push({
        target: decision.target,
        kind: "addition",
        phrase: decision.addition.phrase,
        matchedRefs: supportOk ? matchedRefs : [],
      });
    }

    if (decision.removal) {
      const targetDocs = documents.filter(
        (doc) => doc.target === decision.target,
      );
      const replay = replayKeywordPhrase({
        phrase: decision.removal.phrase,
        target: decision.target,
        documents: targetDocs,
        config: {} as never,
        triggerKeywords: {
          successfulPattern: [],
          behaviorFix: [],
          entityContext: [],
        },
      });
      const matchedRefs = replay.matches.map((match) => match.ref);
      const supportOk = decision.removal.falsePositiveRefs.every((ref) =>
        matchedRefs.includes(ref),
      );
      evidence.push({
        target: decision.target,
        kind: "removal",
        phrase: decision.removal.phrase,
        matchedRefs: supportOk ? matchedRefs : [],
      });
    }
  }

  return evidence;
}

function filterDecisionsByReplay(
  decisions: KeywordCoverageDecision[],
  replayEvidence: Array<{
    target: TriggerKeywordTarget;
    kind: "addition" | "removal";
    phrase: string;
    matchedRefs: string[];
  }>,
): KeywordCoverageDecision[] {
  return decisions
    .map((decision) => {
      let addition = decision.addition;
      let removal = decision.removal;

      if (addition) {
        const evidence = replayEvidence.find(
          (item) =>
            item.target === decision.target &&
            item.kind === "addition" &&
            item.phrase === addition!.phrase,
        );
        if (!evidence || evidence.matchedRefs.length === 0) {
          addition = undefined;
        }
      }

      if (removal) {
        const evidence = replayEvidence.find(
          (item) =>
            item.target === decision.target &&
            item.kind === "removal" &&
            item.phrase === removal!.phrase,
        );
        if (!evidence || evidence.matchedRefs.length === 0) {
          removal = undefined;
        }
      }

      if (!addition && !removal) {
        return {
          target: decision.target,
          outcome: "nofinding" as const,
        };
      }

      return {
        target: decision.target,
        ...(addition ? { addition } : {}),
        ...(removal ? { removal } : {}),
        outcome: "finding" as const,
      };
    })
    .filter((decision, index, all) => {
      // Keep one decision per target; prefer finding over nofinding duplicates.
      const firstFinding = all.findIndex(
        (item) => item.target === decision.target && item.outcome === "finding",
      );
      if (firstFinding !== -1) return index === firstFinding;
      return all.findIndex((item) => item.target === decision.target) === index;
    });
}

function createCoverageSessionIdentity(params: {
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  hashInput: string;
}): { sessionId: string; sessionKey: string } {
  const runId = `skill-harness-keyword-coverage-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const scope = params.sessionKey ?? params.sessionId ?? crypto.randomUUID();
  const suffix = crypto
    .createHash("sha1")
    .update(`${scope}:${params.hashInput}`)
    .digest("hex")
    .slice(0, 12);
  const sessionKey = params.sessionKey
    ? `${params.sessionKey}:skill-harness-keyword-coverage:${suffix}`
    : `agent:${params.agentId}:skill-harness-keyword-coverage:${suffix}`;
  return { sessionId: runId, sessionKey };
}

function buildCoverageEmbeddedRunParams(params: {
  api: OpenClawPluginApi;
  agentId: string;
  dataRoot: string;
  sessionId: string;
  sessionKey: string;
  messageProvider?: string;
  modelRef: { provider: string; model: string };
  prompt: string;
  thinking: ThinkLevel;
  timeoutMs: number;
  pluginConfig?: ResolvedSkillHarnessPluginConfig;
}) {
  const workspaceDir = agentWorkspacePath(params.dataRoot);
  const sessionDir = agentSessionsPath(params.dataRoot, "keyword-coverage");
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    messageProvider: params.messageProvider,
    config: params.api.config,
    prompt: params.prompt,
    provider: params.modelRef.provider,
    model: params.modelRef.model,
    timeoutMs: params.timeoutMs,
    runId: params.sessionId,
    workspaceDir,
    agentDir: workspaceDir,
    sessionFile: `${sessionDir}/${params.sessionId}.session.jsonl`,
    ...buildEmbeddedSubagentRunDefaults(),
    modelRun: false,
    promptMode: "none" as const,
    toolsAllow: [] as string[],
    disableTools: true,
    thinkLevel: params.thinking,
  };
}

async function runCoverageModelPass(params: {
  api: OpenClawPluginApi;
  agentId: string;
  dataRoot: string;
  sessionId?: string;
  sessionKey?: string;
  messageProvider?: string;
  modelRef: { provider: string; model: string };
  prompt: string;
  thinking: ThinkLevel;
  timeoutMs: number;
  pluginConfig?: ResolvedSkillHarnessPluginConfig;
  injectedResponse?: string;
}): Promise<string | undefined> {
  if (params.injectedResponse !== undefined) {
    return params.injectedResponse;
  }

  const identity = createCoverageSessionIdentity({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    hashInput: params.prompt,
  });

  try {
    const result = await params.api.runtime.agent.runEmbeddedAgent(
      buildCoverageEmbeddedRunParams({
        api: params.api,
        agentId: params.agentId,
        dataRoot: params.dataRoot,
        sessionId: identity.sessionId,
        sessionKey: identity.sessionKey,
        messageProvider: params.messageProvider,
        modelRef: params.modelRef,
        prompt: params.prompt,
        thinking: params.thinking,
        timeoutMs: params.timeoutMs,
        pluginConfig: params.pluginConfig,
      }),
    );

    const embeddedError = extractEmbeddedRunError(result);
    if (embeddedError) {
      logger.warn("keyword coverage model pass returned an error", {
        error: embeddedError,
      });
      return undefined;
    }

    return extractPayloadText(result);
  } catch (err) {
    logger.warn("keyword coverage model pass failed", { error: err });
    return undefined;
  }
}

/**
 * Two-stage keyword coverage review:
 * 1. tool-free discovery model pass
 * 2. host literal replay boundary
 * 3. tool-free adjudication model pass
 *
 * Test injection:
 * - `modelResponse` short-circuits to single-pass parse (legacy unit tests)
 * - `stagedModelResponses` injects discovery/adjudication text without tools
 */
export async function runKeywordCoverageReview(
  params: KeywordCoverageReviewParams,
): Promise<KeywordCoverageReviewerResult | undefined> {
  const { documents, triggerKeywords } = params;

  // Preserve pure parse path used by focused unit tests.
  if (params.modelResponse !== undefined || params.error || params.toolCalls) {
    return parseKeywordCoverageModelResponse(params.modelResponse, documents, {
      toolCalls: params.toolCalls,
      error: params.error,
      triggerKeywords,
    });
  }

  const discoveryPrompt = buildKeywordCoverageDiscoveryPrompt(
    documents,
    triggerKeywords,
  );

  let discoveryRaw: string | undefined;
  if (params.stagedModelResponses?.discovery !== undefined) {
    discoveryRaw = params.stagedModelResponses.discovery;
  } else if (params.api && params.modelRef) {
    discoveryRaw = await runCoverageModelPass({
      api: params.api,
      agentId: params.agentId,
      dataRoot: params.dataRoot,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      modelRef: params.modelRef,
      prompt: discoveryPrompt,
      thinking: params.config.thinking,
      timeoutMs: params.config.timeoutMs,
      pluginConfig: params.pluginConfig,
    });
  } else {
    logger.warn("keyword coverage review failed: missing model execution path");
    return undefined;
  }

  const discovery = parseKeywordCoverageModelResponse(discoveryRaw, documents, {
    triggerKeywords,
  });
  if (!discovery) return undefined;

  const replayEvidence = buildReplayEvidence(discovery.decisions, documents);
  const replayFiltered = filterDecisionsByReplay(
    discovery.decisions,
    replayEvidence,
  );

  // If discovery already produced only nofinding, skip adjudication.
  if (replayFiltered.every((decision) => decision.outcome === "nofinding")) {
    return { decisions: replayFiltered };
  }

  const adjudicationPrompt = buildKeywordCoverageAdjudicationPrompt({
    documents,
    triggerKeywords,
    discoveryDecisions: replayFiltered,
    replayEvidence,
  });

  let adjudicationRaw: string | undefined;
  if (params.stagedModelResponses?.adjudication !== undefined) {
    adjudicationRaw = params.stagedModelResponses.adjudication;
  } else if (params.api && params.modelRef) {
    adjudicationRaw = await runCoverageModelPass({
      api: params.api,
      agentId: params.agentId,
      dataRoot: params.dataRoot,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      modelRef: params.modelRef,
      prompt: adjudicationPrompt,
      thinking: params.config.thinking,
      timeoutMs: params.config.timeoutMs,
      pluginConfig: params.pluginConfig,
    });
  } else {
    logger.warn(
      "keyword coverage adjudication failed: missing model execution path",
    );
    return undefined;
  }

  const adjudicated = parseKeywordCoverageModelResponse(
    adjudicationRaw,
    documents,
    { triggerKeywords },
  );
  if (!adjudicated) return undefined;

  // Final host gate: adjudication output must still pass replay.
  const finalReplay = buildReplayEvidence(adjudicated.decisions, documents);
  return {
    decisions: filterDecisionsByReplay(adjudicated.decisions, finalReplay),
  };
}
