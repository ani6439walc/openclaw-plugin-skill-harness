import type {
  RelatedCandidateEvidence,
  RelationEvidence,
} from "../skills/related.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue as VendorJsonValue } from "@typesafe-ai/sdk";
import type { JsonValue } from "openclaw/plugin-sdk/decisions";
import { evaluateSelection } from "./selection-runtime.js";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import { normalizeTypeSafeBaseUrl } from "../qmd/provider-resolver.js";
import type {
  AvailableSkill,
  RecentTurn,
  ResolvedSkillHarnessPluginConfig,
  RoutingLlmResult,
} from "../types.js";
import type { SkillExperienceEntry } from "../experiences/types.js";

import {
  buildSelectionBatch,
  parseSelectionResult,
} from "./selection-batch.js";
export type JevUnifiedRoutingParams = {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  conversation?: RecentTurn[];
  latest: string;
  messageProvider?: string;
  channelId?: string;
  modelRef?: { provider: string; model: string };
  candidateSkills?: readonly AvailableSkill[];
  candidateSources?: Readonly<Record<string, readonly string[]>>;
  visibleSkillNames?: readonly string[];
  relatedEvidence?: readonly RelatedCandidateEvidence[];
  relationEvidence?: readonly RelationEvidence[];
  candidateExperiences?: readonly SkillExperienceEntry[];
  client?: TypeSafeClient;
  dataRoot?: string;
  signal?: AbortSignal;
  assertActive?: () => void;
};

function mutableJson(value: JsonValue): VendorJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(mutableJson);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mutableJson(entry)]),
  );
}

/** One batch for all candidate kinds; provider errors never open a second route. */
export async function runJevUnifiedRouting(
  params: JevUnifiedRoutingParams,
): Promise<RoutingLlmResult | undefined> {
  const signal = AbortSignal.any([
    ...(params.signal ? [params.signal] : []),
    ...(params.api.lifecycle?.signal ? [params.api.lifecycle.signal] : []),
  ]);
  try {
    signal.throwIfAborted();
    params.assertActive?.();
    const batch = buildSelectionBatch(params);
    if (Object.keys(batch.questions).length === 0) {
      return parseSelectionResult(params, params.config, { answers: {} });
    }
    const timeoutMs = params.config.routing.timeoutMs;
    const response = await evaluateSelection({
      api: params.api,
      agentId: params.agentId,
      batch,
      signal,
      timeoutMs,
      assertActive: params.assertActive,
      legacy: async () => {
        const endpointConfig = params.config.decisionModel;
        if (!endpointConfig?.model) {
          logger.warn(
            "selection unavailable route=legacy reason=not-configured",
          );
          return undefined;
        }
        signal.throwIfAborted();
        // resolveConfig already resolved the provider prefix and credentials.
        const endpoint = endpointConfig;
        signal.throwIfAborted();
        params.assertActive?.();
        const client =
          params.client ??
          new TypeSafeClient({
            apiKey: endpoint.apiKey,
            baseURL: normalizeTypeSafeBaseUrl(endpoint.baseUrl) || undefined,
            defaultModel: endpoint.model,
            timeout: timeoutMs,
            retry: { maxRetries: 0 },
            compression: false,
            logLevel: "off",
          });
        const questions = Object.fromEntries(
          Object.entries(batch.questions).map(([key, question]) => [
            key,
            { ...question, type: "noul" as const },
          ]),
        );
        const response: unknown = await client.systemOne(
          {
            state: Object.fromEntries(
              Object.entries(batch.state).map(([key, value]) => [
                key,
                mutableJson(value),
              ]),
            ),
            model: endpoint.model,
            questions,
          },
          { signal, timeout: timeoutMs, retry: { maxRetries: 0 } },
        );
        if (
          !response ||
          typeof response !== "object" ||
          !("answers" in response) ||
          !response.answers ||
          typeof response.answers !== "object" ||
          Array.isArray(response.answers)
        )
          return undefined;
        const answers: Record<
          string,
          { type: "boolean"; probabilityTrue: unknown }
        > = Object.create(null);
        for (const [key, answer] of Object.entries(response.answers)) {
          if (
            !answer ||
            typeof answer !== "object" ||
            !("type" in answer) ||
            answer.type !== "noul" ||
            !("noul" in answer)
          )
            return undefined;
          answers[key] = { type: "boolean", probabilityTrue: answer.noul };
        }
        return { answers };
      },
    });
    signal.throwIfAborted();
    params.assertActive?.();
    const result = parseSelectionResult(params, params.config, response);
    if (response && !result)
      logger.warn("selection unavailable reason=invalid-response");
    return result;
  } catch {
    signal.throwIfAborted();
    logger.warn("selection unavailable reason=operation-failed");
    return undefined;
  }
}
