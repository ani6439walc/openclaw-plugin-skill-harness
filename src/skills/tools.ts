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
import type { SkillExperienceCatalog } from "../experiences/index.js";
import type { SkillExperienceQmdIndex } from "../qmd/experience-index.js";
import type { SkillExperienceEntry } from "../experiences/types.js";
import { canonicalIdentity } from "../normalize.js";

const DEFAULT_SKILL_LIST_LIMIT = 150;
const MAX_SKILL_LIST_LIMIT = 500;
const DEFAULT_SKILL_SEARCH_LIMIT = 20;
const MAX_SKILL_SEARCH_LIMIT = 100;
const MAX_SKILL_SEARCH_QUERY_CODE_POINTS = 1_000;
const DEFAULT_EXPERIENCE_LIMIT = 5;
const MAX_EXPERIENCE_ID_CODE_POINTS = 64;
const MAX_EXPERIENCE_QUERY_CODE_POINTS = 500;
const MAX_EXPERIENCE_LIMIT = 20;
const MAX_EXPERIENCE_BODY_CODE_POINTS = 4_000;
const MAX_EXPERIENCE_TOTAL_CODE_POINTS = 10_000;

export interface RegisterSkillToolsOptions {
  reviewToolRegistry?: ReviewToolRegistry;
  experienceCatalog?: SkillExperienceCatalog;
  qmdExperienceIndex?: SkillExperienceQmdIndex;
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
            const relatedSkills = showRelated
              ? await relatedSkillsBySkillName(skills, api)
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
                  "When true, include direct unverified graph relations with type, relation reason, source (author-import or review) and original direction; these are not required dependencies.",
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
              const showRelated = booleanParam(params, "show_related");

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
                bundledSkillsDir: options.bundledSkillsDir,
                nativeBundledSkillsDir: await options.nativeBundledSkillsDir,
                sharedRoots: options.getSharedRoots?.(),
                homeDir: options.homeDir,
              });
              const relatedSkills = showRelated
                ? await relatedSkillsBySkillName(inventory, api)
                : undefined;
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
                    ...(showRelated && relatedSkills
                      ? {
                          related_skills:
                            relatedSkills.get(skill.name.toLowerCase()) ?? [],
                        }
                      : {}),
                  };
                })
                .filter(
                  (skill): skill is NonNullable<typeof skill> =>
                    skill !== undefined,
                )
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

  api.registerTool(
    {
      contextVersion: 2,
      create(toolContext) {
        const agentId = toolAgentId(toolContext);
        if (!agentId) return null;
        return {
          name: "skill_experience",
          label: "Read Skill Experience",
          description:
            "Read a shared runtime experience in full by exact id, or search shared runtime experiences by query. Skill visibility only filters displayed associations, never experience eligibility. Search bodies are bounded (4,000 code points each, 10,000 total; truncated entries set body_truncated: true); pass id to read the complete untruncated body. Read-only and does not invoke a model.",
          parameters: Type.Object({
            id: Type.Optional(
              Type.String({
                maxLength: MAX_EXPERIENCE_ID_CODE_POINTS,
                description:
                  'Exact experience ID to read in full without search truncation (for example from an injected <experience id="..."> summary or prior search). Mutually exclusive with query.',
              }),
            ),
            query: Type.Optional(
              Type.String({
                maxLength: MAX_EXPERIENCE_QUERY_CODE_POINTS,
                description:
                  "Concise search query over shared runtime experiences. Mutually exclusive with id.",
              }),
            ),
            limit: Type.Optional(
              Type.Number({
                description:
                  "Maximum number of search results. Defaults to 5 and is capped at 20. Ignored when id is provided.",
              }),
            ),
            show_skills: Type.Optional(
              Type.Boolean({
                description:
                  "Include associated skills visible to the current agent. Defaults to true. Does not filter experience results.",
              }),
            ),
          }),
          async execute(_toolCallId, params) {
            const record =
              params && typeof params === "object"
                ? (params as Record<string, unknown>)
                : undefined;
            if (
              record &&
              Object.prototype.hasOwnProperty.call(record, "id") &&
              record.id !== undefined &&
              typeof record.id !== "string"
            ) {
              return jsonToolResult({
                success: false,
                error: "id must be a string",
              });
            }
            if (
              record &&
              Object.prototype.hasOwnProperty.call(record, "query") &&
              record.query !== undefined &&
              typeof record.query !== "string"
            ) {
              return jsonToolResult({
                success: false,
                error: "query must be a string",
              });
            }

            const id = optionalStringParam(params, "id");
            const query = optionalStringParam(params, "query");
            if (
              id !== undefined &&
              Array.from(id).length > MAX_EXPERIENCE_ID_CODE_POINTS
            ) {
              return jsonToolResult({
                success: false,
                error: "id must contain at most 64 Unicode code points",
              });
            }
            if (
              query !== undefined &&
              Array.from(query).length > MAX_EXPERIENCE_QUERY_CODE_POINTS
            ) {
              return jsonToolResult({
                success: false,
                error: "query must contain at most 500 Unicode code points",
              });
            }

            const trimmedId = id?.trim() ?? "";
            const trimmedQuery = query?.trim() ?? "";
            if (trimmedId && trimmedQuery) {
              return jsonToolResult({
                success: false,
                error: "provide either id or query, not both",
              });
            }
            if (!trimmedId && !trimmedQuery) {
              return jsonToolResult({
                success: false,
                error: "id or query is required",
              });
            }

            const showSkills = booleanParam(params, "show_skills", true);

            const loadVisibleNames = async (): Promise<ReadonlySet<string>> => {
              if (!showSkills) return new Set();
              const inventory = await listAvailableSkills({
                api,
                agentId,
                bundledSkillsDir: options.bundledSkillsDir,
                nativeBundledSkillsDir: await options.nativeBundledSkillsDir,
                sharedRoots: options.getSharedRoots?.(),
                homeDir: options.homeDir,
              });
              return new Set(
                canonicalSkillNames(inventory.map((skill) => skill.name)),
              );
            };

            if (trimmedId) {
              const entry = options.experienceCatalog?.resolve(trimmedId);
              if (!entry) {
                return jsonToolResult({
                  success: false,
                  error: "experience not found",
                });
              }
              const visibleNames = await loadVisibleNames();
              return jsonToolResult({
                success: true,
                entries: [
                  {
                    id: entry.id,
                    ...(showSkills
                      ? {
                          skills: entry.skills.filter((skill) =>
                            visibleNames.has(canonicalIdentity(skill)),
                          ),
                        }
                      : {}),
                    summary: entry.summary,
                    keywords: entry.keywords,
                    body: entry.body,
                    body_truncated: false,
                  },
                ],
              });
            }

            const limit = Math.min(
              MAX_EXPERIENCE_LIMIT,
              Math.max(
                1,
                optionalIntegerParam(params, "limit") ??
                  DEFAULT_EXPERIENCE_LIMIT,
              ),
            );

            let matches: SkillExperienceEntry[] = [];
            if (query && options.qmdExperienceIndex) {
              // Discovery indexes initialize and revalidate freshness inside search().
              try {
                const hits = await options.qmdExperienceIndex.search({
                  query,
                  limit,
                });
                if (hits) {
                  const resolved = hits
                    .map((hit) => options.experienceCatalog?.resolve(hit.id))
                    .filter((entry): entry is SkillExperienceEntry =>
                      Boolean(entry),
                    );
                  matches = resolved.slice(0, limit);
                }
              } catch {
                // fallback
              }
            }

            if (matches.length === 0 && options.experienceCatalog) {
              matches = options.experienceCatalog.search({
                query,
                limit,
              });
            }

            const visibleNames =
              matches.length > 0 ? await loadVisibleNames() : new Set<string>();

            let remainingCodePoints = MAX_EXPERIENCE_TOTAL_CODE_POINTS;
            const entries = matches.map((entry) => {
              const fullLength = Array.from(entry.body).length;
              const body = truncateCodePoints(
                entry.body,
                Math.min(MAX_EXPERIENCE_BODY_CODE_POINTS, remainingCodePoints),
              );
              const renderedLength = Array.from(body).length;
              remainingCodePoints -= renderedLength;
              return {
                id: entry.id,
                ...(showSkills
                  ? {
                      skills: entry.skills.filter((skill) =>
                        visibleNames.has(canonicalIdentity(skill)),
                      ),
                    }
                  : {}),
                summary: entry.summary,
                keywords: entry.keywords,
                body,
                body_truncated: renderedLength < fullLength,
              };
            });

            return jsonToolResult({
              success: true,
              entries,
            });
          },
        };
      },
    },
    { name: "skill_experience" },
  );
}
