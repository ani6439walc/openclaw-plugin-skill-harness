import { emitAgentEvent as emitHostAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { logger } from "../../api.js";
import { roundToDecimals } from "../normalize.js";
import type { IntentTrigger } from "../types.js";
import type { PluginHookAgentContext } from "./types.js";

const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";

export type PipelinePhase = "pipeline" | IntentTrigger;

export type PipelineState = "started" | "completed" | "failed";

export type PipelineMetadata = {
  basis?: string;
  domain?: string;
  keywords?: string[];
  changed?: boolean;
  intent?: string;
  reason?: string;
  confidence?: number;
  result?: string;
  error?: string;
  durationMs?: number;
};

function cleanPipelineEventData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

export function emitPipelineEvent(
  ctx: Pick<PluginHookAgentContext, "runId" | "sessionId">,
  sessionKey: string | undefined,
  phase: PipelinePhase,
  state: PipelineState,
  metadata: PipelineMetadata = {},
): void {
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
