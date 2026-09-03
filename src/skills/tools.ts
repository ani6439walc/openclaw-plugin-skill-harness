import { Type } from "typebox";
import type { OpenClawPluginApi } from "../../api.js";
import { listAvailableSkills } from "./indexer.js";
import { readAvailableSkill } from "./files.js";
import { manageSkill } from "./manage.js";
import { relatedSkillsBySkillName } from "./related.js";
import {
  skillSourcePriority,
  SKILL_SOURCE_ORDER,
  type SkillSource,
} from "./types.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";
import type { IntentCatalogEntry } from "../types.js";
import type { SkillExperienceCatalog } from "../experiences/index.js";
import { canonicalIdentity } from "../normalize.js";

const DEFAULT_SKILL_LIST_LIMIT = 150;
const MAX_SKILL_LIST_LIMIT = 500;
const DEFAULT_SKILL_SEARCH_LIMIT = 20;
const MAX_SKILL_SEARCH_LIMIT = 100;
const MAX_SKILL_SEARCH_QUERY_CODE_POINTS = 1_000;
const MAX_EXPERIENCE_SKILLS = 6;
const MAX_EXPERIENCE_QUERY_CODE_POINTS = 500;
const MAX_EXPERIENCE_ENTRIES = 3;
const MAX_EXPERIENCE_BODY_CODE_POINTS = 2_000;
const MAX_EXPERIENCE_TOTAL_CODE_POINTS = 5_000;
const SKILL_SOURCE_SCHEMA = Type.Union(
  SKILL_SOURCE_ORDER.map((source) => Type.Literal(source)),
);

