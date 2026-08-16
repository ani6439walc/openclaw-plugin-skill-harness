import crypto from "node:crypto";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import type { RecentTurn } from "../types.js";
import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import { limitConversationTurns } from "../classification/conversation.js";
import type { AvailableSkill } from "../skills/types.js";
import type { SkillExperienceEntry } from "../experiences/types.js";
import { indentXmlLines } from "../xml-format.js";
import type { SessionCurationRecord } from "./types.js";
import { getModelRef } from "../classification/subagent.js";
import { agentSessionsPath, agentWorkspacePath } from "../file-utils.js";
import {
  buildEmbeddedSubagentRunDefaults,
  extractEmbeddedRunError,
  formatEmbeddedError,
} from "../subagent-runtime.js";

export interface CuratorProposal {
  topicEpoch: number;
  expectedRevision: number;
  candidates: string[];
  recommendedExperienceRefs: string[];
  reason: string;
}

const CURATOR_PROPOSAL_KEYS = [
  "candidates",
  "expectedRevision",
  "reason",
  "recommendedExperienceRefs",
  "topicEpoch",
] as const;

const CURATION_TOOL_NAMES = [
  "skill_list",
  "skill_search",
  "skill_view",
  "skill_experience",
] as const;

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#xD;");
}

function escapeXmlTextWithinBudget(value: string, budget: number): string {
  const escaped: string[] = [];
  let remaining = Math.max(0, budget);
  for (const codePoint of Array.from(value)) {
    const encoded = escapeXmlText(codePoint);
    const encodedLength = Array.from(encoded).length;
    if (encodedLength > remaining) break;
    escaped.push(encoded);
    remaining -= encodedLength;
  }
  return escaped.join("");
}

function xmlElement(tag: string, value: string): string {
  return `<${tag}>${escapeXmlText(value)}</${tag}>`;
}

function boundedXmlElement(tag: string, value: string, budget: number): string {
  return `<${tag}>${escapeXmlTextWithinBudget(value, budget)}</${tag}>`;
}

