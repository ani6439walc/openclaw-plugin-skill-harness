import { Type } from "typebox";
import {
  getReviewToolBinding,
  type ReviewToolRegistry,
} from "../review/tool-bindings.js";
import type { OpenClawPluginApi } from "../../api.js";
import { listAvailableSkills } from "./indexer.js";
import { readAvailableSkill } from "./files.js";
import { recordSkillUsageToStateDb } from "./state-usage.js";
import { relatedSkillsBySkillName } from "./related.js";
import { skillSourcePriority } from "./types.js";
import type { SkillQmdIndex } from "../qmd/skill-index.js";
import { readSkillUsageStats, skillUsageStatsForName } from "./usage-stats.js";

const DEFAULT_SKILL_LIST_LIMIT = 150;
const MAX_SKILL_LIST_LIMIT = 500;
const DEFAULT_SKILL_SEARCH_LIMIT = 20;
const MAX_SKILL_SEARCH_LIMIT = 100;
const MAX_SKILL_SEARCH_QUERY_CODE_POINTS = 1_000;
const MAX_SKILL_SEARCH_RELATED = 3;

export interface RegisterSkillToolsOptions {
  reviewToolRegistry?: ReviewToolRegistry;
  qmdSkillIndex?: SkillQmdIndex;
  scheduleSkillSearchIndex?: (agentId: string) => void;
  bundledSkillsDir?: string;
  nativeBundledSkillsDir?: Promise<string | undefined>;
  getSharedRoots?: () => readonly string[];
  homeDir?: string;
}