export interface RegisterSkillToolsOptions {
  getIntents?: (agentId: string) => readonly IntentCatalogEntry[];
  experienceCatalog?: SkillExperienceCatalog;
  qmdSkillIndex?: SkillQmdIndex;
  scheduleSkillSearchIndex?: (agentId: string) => void;
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

function requiredStringParam(params: unknown, key: string): string {
  return optionalStringParam(params, key) ?? "";
}

function booleanParam(params: unknown, key: string): boolean {
  if (!params || typeof params !== "object") return false;
  return (params as Record<string, unknown>)[key] === true;
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

function canonicalSkillNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of values) {
    const name = canonicalIdentity(value);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join("");
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
          "List OpenClaw skills visible to the current agent. Use only when the task is broad, terminology is uncertain, or focused search is insufficient. Set show_related to include direct optional relations: current-to-related is declared by the returned skill, while related-to-current is declared by another visible skill. Use skill_view to read full SKILL.md content or linked support files.",
        parameters: Type.Object({
          source: Type.Optional(SKILL_SOURCE_SCHEMA),
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
          "Search OpenClaw skills visible to the current agent with QMD hybrid retrieval over skill metadata, SKILL.md bodies, and references. Use focused search when injected candidates do not match the current task. Results are discovery candidates; use skill_view before following a skill workflow.",
        parameters: Type.Object({
          query: Type.String({
            description: "Natural-language search phrase.",
          }),
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
          show_evidence: Type.Optional(
            Type.Boolean({
              description:
                "When true, include top matching chunk evidence for each skill.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const query = truncateCodePoints(
            optionalStringParam(params, "query")?.trim() ?? "",
            MAX_SKILL_SEARCH_QUERY_CODE_POINTS,
          );
          if (!query) {
            return jsonToolResult({
              success: false,
              error: "query is required",
            });
          }

          const requestedLimit =
            optionalIntegerParam(params, "limit") ?? DEFAULT_SKILL_SEARCH_LIMIT;
          const limit = Math.min(
            MAX_SKILL_SEARCH_LIMIT,
            Math.max(1, requestedLimit),
          );
          const showStats = booleanParam(params, "show_stats");
          const showEvidence = booleanParam(params, "show_evidence");

          const index = options.qmdSkillIndex;
          if (!index) {
            return jsonToolResult({
              success: false,
              error: "skill search index is not ready",
            });
          }

          if (index.getStatus(agentId) === "idle") {
            options.scheduleSkillSearchIndex?.(agentId);
          }

          const inventory = await listAvailableSkills({
            api,
            agentId,
            intents: options.getIntents?.(agentId),
          });
          const hits = await index.search({
            agentId,
            query,
            limit,
            includeEvidence: showEvidence,
          });
          if (!hits) {
            return jsonToolResult({
              success: false,
              error: "skill search index is not ready",
            });
          }

          const inventoryByName = new Map(
            inventory.map((skill) => [skill.name.toLowerCase(), skill]),
          );
          const usageStats = showStats
            ? await readSkillUsageStats({ api, agentId })
            : undefined;

          const skills = hits
            .map((hit) => {
              const skill = inventoryByName.get(hit.name.toLowerCase());
              if (!skill) return;
              return {
                name: skill.name,
                description: skill.description,
                source: skill.source,
                domains: skill.domains ?? [],
                score: hit.score,
                ...(usageStats
                  ? {
                      usage_stats: skillUsageStatsForName(
                        usageStats,
                        skill.name,
                      ),
                    }
                  : {}),
                ...(showEvidence && hit.evidence
                  ? { evidence: hit.evidence }
                  : {}),
              };
            })
            .filter(
              (skill): skill is NonNullable<typeof skill> =>
                skill !== undefined,
            )
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              const sourceComparison =
                skillSourcePriority(left.source) -
                skillSourcePriority(right.source);
              if (sourceComparison !== 0) return sourceComparison;
              if (usageStats) {
                const usageComparison =
                  skillUsageStatsForName(usageStats, right.name).usage_turns -
                  skillUsageStatsForName(usageStats, left.name).usage_turns;
                if (usageComparison !== 0) return usageComparison;
              }
              return left.name.localeCompare(right.name);
            });

          return jsonToolResult({
            success: true,
            query,
            total: skills.length,
            count: skills.length,
            limit,
            skills,
          });
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
          "Read a visible OpenClaw skill's SKILL.md content, or read one of its linked support files under references, templates, scripts, assets, or examples. Read the complete skill before following its workflow.",
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
      "Create, edit, patch, delete, and manage support files for OpenClaw skills. Use only when available and authorized. This is a write-capable tool; validate names and paths before mutating skill files and prefer focused patches.",
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
      const agentId = defaultAgentId();
      const result = await manageSkill({
        api,
        agentId,
        action: requiredStringParam(params, "action"),
        name: requiredStringParam(params, "name"),
        content: optionalStringParam(params, "content"),
        oldString: optionalStringParam(params, "old_string"),
        newString: optionalStringParam(params, "new_string"),
        replaceAll: booleanParam(params, "replace_all"),
        filePath: optionalStringParam(params, "file_path"),
        fileContent: optionalStringParam(params, "file_content"),
        absorbedInto: optionalStringParam(params, "absorbed_into"),
      });
      return jsonToolResult(result);
    },
  });

  api.registerTool(
    (toolContext) => {
      const agentId = toolAgentId(toolContext);
      if (!agentId) return null;
      return {
        name: "skill_experience",
        label: "Read Skill Experience",
        description:
          "Read bounded, deterministic experience notes for requested skills visible to the current agent. This tool is read-only and does not invoke a model.",
        parameters: Type.Object({
          skills: Type.Array(Type.String(), {
            minItems: 1,
            maxItems: MAX_EXPERIENCE_SKILLS,
          }),
          query: Type.Optional(
            Type.String({ maxLength: MAX_EXPERIENCE_QUERY_CODE_POINTS }),
          ),
        }),
        async execute(_toolCallId, params) {
          const rawSkillsValue =
            params && typeof params === "object"
              ? (params as Record<string, unknown>).skills
              : undefined;
          if (
            !Array.isArray(rawSkillsValue) ||
            rawSkillsValue.length < 1 ||
            rawSkillsValue.length > MAX_EXPERIENCE_SKILLS ||
            rawSkillsValue.some((value) => typeof value !== "string")
          ) {
            return jsonToolResult({
              success: false,
              error: "skills must contain between 1 and 6 names",
            });
          }
          const rawSkills = rawSkillsValue as string[];
          const requestedSkills = canonicalSkillNames(rawSkills);
          if (requestedSkills.length === 0) {
            return jsonToolResult({
              success: false,
              error: "skills must contain between 1 and 6 non-empty names",
            });
          }
          const rawQuery =
            params && typeof params === "object"
              ? (params as Record<string, unknown>).query
              : undefined;
          if (
            params &&
            typeof params === "object" &&
            Object.prototype.hasOwnProperty.call(params, "query") &&
            typeof rawQuery !== "string"
          ) {
            return jsonToolResult({
              success: false,
              error: "query must be a string",
            });
          }
          const query = optionalStringParam(params, "query");
          if (
            query !== undefined &&
            Array.from(query).length > MAX_EXPERIENCE_QUERY_CODE_POINTS
          ) {
            return jsonToolResult({
              success: false,
              error: "query must contain at most 500 Unicode code points",
            });
          }

          const inventory = await listAvailableSkills({ api, agentId });
          const visibleNames = new Set(
            canonicalSkillNames(inventory.map((skill) => skill.name)),
          );
          const availableSkills = requestedSkills.filter((name) =>
            visibleNames.has(name),
          );
          const unavailableSkills = requestedSkills.filter(
            (name) => !visibleNames.has(name),
          );
          const matches = options.experienceCatalog
            ? options.experienceCatalog.search({
                skillNames: availableSkills,
                query,
                limit: MAX_EXPERIENCE_ENTRIES,
              })
            : [];

          let remainingCodePoints = MAX_EXPERIENCE_TOTAL_CODE_POINTS;
          const entries = matches.flatMap((entry) => {
            if (remainingCodePoints <= 0) return [];
            const body = truncateCodePoints(
              entry.body,
              Math.min(MAX_EXPERIENCE_BODY_CODE_POINTS, remainingCodePoints),
            );
            remainingCodePoints -= Array.from(body).length;
            return [
              {
                identity: entry.identity,
                skill: entry.skill,
                entry_id: entry.entryId,
                summary: entry.summary,
                keywords: entry.keywords,
                body,
              },
            ];
          });

          return jsonToolResult({
            success: true,
            requested_skills: requestedSkills,
            unavailable_skills: unavailableSkills,
            entries,
          });
        },
      };
    },
    { name: "skill_experience" },
  );
}