function xmlBlock(tag: string, content: string): string {
  return `<${tag}>\n${indentXmlLines(content)}\n</${tag}>`;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function formatConversation(turns: readonly RecentTurn[]): string | undefined {
  const boundedTurns = limitConversationTurns([...turns], "recent");
  if (boundedTurns.length === 0) return;

  const roles = boundedTurns.map((turn) =>
    escapeXmlTextWithinBudget(turn.role, 16),
  );
  const emptyBlocks = roles.map((role) =>
    xmlBlock("turn", [`<role>${role}</role>`, "<text></text>"].join("\n")),
  );
  const emptyConversation = xmlBlock("conversation", emptyBlocks.join("\n"));
  const parentIndentCost = Math.max(
    0,
    (emptyConversation.split("\n").length - 1) * 2,
  );
  let remainingTextBudget = Math.max(
    0,
    2_000 - codePointLength(emptyConversation) - parentIndentCost,
  );
  const renderedTurns = boundedTurns.map((turn, index) => {
    const remainingTurns = boundedTurns.length - index;
    const share = Math.floor(remainingTextBudget / remainingTurns);
    const text = escapeXmlTextWithinBudget(turn.text, share);
    remainingTextBudget -= codePointLength(text);
    return xmlBlock(
      "turn",
      [`<role>${roles[index]}</role>`, `<text>${text}</text>`].join("\n"),
    );
  });
  return xmlBlock("conversation", renderedTurns.join("\n"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractRawPayloadText(result: { payloads?: unknown[] }): string {
  return (result.payloads ?? [])
    .map((payload) =>
      isRecord(payload) && typeof payload.text === "string" ? payload.text : "",
    )
    .join("\n");
}

function parseUniqueStrings(
  value: unknown,
  limit: number,
): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return;
    const trimmed = item.trim();
    const canonical = trimmed.normalize("NFKC").toLowerCase();
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    result.push(trimmed);
  }
  return result;
}

export function parseCuratorProposal(
  raw: string,
  expected: { topicEpoch: number; expectedRevision: number },
): CuratorProposal | undefined {
  if (Array.from(raw).length > 4_000) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  if (
    JSON.stringify(Object.keys(parsed).sort()) !==
    JSON.stringify(CURATOR_PROPOSAL_KEYS)
  ) {
    return;
  }

  const topicEpoch = parsed.topicEpoch;
  const expectedRevision = parsed.expectedRevision;
  if (
    !Number.isInteger(topicEpoch) ||
    topicEpoch !== expected.topicEpoch ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision !== expected.expectedRevision
  ) {
    return;
  }

  const candidates = parseUniqueStrings(parsed.candidates, 6);
  const recommendedExperienceRefs = parseUniqueStrings(
    parsed.recommendedExperienceRefs,
    3,
  );
  if (
    !candidates ||
    !recommendedExperienceRefs ||
    typeof parsed.reason !== "string"
  ) {
    return;
  }
  if (Array.from(parsed.reason).length > 500) return;
  const reason = parsed.reason.trim();
  if (!reason) return;

  return {
    topicEpoch,
    expectedRevision,
    candidates,
    recommendedExperienceRefs,
    reason,
  };
}

export function buildCuratorPrompt(params: {
  curation: SessionCurationRecord;
  conversation: readonly RecentTurn[];
  candidates: readonly AvailableSkill[];
  experienceIdentities: readonly string[];
  experienceCandidates?: readonly Pick<
    SkillExperienceEntry,
    "identity" | "keywords"
  >[];
}): string {
  const conversation = formatConversation(params.conversation);
  const candidates = params.candidates.map((skill) =>
    xmlBlock(
      "skill",
      [
        boundedXmlElement("name", skill.name, 160),
        boundedXmlElement("description", skill.description, 240),
      ].join("\n"),
    ),
  );
  const experienceCandidates = params.experienceCandidates
    ? params.experienceCandidates.slice(0, 24)
    : params.experienceIdentities
        .slice(0, 3)
        .map((identity) => ({ identity, keywords: [] }));
  const experiences = experienceCandidates.map((experience) =>
    xmlBlock(
      "experience_candidate",
      [
        boundedXmlElement("identity", experience.identity, 160),
        boundedXmlElement("keywords", JSON.stringify(experience.keywords), 800),
      ].join("\n"),
    ),
  );

  return [
    `You are a bounded skill curator. Review the conversation and candidate skills. If the provided skill_candidates are not optimal for the ongoing conversation, you are encouraged to search for and inspect more relevant available skills using skill_list, skill_search, and skill_view. Return JSON only with exactly topicEpoch, expectedRevision, candidates, recommendedExperienceRefs, and reason. Return zero to six unique candidate names, zero to three unique experience identities, and a reason of at most 500 Unicode code points. Select recommendedExperienceRefs only from experience candidates and only when they are highly relevant to this sustained topic; selected records will be expanded as possibly relevant reference on the next main-agent turn. Return an empty recommendedExperienceRefs array otherwise. You must echo topicEpoch ${params.curation.topicEpoch} and expectedRevision ${params.curation.revision} exactly. Do not output experience bodies or any other key.`,
    xmlBlock(
      "curation_request",
      [
        xmlBlock(
          "current_curation",
          [
            xmlElement("topic_epoch", String(params.curation.topicEpoch)),
            xmlElement("expected_revision", String(params.curation.revision)),
            boundedXmlElement("intent_id", params.curation.intentId, 240),
          ].join("\n"),
        ),
        ...(conversation ? [conversation] : []),
        ...(candidates.length > 0
          ? [xmlBlock("skill_candidates", candidates.join("\n"))]
          : []),
        ...(experiences.length > 0
          ? [xmlBlock("experience_candidates", experiences.join("\n"))]
          : []),
      ].join("\n"),
    ),
  ].join("\n\n");
}

export function getCurationModelRef(
  api: OpenClawPluginApi,
  agentId: string,
  config: ResolvedSkillHarnessPluginConfig,
  currentRun: { modelProviderId?: string; modelId?: string },
): { provider: string; model: string } | undefined {
  return getModelRef(
    api,
    agentId,
    {
      ...config,
      model: config.curation.model ?? config.model,
      modelFallback: config.curation.modelFallback ?? config.modelFallback,
    },
    currentRun,
  );
}

export interface CurationSubagentParams {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  sessionId?: string;
  sessionKey?: string;
  messageProvider?: string;
  modelProviderId?: string;
  modelId?: string;
  dataRoot: string;
  curation: SessionCurationRecord;
  conversation: readonly RecentTurn[];
  candidates: readonly AvailableSkill[];
  experienceIdentities: readonly string[];
  experienceCandidates?: readonly Pick<
    SkillExperienceEntry,
    "identity" | "keywords"
  >[];
}

export async function runCurationSubagent(
  params: CurationSubagentParams,
): Promise<CuratorProposal | undefined> {
  if (!params.config.curation.enabled) return;
  const modelRef = getCurationModelRef(
    params.api,
    params.agentId,
    params.config,
    params,
  );
  if (!modelRef) return;

  const runId = `skill-harness-curation-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const scope = params.sessionKey ?? params.sessionId ?? crypto.randomUUID();
  const sessionKey = `agent:${params.agentId}:skill-harness-curation:${crypto
    .createHash("sha1")
    .update(scope)
    .digest("hex")
    .slice(0, 12)}`;
  const workspaceDir = agentWorkspacePath(params.dataRoot);
  const prompt = buildCuratorPrompt(params);
  const runParams = {
    sessionId: runId,
    sessionKey,
    agentId: params.agentId,
    messageProvider: params.messageProvider,
    config: params.api.config,
    prompt,
    provider: modelRef.provider,
    model: modelRef.model,
    timeoutMs: params.config.curation.timeoutSeconds * 1_000,
    runId,
    workspaceDir,
    agentDir: workspaceDir,
    sessionFile: `${agentSessionsPath(params.dataRoot, "curation")}/${runId}.session.jsonl`,
    ...buildEmbeddedSubagentRunDefaults(),
    modelRun: false,
    promptMode: "minimal" as const,
    toolsAllow: [...CURATION_TOOL_NAMES],
    disableTools: false,
    thinkLevel: params.config.curation.thinking,
    skillsSnapshot: {
      prompt: "",
      skills: [],
      resolvedSkills: [],
    },
  };

  try {
    const result = await params.api.runtime.agent.runEmbeddedAgent(runParams);
    const embeddedError = extractEmbeddedRunError(result);
    if (embeddedError) {
      logger.warn("Curation subagent returned an error", {
        error: embeddedError,
      });
      return;
    }
    const parsed = parseCuratorProposal(extractRawPayloadText(result), {
      topicEpoch: params.curation.topicEpoch,
      expectedRevision: params.curation.revision,
    });
    if (!parsed) logger.warn("Curation subagent produced invalid JSON");
    return parsed;
  } catch (error) {
    logger.warn("Curation subagent error", {
      error: formatEmbeddedError(error) ?? error,
    });
    return;
  }
}
