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
      is_binary?: boolean;
    }
  | {
      success: false;
      error: string;
      hint?: string;
      available_skills?: string[];
      available_files?: LinkedSkillFiles;
    };
