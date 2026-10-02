import { emitAgentEvent as emitHostAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { logger } from "../../api.js";
import { roundToDecimals } from "../normalize.js";
import type { PluginHookAgentContext } from "./types.js";

const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";

export type PipelinePhase =
  "pipeline" | "name-match" | "search" | "experience-search" | "rerank";

export type PipelineState = "started" | "completed" | "failed";

export type SkillCandidatePoolFallbackReason =
  | "name-channel-unavailable"
  | "retrieval-timeout"
  | "retrieval-unavailable"
  | "empty-pool";

export type PipelineMetadata = {
  basis?: string;
  keywords?: string[];
  changed?: boolean;
  reason?: string | string[];
  confidence?: number;
  result?: string | string[];
  error?: string;
  durationMs?: number;
  nameCandidates?: number;
  retrievalCandidates?: number;
  experienceCandidates?: number;
  candidateCount?: number;
  injectedCount?: number;
  selectedSkills?: string[];
  selectedExperiences?: string[];
  injectedSkills?: string[];
  injectedExperiences?: string[];
  fallbackReason?: SkillCandidatePoolFallbackReason;
  collectionHits?: Partial<Record<"meta" | "body" | "references", number>>;
  injectedCollections?: Partial<Record<"meta" | "body" | "references", number>>;
  explain?: string;
  status?:
    "completed" | "disabled" | "unavailable" | "timeout" | "error" | "skipped";
  minCandidateScore?: number;
  matches?: { name: string; score: number }[];
  hits?: { id: string; semanticScore: number | null }[];
};

function cleanPipelineEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) =>
        value !== undefined &&
        !(
          key === "reason" &&
          ((typeof value === "string" && value.trim() === "") ||
            (Array.isArray(value) && value.length === 0))
        ),
    ),
  );
}

export function emitPipelineEvent(
  ctx: Pick<PluginHookAgentContext, "runId" | "sessionId" | "hookInvocation">,
  sessionKey: string | undefined,
  phase: PipelinePhase,
  state: PipelineState,
  metadata: PipelineMetadata = {},
): void {
  try {
    ctx.hookInvocation?.assertActive();
  } catch {
    return;
  }
  const runId =
    ctx.runId?.trim() || sessionKey?.trim() || ctx.sessionId?.trim();
  if (!runId) {
    return;
  }

  const confidence =
    typeof metadata.confidence === "number" &&
    !Number.isNaN(metadata.confidence)
      ? roundToDecimals(metadata.confidence, 2)
      : undefined;

  try {
    const rawData: Record<string, unknown> = {
      kind: SKILL_HARNESS_EVENT_KIND,
      phase,
      state,
      sessionKey,
      ...metadata,
    };
    if (confidence !== undefined) {
      rawData.confidence = confidence;
    } else if ("confidence" in metadata) {
      delete rawData.confidence;
    }

    emitHostAgentEvent({
      runId,
      sessionKey,
      stream: SKILL_HARNESS_EVENT_STREAM,
      data: cleanPipelineEventData(rawData),
    });
  } catch (err) {
    logger.warn("failed to emit skill-harness pipeline event", {
      phase,
      state,
      error: err,
    });
  }
}
