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
import type { SkillExperienceEntry } from "../experiences/types.js";

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
  candidateExperiences?: readonly SkillExperienceEntry[];
  client?: TypeSafeClient;
};

export async function runJevUnifiedRouting(
  params: JevUnifiedRoutingParams,
): Promise<RoutingLlmResult | undefined> {
  try {
    const pluginJev = params.config.jev ?? params.config.qmd.jev;
    const rawRef =
      pluginJev?.model ||
      `${params.modelRef.provider}/${params.modelRef.model}`;
    const endpoint = resolveQmdEndpoint(
      {
        model: rawRef,
        baseUrl: pluginJev?.baseUrl,
        apiKey: pluginJev?.apiKey,
      },
      { openClawConfig: params.api.config },
    );

    const baseURL = normalizeTypeSafeBaseUrl(
      pluginJev?.baseUrl || endpoint.baseUrl,
    );
    const apiKey = pluginJev?.apiKey || endpoint.apiKey;
    const timeoutMs =
      params.config.routing.timeoutMs ?? params.config.qmd.timeoutMs;
    const model = endpoint.model || rawRef;

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
      }
      if (
        params.candidateExperiences &&
        params.candidateExperiences.length > 0
      ) {
        for (const exp of params.candidateExperiences) {
          questions[`exp_${exp.id}`] = noul(
            `Is this past experience '${exp.id}' (${exp.summary}) relevant and helpful for answering or guiding the user request under intent '${params.resolvedIntent.id}'?`,
            {
              true: `Experience '${exp.id}' is directly relevant and provides helpful guidance or procedures.`,
              false: `Experience '${exp.id}' is not needed, irrelevant, or not applicable.`,
            },
          );
        }
      }
      if (
        (!params.candidateSkills || params.candidateSkills.length === 0) &&
        (!params.candidateExperiences ||
          params.candidateExperiences.length === 0)
      ) {
        return {
          intent: params.resolvedIntent.id,
          skills: [],
          experiences: [],
          confidence: 1.0,
          reason: `jev → direct route: ${params.resolvedIntent.id}`,
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

      if (
        params.candidateExperiences &&
        params.candidateExperiences.length > 0
      ) {
        for (const exp of params.candidateExperiences) {
          questions[`exp_${exp.id}`] = noul(
            `Is this past experience '${exp.id}' (${exp.summary}) relevant and helpful for answering or guiding the user request?`,
            {
              true: `Experience '${exp.id}' is directly relevant and provides helpful guidance or procedures.`,
              false: `Experience '${exp.id}' is not needed, irrelevant, or not applicable.`,
            },
          );
        }
      }
    }

    if (Object.keys(questions).length === 0) {
      return {
        intent: params.resolvedIntent?.id,
        skills: [],
        experiences: [],
        confidence: params.resolvedIntent ? 1.0 : 0.0,
        reason: "jev → no candidate questions to evaluate",
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
    let confidence = 1.0;

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

    // Validate and collect Experience answers
    const candidateExperiences = params.candidateExperiences ?? [];
    const experienceProbabilities: Array<{
      entry: SkillExperienceEntry;
      prob: number;
    }> = [];

    for (const exp of candidateExperiences) {
      const qKey = `exp_${exp.id}`;
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
        logger.warn(
          "Jev unified routing invalid or missing experience answer",
          {
            experienceId: exp.id,
            ans,
          },
        );
        return undefined;
      }

      experienceProbabilities.push({ entry: exp, prob: ans.noul });
    }

    // Filter prob >= relevanceThreshold, sort descending, slice to maxInjectedExperiences
    const expThreshold =
      params.config.routing.experiences?.relevanceThreshold ?? 0.6;
    const maxExperiences =
      params.config.routing.experiences?.maxInjectedExperiences ?? 4;
    const qualifyingExperiences = experienceProbabilities
      .filter((ep) => ep.prob >= expThreshold)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, maxExperiences);
    const selectedExperiences = qualifyingExperiences.map((ep) => ep.entry.id);

    // Filter prob >= relevanceThreshold, sort descending, slice to maxInjectedSkills
    const skillThreshold =
      params.config.routing.skills.relevanceThreshold ?? 0.6;
    const maxSkills = params.config.routing.skills.maxInjectedSkills ?? 8;
    const directQualifyingSkills = skillProbabilities
      .filter((sp) => sp.prob >= skillThreshold)
      .sort((a, b) => b.prob - a.prob)
      .map((sp) => sp.name);

    // Union of direct qualifying skills and associated skills from qualifying experiences
    const unionSkillsSet = new Set<string>(directQualifyingSkills);
    for (const exp of qualifyingExperiences) {
      for (const skillName of exp.entry.skills) {
        unionSkillsSet.add(skillName);
      }
    }
    const selectedSkills = [...unionSkillsSet].slice(0, maxSkills);

    const skillListStr = selectedSkills.join(", ");
    const skillCount = `${selectedSkills.length} ${selectedSkills.length === 1 ? "skill" : "skills"}`;
    const expListStr = selectedExperiences.join(", ");
    const expCount = `${selectedExperiences.length} ${selectedExperiences.length === 1 ? "exp" : "exps"}`;
    const reason = `jev → ${skillCount}: [${skillListStr}]${selectedExperiences.length > 0 ? `, ${expCount}: [${expListStr}]` : ""}`;

    return {
      intent: selectedIntent,
      skills: selectedSkills,
      experiences: selectedExperiences,
      confidence,
      reason,
    };
  } catch (err) {
    logger.warn("Jev unified routing error", { error: err });
    return undefined;
  }
}
