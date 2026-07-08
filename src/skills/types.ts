export type SkillSource =
  | "workspace"
  | "project-agent"
  | "personal-agent"
  | "managed"
  | "bundled"
  | "extra"
  | "plugin";

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
  category?: string;
}

export interface SkillResolutionParams {
  api: import("../../api.js").OpenClawPluginApi;
  agentId: string;
  bundledSkillsDir?: string;
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
      source?: SkillSource;
      category?: string;
      readiness_status: "available";
    }
  | {
      success: true;
      name: string;
      file: string;
      content: string;
      file_type: string;
      is_binary?: boolean;
    }
  | {
      success: false;
      error: string;
      hint?: string;
      available_skills?: string[];
      available_files?: LinkedSkillFiles;
    };
