import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChoiceCriteria, EntryType } from "@typesafe-ai/sdk";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import { canonicalIdentity } from "../normalize.js";
import {
  normalizeTypeSafeBaseUrl,
  resolveQmdEndpoint,
} from "../qmd/provider-resolver.js";
import type {
  AvailableSkill,
  IntentCatalogEntry,
  RecentTurn,
  ResolvedSkillHarnessPluginConfig,
  RoutingLlmResult,
} from "../types.js";

export type JevUnifiedRoutingParams = {
  api: OpenClawPluginApi;
  config: ResolvedSkillHarnessPluginConfig;
  agentId: string;
  conversation?: RecentTurn[];
  latest: string;
  modelRef: { provider: string; model: string };
  resolvedIntent?: { id: string; guidance: string };
  candidateIntents?: readonly IntentCatalogEntry[];
  candidateSkills?: readonly AvailableSkill[];
  client?: TypeSafeClient;
};

export async function runJevUnifiedRouting(
  params: JevUnifiedRoutingParams,
): Promise<RoutingLlmResult | undefined> {
  try {
    const rawRef = `${params.modelRef.provider}/${params.modelRef.model}`;
    const endpoint = resolveQmdEndpoint(
      { model: rawRef },
      { openClawConfig: params.api.config },
    );

    const baseURL = normalizeTypeSafeBaseUrl(endpoint.baseUrl);
    const apiKey = endpoint.apiKey;
    const timeoutMs =
      params.config.routing.timeoutMs ?? params.config.qmd.timeoutMs;
    const model = endpoint.model || params.modelRef.model;

    const client =
      params.client ??
      new TypeSafeClient({
        apiKey,
        baseURL: baseURL || undefined,
        defaultModel: model,
        timeout: timeoutMs,
      });

    const state: Record<string, unknown> = {
      latest_message: params.latest,
    };

    if (params.conversation && params.conversation.length > 0) {
      state.conversation_context = params.conversation.map((turn) => ({
        role: turn.role,
        text: turn.text,
        ...(turn.historicalIntent
          ? { intent: turn.historicalIntent.intent }
          : {}),
      }));
    }

    if (params.resolvedIntent) {
      state.resolved_intent = {
        id: params.resolvedIntent.id,
        guidance: params.resolvedIntent.guidance,
      };
    }

    const questions: Record<
      string,
      ReturnType<typeof choice | typeof noul>
    > = {};

    // Branch A: Intent already resolved
    if (params.resolvedIntent) {
      if (params.candidateSkills && params.candidateSkills.length > 0) {
        for (const skill of params.candidateSkills) {
          questions[`skill_${skill.name}`] = noul(
            `Should the agent load skill '${skill.name}' (${skill.description}) to help fulfill the user request under intent '${params.resolvedIntent.id}'?`,
            {
              true: `Skill '${skill.name}' is directly relevant and helpful.`,
              false: `Skill '${skill.name}' is not needed or irrelevant.`,
            },
          );
        }
      } else {
        return {
          intent: params.resolvedIntent.id,
          skills: [],
          confidence: 1.0,
          reason: `Jev direct route: ${params.resolvedIntent.id}`,
        };
      }
    } else {
      // Branch B: Intent not yet resolved
      if (params.candidateIntents && params.candidateIntents.length > 0) {
        const criteria: ChoiceCriteria = {};
        for (const intent of params.candidateIntents) {
          criteria[intent.id] = {
            guidance: intent.definition.guidance || intent.id,
            ...(intent.definition.triggers &&
            intent.definition.triggers.length > 0
              ? { triggers: intent.definition.triggers }
              : {}),
            ...(intent.definition.examples &&
            intent.definition.examples.length > 0
              ? { examples: intent.definition.examples }
              : {}),
          };
        }
        criteria["none"] = {
          guidance:
            "None of the candidate intents adequately match the user request.",
        };
        questions["intent"] = choice(
          "Select the single intent from the catalog that best explains what the user wants to accomplish in latest_message, or select 'none' if no candidate intent fits.",
          criteria,
        );
      }

      if (params.candidateSkills && params.candidateSkills.length > 0) {
        for (const skill of params.candidateSkills) {
          questions[`skill_${skill.name}`] = noul(
            `Should the agent load skill '${skill.name}' (${skill.description}) to help fulfill the user request?`,
            {
              true: `Skill '${skill.name}' is directly relevant and helpful.`,
              false: `Skill '${skill.name}' is not needed or irrelevant.`,
            },
          );
        }
      }
    }

    if (Object.keys(questions).length === 0) {
      return {
        intent: params.resolvedIntent?.id,
        skills: [],
        confidence: params.resolvedIntent ? 1.0 : 0.0,
        reason: "Jev: no candidate questions to evaluate",
      };
    }

    // Execute System One decisions
    const response = await client.systemOne({
      state: state as EntryType,
      model,
      questions,
    });

    if (
      !response ||
      typeof response !== "object" ||
      !response.answers ||
      typeof response.answers !== "object"
    ) {
      logger.warn("Jev unified routing returned invalid response structure", {
        response,
      });
      return undefined;
    }

    const answers = response.answers as Record<string, unknown>;

    let selectedIntent: string | undefined = params.resolvedIntent?.id;
    let confidence = params.resolvedIntent ? 1.0 : 1.0;

    // Validate Intent answer if candidate intents were queried
    if (
      !params.resolvedIntent &&
      params.candidateIntents &&
      params.candidateIntents.length > 0
    ) {
      const intentAns = answers.intent as
        { type?: unknown; choice?: unknown; confidence?: unknown } | undefined;

      if (
        !intentAns ||
        typeof intentAns !== "object" ||
        intentAns.type !== "choice"
      ) {
        logger.warn("Jev unified routing missing or malformed intent answer", {
          intentAns,
        });
        return undefined;
      }

      if (
        typeof intentAns.confidence !== "number" ||
        !Number.isFinite(intentAns.confidence) ||
        intentAns.confidence < 0 ||
        intentAns.confidence > 1
      ) {
        logger.warn("Jev unified routing invalid intent confidence", {
          confidence: intentAns.confidence,
        });
        return undefined;
      }

      confidence = intentAns.confidence;

      if (intentAns.choice === "none" || intentAns.choice === null) {
        selectedIntent = undefined;
      } else if (typeof intentAns.choice === "string") {
        const choiceCanonical = canonicalIdentity(intentAns.choice);
        const matchedIntent = params.candidateIntents.find(
          (c) => canonicalIdentity(c.id) === choiceCanonical,
        );
        if (!matchedIntent) {
          logger.warn(
            "Jev unified routing returned non-candidate intent choice",
            {
              choice: intentAns.choice,
            },
          );
          return undefined;
        }
        selectedIntent = matchedIntent.id;
      } else {
        logger.warn("Jev unified routing returned invalid intent choice type", {
          choice: intentAns.choice,
        });
        return undefined;
      }
    }

    // Validate and collect Skill answers
    const candidateSkillNames = (params.candidateSkills ?? []).map(
      (s) => s.name,
    );
    const skillProbabilities: Array<{ name: string; prob: number }> = [];

    for (const skillName of candidateSkillNames) {
      const qKey = `skill_${skillName}`;
      const ans = answers[qKey] as
        { type?: unknown; noul?: unknown } | undefined;

      if (
        !ans ||
        typeof ans !== "object" ||
        ans.type !== "noul" ||
        typeof ans.noul !== "number" ||
        !Number.isFinite(ans.noul) ||
        ans.noul < 0 ||
        ans.noul > 1
      ) {
        logger.warn("Jev unified routing invalid or missing skill answer", {
          skillName,
          ans,
        });
        return undefined;
      }

      skillProbabilities.push({ name: skillName, prob: ans.noul });
    }

    // Filter prob >= 0.5, sort descending, slice to maxInjectedSkills
    const maxSkills = params.config.routing.skills.maxInjectedSkills;
    const selectedSkills = skillProbabilities
      .filter((sp) => sp.prob >= 0.5)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, maxSkills)
      .map((sp) => sp.name);

    const intentTag = selectedIntent ?? "none";
    const skillListStr =
      selectedSkills.length > 0 ? selectedSkills.join(", ") : "none";
    const reason = `Jev decision (intent: ${intentTag}, confidence: ${confidence.toFixed(2)}, skills: [${skillListStr}])`;

    return {
      intent: selectedIntent,
      skills: selectedSkills,
      confidence,
      reason,
    };
  } catch (err) {
    logger.warn("Jev unified routing error", { error: err });
    return undefined;
  }
}
