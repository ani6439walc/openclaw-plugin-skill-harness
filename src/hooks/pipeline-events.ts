import type { PluginHookAgentContext } from "openclaw/plugin-sdk/types";
import { emitAgentEvent as emitHostAgentEvent } from "openclaw/plugin-sdk/agent-harness";
import { logger } from "../../api.js";

const SKILL_HARNESS_EVENT_STREAM = "plugin:skill-harness";
const SKILL_HARNESS_EVENT_KIND = "skill-harness.pipeline";

export type PipelinePhase =
  "topic-triage" | "intent-classify" | "hint-generate";

export type PipelineState = "started" | "completed" | "failed";

export type PipelineMetadata = {
  basis?: string;
  domain?: string;
  keywords?: string[];
  topic?: string;
  changed?: boolean;
  complexity?: string;
  intent?: string;
  reason?: string;
  confidence?: number;
  result?: string;
  error?: string;
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

  try {
    emitHostAgentEvent({
      runId,
      sessionKey,
      stream: SKILL_HARNESS_EVENT_STREAM,
      data: cleanPipelineEventData({
        kind: SKILL_HARNESS_EVENT_KIND,
        phase,
        state,
        sessionKey,
        ...metadata,
      }),
    });
  } catch (err) {
    logger.warn("failed to emit skill-harness pipeline event", {
      phase,
      state,
      error: err,
    });
  }
}
