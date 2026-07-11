export const SKILL_SOURCE_ORDER = [
  "workspace",
  "project-agent",
  "personal-agent",
  "managed",
  "plugin",
  "bundled",
  "extra",
] as const;

export type SkillSource = (typeof SKILL_SOURCE_ORDER)[number];

const SKILL_SOURCE_PRIORITY = new Map(
  SKILL_SOURCE_ORDER.map((source, index) => [source, index]),
);

export function skillSourcePriority(source: SkillSource | undefined): number {
  return source
    ? (SKILL_SOURCE_PRIORITY.get(source) ?? Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
}

export interface SkillUsageStats {
  usage_turns: number;
  recommended_turns: number;
  adopted_turns: number;
  adoption_rate: number;
  last_used_at?: string;
  last_7_days_usage: number;
  lifecycle: "active" | "stale" | "archive" | "never-used";
  needs_review: boolean;
}

export interface DeclaredRelatedSkill {
  name: string;
  reason: string;
}

export type RelatedSkillDirection = "current-to-related" | "related-to-current";

export interface RelatedSkillResult {
  name: string;
  reason: string;
  direction: RelatedSkillDirection;
}

export interface SkillRoot {
  path: string;
  source: SkillSource;
  precedence: number;
}

export interface AvailableSkill {
  name: string;
  location: string;
  description: string;
  source?: SkillSource;
  domains?: string[];
  relatedSkills?: DeclaredRelatedSkill[];
  resolvedRelatedSkills?: RelatedSkillResult[];
}

export interface SkillResolutionParams {
  api: import("../../api.js").OpenClawPluginApi;
  agentId: string;
  bundledSkillsDir?: string;
  intents?: readonly import("../types.js").IntentCatalogEntry[];
  cacheTtlMs?: number;
  nowMs?: number;
  homeDir?: string;
}

export interface SkillReadParams extends SkillResolutionParams {
  name: string;
  filePath?: string;
}

export type LinkedSkillFiles = Partial<
  Record<
    "references" | "templates" | "scripts" | "assets" | "examples",
    string[]
  >
>;

export type SkillReadResult =
  | {
      success: true;
      name: string;
      description?: string;
      content: string;
      path?: string;
      skill_dir?: string;
      linked_files?: LinkedSkillFiles;
      usage_hint?: string | null;
      usage_stats: SkillUsageStats;
      related_skills: RelatedSkillResult[];
      source?: SkillSource;
      domains: string[];
      readiness_status: "available";
    }
  | {
      success: true;
      name: string;
      file: string;
      content: string;
      file_type: string;
      domains: string[];
      related_skills: RelatedSkillResult[];
      is_binary?: boolean;
    }
  | {
      success: false;
      error: string;
      hint?: string;
      available_skills?: string[];
      available_files?: LinkedSkillFiles;
    };
