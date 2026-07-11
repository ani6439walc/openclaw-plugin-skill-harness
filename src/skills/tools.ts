import { Type } from "typebox";
import type { OpenClawPluginApi } from "../../api.js";
import { listAvailableSkills } from "./indexer.js";
import { readAvailableSkill } from "./files.js";
import { manageSkill } from "./manage.js";
import { relatedSkillsBySkillName } from "./related.js";
import { searchAvailableSkills } from "./search.js";
import type { SkillSource } from "./types.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";
import type { IntentCatalogEntry } from "../types.js";

const DEFAULT_SKILL_LIST_LIMIT = 150;
const MAX_SKILL_LIST_LIMIT = 500;

export interface RegisterSkillToolsOptions {
  getIntents?: (agentId: string) => readonly IntentCatalogEntry[];
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    details: undefined,
  };
}

function optionalStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") return;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function optionalStringArrayParam(
  params: unknown,
  key: string,
): string[] | undefined {
  if (!params || typeof params !== "object") return;
  const value = (params as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return;
  return value.filter((item): item is string => typeof item === "string");
}

function requiredStringParam(params: unknown, key: string): string {
  return optionalStringParam(params, key) ?? "";
}

function booleanParam(params: unknown, key: string): boolean {
  if (!params || typeof params !== "object") return false;
  return (params as Record<string, unknown>)[key] === true;
}

function optionalBooleanParam(
  params: unknown,
  key: string,
): boolean | undefined {
  if (!params || typeof params !== "object") return;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalIntegerParam(
  params: unknown,
  key: string,
): number | undefined {
  if (!params || typeof params !== "object") return;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  return Math.trunc(value);
}

function paginationParams(params: unknown): { offset: number; limit: number } {
  const offset = Math.max(0, optionalIntegerParam(params, "offset") ?? 0);
  const requestedLimit =
    optionalIntegerParam(params, "limit") ?? DEFAULT_SKILL_LIST_LIMIT;
  const limit = Math.min(MAX_SKILL_LIST_LIMIT, Math.max(1, requestedLimit));
  return { offset, limit };
}

function defaultAgentId(): string {
  return "main";
}

function toolAgentId(context: { agentId?: string }): string | undefined {
  return context.agentId?.trim() || undefined;
}

export function registerSkillTools(
  api: OpenClawPluginApi,
  options: RegisterSkillToolsOptions = {},
): void {
  api.registerTool(
    (toolContext) => {
      const agentId = toolAgentId(toolContext);
      if (!agentId) return null;
      return {
        name: "skill_list",
        label: "List Skills",
        description:
          "List OpenClaw skills visible to the current agent. Set show_related to include direct optional relations: current-to-related is declared by the returned skill, while related-to-current is declared by another visible skill. Use skill_view to read full SKILL.md content or linked support files.",
        parameters: Type.Object({
          source: Type.Optional(
            Type.Union([
              Type.Literal("workspace"),
              Type.Literal("project-agent"),
              Type.Literal("personal-agent"),
              Type.Literal("managed"),
              Type.Literal("bundled"),
              Type.Literal("extra"),
              Type.Literal("plugin"),
            ]),
          ),
          offset: Type.Optional(
            Type.Number({
              description:
                "Zero-based result offset for pagination. Defaults to 0.",
            }),
          ),
          limit: Type.Optional(
            Type.Number({
              description:
                "Maximum number of skills to return. Defaults to 150 and is capped at 500.",
            }),
          ),
          show_stats: Type.Optional(
            Type.Boolean({
              description:
                "When true, include per-skill usage statistics from stats.json in each returned skill.",
            }),
          ),
          show_related: Type.Optional(
            Type.Boolean({
              description:
                "When true, include direct related skills in each returned skill.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { offset, limit } = paginationParams(params);
          const showStats = booleanParam(params, "show_stats");
          const showRelated = booleanParam(params, "show_related");
          const skills = await listAvailableSkills({
            api,
            agentId,
            intents: options.getIntents?.(agentId),
            source: optionalStringParam(params, "source") as
              SkillSource | undefined,
          });
          const relatedSkills = showRelated
            ? relatedSkillsBySkillName(skills)
            : undefined;
          const page = skills.slice(offset, offset + limit);
          const nextOffset = offset + page.length;
          const hasMore = nextOffset < skills.length;
          const usageStats = showStats
            ? await readSkillUsageStats({ api, agentId })
            : undefined;
          return jsonToolResult({
            success: true,
            total: skills.length,
            count: page.length,
            offset,
            limit,
            has_more: hasMore,
            ...(hasMore ? { next_offset: nextOffset } : {}),
            skills: page.map((skill) => ({
              name: skill.name,
              description: skill.description,
              source: skill.source,
              domains: skill.domains ?? [],
              path: skill.location,
              ...(relatedSkills
                ? {
                    related_skills:
                      relatedSkills.get(skill.name.toLowerCase()) ?? [],
                  }
                : {}),
              ...(usageStats
                ? {
                    usage_stats: skillUsageStatsForName(usageStats, skill.name),
                  }
                : {}),
            })),
          });
        },
      };
    },
    { name: "skill_list" },
  );

  api.registerTool(
    (toolContext) => {
      const agentId = toolAgentId(toolContext);
      if (!agentId) return null;
      return {
        name: "skill_search",
        label: "Search Skills",
        description:
          "Search OpenClaw skills visible to the current agent using deterministic lexical ranking across skill metadata, derived domains, intent references, and related skill names. Results are discovery candidates; use skill_view before following a skill workflow.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({ description: "Natural-language search phrase." }),
          ),
          source: Type.Optional(
            Type.Union([
              Type.Literal("workspace"),
              Type.Literal("project-agent"),
              Type.Literal("personal-agent"),
              Type.Literal("managed"),
              Type.Literal("bundled"),
              Type.Literal("extra"),
              Type.Literal("plugin"),
            ]),
          ),
          domains: Type.Optional(
            Type.Array(Type.String(), {
              description: "Case-insensitive domain filters with OR semantics.",
            }),
          ),
          keywords: Type.Optional(
            Type.Array(Type.String(), {
              description: "Additional lexical search tokens.",
            }),
          ),
          offset: Type.Optional(
            Type.Number({
              description:
                "Zero-based result offset for pagination. Defaults to 0.",
            }),
          ),
          limit: Type.Optional(
            Type.Number({
              description:
                "Maximum number of results. Defaults to 20 and is capped at 100.",
            }),
          ),
          show_stats: Type.Optional(
            Type.Boolean({
              description: "When true, include per-skill usage statistics.",
            }),
          ),
          show_related: Type.Optional(
            Type.Boolean({
              description: "When true, include visible related skills.",
            }),
          ),
          show_matches: Type.Optional(
            Type.Boolean({
              description:
                "When false, omit matched_fields and matched_intents. Defaults to true.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          return jsonToolResult(
            await searchAvailableSkills({
              api,
              agentId,
              intents: options.getIntents?.(agentId),
              query: optionalStringParam(params, "query"),
              source: optionalStringParam(params, "source") as
                SkillSource | undefined,
              domains: optionalStringArrayParam(params, "domains"),
              keywords: optionalStringArrayParam(params, "keywords"),
              offset: optionalIntegerParam(params, "offset"),
              limit: optionalIntegerParam(params, "limit"),
              showStats: booleanParam(params, "show_stats"),
              showRelated: booleanParam(params, "show_related"),
              showMatches: optionalBooleanParam(params, "show_matches") ?? true,
            }),
          );
        },
      };
    },
    { name: "skill_search" },
  );

  api.registerTool(
    (toolContext) => {
      const agentId = toolAgentId(toolContext);
      if (!agentId) return null;
      return {
        name: "skill_view",
        label: "View Skill",
        description:
          "Read a visible OpenClaw skill's SKILL.md content, or read one of its linked support files under references, templates, scripts, assets, or examples.",
        parameters: Type.Object({
          name: Type.String({ description: "Skill name to read." }),
          file_path: Type.Optional(
            Type.String({
              description:
                "Optional support file path under references/, templates/, scripts/, assets/, or examples/.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          return jsonToolResult(
            await readAvailableSkill({
              api,
              agentId,
              name: requiredStringParam(params, "name"),
              filePath: optionalStringParam(params, "file_path"),
              intents: options.getIntents?.(agentId),
            }),
          );
        },
      };
    },
    { name: "skill_view" },
  );

  api.registerTool({
    name: "skill_manage",
    label: "Manage Skills",
    description:
      "Create, edit, patch, delete, and manage support files for OpenClaw skills. This is a required write-capable tool; validate names and paths before mutating skill files.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("patch"),
        Type.Literal("edit"),
        Type.Literal("delete"),
        Type.Literal("write_file"),
        Type.Literal("remove_file"),
      ]),
      name: Type.String({
        description:
          "Skill name. Use lowercase letters, numbers, dots, underscores, and hyphens; max 64 characters.",
      }),
      content: Type.Optional(
        Type.String({
          description:
            "Full SKILL.md content with YAML frontmatter. Required for create/edit.",
        }),
      ),
      old_string: Type.Optional(
        Type.String({
          description:
            "Text to find for patch. Must be unique unless replace_all is true.",
        }),
      ),
      new_string: Type.Optional(
        Type.String({
          description:
            "Replacement text for patch. Can be an empty string to delete matched text.",
        }),
      ),
      replace_all: Type.Optional(
        Type.Boolean({
          description:
            "For patch: replace every occurrence instead of one unique match.",
        }),
      ),
      file_path: Type.Optional(
        Type.String({
          description:
            "Support file path for patch/write_file/remove_file. Must be under references/, templates/, scripts/, assets/, or examples/.",
        }),
      ),
      file_content: Type.Optional(
        Type.String({ description: "Content for write_file." }),
      ),
      absorbed_into: Type.Optional(
        Type.String({
          description:
            "For delete: umbrella skill name when merged, or empty string when deleting with no forwarding target.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      return jsonToolResult(
        await manageSkill({
          api,
          agentId: defaultAgentId(),
          action: requiredStringParam(params, "action"),
          name: requiredStringParam(params, "name"),
          content: optionalStringParam(params, "content"),
          oldString: optionalStringParam(params, "old_string"),
          newString: optionalStringParam(params, "new_string"),
          replaceAll: booleanParam(params, "replace_all"),
          filePath: optionalStringParam(params, "file_path"),
          fileContent: optionalStringParam(params, "file_content"),
          absorbedInto: optionalStringParam(params, "absorbed_into"),
        }),
      );
    },
  });
}