function jsonToolResult(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    // Code Mode projects details instead of the rendered text.
    details: JSON.parse(text) as unknown,
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

function booleanParam(
  params: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (!params || typeof params !== "object") return defaultValue;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value === "boolean") return value;
  return defaultValue;
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

function toolAgentId(context: { agentId?: string }): string | undefined {
  return context.agentId?.trim() || undefined;
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join("");
}

export function registerSkillTools(
  api: OpenClawPluginApi,
  options: RegisterSkillToolsOptions = {},
): void {
  api.registerTool(
    {
      contextVersion: 2,
      create(toolContext) {
        const agentId = toolAgentId(toolContext);
        if (!agentId) return null;
        return {
          name: "skill_list",
          label: "List Skills",
          description:
            "List OpenClaw skills visible to the current agent. Use only when the task is broad, terminology is uncertain, or focused search is insufficient. Set show_related to include direct optional relations: current-to-related points from the returned skill to another visible skill, while related-to-current points from another visible skill to the returned skill. Use skill_view to read full SKILL.md content or linked support files.",
          parameters: Type.Object({
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
                  "When true, include direct unverified graph relations with type, relation reason, source (author-import or review) and original direction; these are not required dependencies.",
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
              bundledSkillsDir: options.bundledSkillsDir,
              nativeBundledSkillsDir: await options.nativeBundledSkillsDir,
              sharedRoots: options.getSharedRoots?.(),
              homeDir: options.homeDir,
            });
            const page = skills.slice(offset, offset + limit);
            const relatedSkills =
              showRelated && page.length > 0
                ? await relatedSkillsBySkillName(
                    skills,
                    api,
                    page.map((skill) => skill.name),
                  )
                : undefined;
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
                path: skill.location,
                ...(relatedSkills
                  ? {
                      related_skills:
                        relatedSkills.get(skill.name.toLowerCase()) ?? [],
                    }
                  : {}),
                ...(usageStats
                  ? {
                      usage_stats: skillUsageStatsForName(
                        usageStats,
                        skill.name,
                      ),
                    }
                  : {}),
              })),
            });
          },
        };
      },
    },
    { name: "skill_list" },
  );

  api.registerTool(
    {
      contextVersion: 2,
      create(toolContext) {
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
                  "When true, include top matching chunk evidence for each skill. Defaults to true.",
              }),
            ),
            show_related: Type.Optional(
              Type.Boolean({
                description:
                  "When true, include up to 3 top-ranked direct unverified graph relations with type, relation reason, source (author-import or review) and original direction, plus related_skills_total; these are not required dependencies. Defaults to true. Use skill_view to inspect all relations.",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const binding = getReviewToolBinding(
              toolContext,
              options.reviewToolRegistry,
            );
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
            const search = async () => {
              if (binding) toolContext.assertInvocationCurrent?.();

              const requestedLimit =
                optionalIntegerParam(params, "limit") ??
                DEFAULT_SKILL_SEARCH_LIMIT;
              const limit = Math.min(
                MAX_SKILL_SEARCH_LIMIT,
                Math.max(1, requestedLimit),
              );
              const showStats = booleanParam(params, "show_stats");
              const showEvidence = booleanParam(params, "show_evidence", true);
              const showRelated = booleanParam(params, "show_related", true);

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
              if (hits.length === 0) {
                return jsonToolResult({
                  success: true,
                  query,
                  total: 0,
                  count: 0,
                  limit,
                  skills: [],
                });
              }

              const inventory = await listAvailableSkills({
                api,
                agentId,
                bundledSkillsDir: options.bundledSkillsDir,
                nativeBundledSkillsDir: await options.nativeBundledSkillsDir,
                sharedRoots: options.getSharedRoots?.(),
                homeDir: options.homeDir,
                usageStats: {},
              });
              const inventoryByName = new Map(
                inventory.map((skill) => [skill.name.toLowerCase(), skill]),
              );
              const matchedHits = hits.flatMap((hit) => {
                const skill = inventoryByName.get(hit.name.toLowerCase());
                return skill ? [{ hit, skill }] : [];
              });
              const relatedSkills =
                showRelated && matchedHits.length > 0
                  ? await relatedSkillsBySkillName(
                      inventory,
                      api,
                      matchedHits.map(({ skill }) => skill.name),
                    )
                  : undefined;
              const usageStats =
                showStats && matchedHits.length > 0
                  ? await readSkillUsageStats({ api, agentId })
                  : undefined;

              const skills = matchedHits
                .map(({ hit, skill }) => {
                  const allRelated = relatedSkills
                    ? (relatedSkills.get(skill.name.toLowerCase()) ?? [])
                    : undefined;
                  return {
                    name: skill.name,
                    description: skill.description,
                    source: skill.source,
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
                    ...(allRelated
                      ? {
                          related_skills: allRelated.slice(
                            0,
                            MAX_SKILL_SEARCH_RELATED,
                          ),
                          related_skills_total: allRelated.length,
                        }
                      : {}),
                  };
                })
                .sort((left, right) => {
                  if (right.score !== left.score)
                    return right.score - left.score;
                  const sourceComparison =
                    skillSourcePriority(left.source) -
                    skillSourcePriority(right.source);
                  if (sourceComparison !== 0) return sourceComparison;
                  if (usageStats) {
                    const usageComparison =
                      skillUsageStatsForName(usageStats, right.name)
                        .usage_turns -
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
            };
            if (!binding) return search();
            const result = await binding.search(search);
            toolContext.assertInvocationCurrent?.();
            return result;
          },
        };
      },
    },
    { name: "skill_search" },
  );

  api.registerTool(
    {
      contextVersion: 2,
      create(toolContext) {
        const agentId = toolAgentId(toolContext);
        if (!agentId) return null;
        return {
          name: "skill_view",
          label: "View Skill",
          description:
            "Read a visible OpenClaw skill's SKILL.md content, or read one of its linked support files under references, templates, scripts, assets, or examples. Read the complete skill before following its workflow. Returned relations are unverified relation assertions, not required dependencies or hard conflicts; source identifies author-import or review provenance, and incoming relations retain their original predicate direction.",
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
            const binding = getReviewToolBinding(
              toolContext,
              options.reviewToolRegistry,
            );
            const read = async () =>
              readAvailableSkill({
                api,
                agentId,
                name: requiredStringParam(params, "name"),
                filePath: optionalStringParam(params, "file_path"),
                bundledSkillsDir: options.bundledSkillsDir,
                nativeBundledSkillsDir: await options.nativeBundledSkillsDir,
                sharedRoots: options.getSharedRoots?.(),
                homeDir: options.homeDir,
              });

            if (binding) {
              toolContext.assertInvocationCurrent?.();
              const inspected = await binding.readSkill(
                requiredStringParam(params, "name"),
                optionalStringParam(params, "file_path"),
                read,
              );
              toolContext.assertInvocationCurrent?.();
              return jsonToolResult(inspected);
            }
            const result = await read();

            if (result.success && result.path) {
              recordSkillUsageToStateDb({
                api,
                agentId,
                skillFile: result.path,
                skillName: result.name,
                skillSource: result.source,
              });
            }

            return jsonToolResult(result);
          },
        };
      },
    },
    { name: "skill_view" },
  );
}
