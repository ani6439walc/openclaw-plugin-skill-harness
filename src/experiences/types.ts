export interface SkillExperienceEntry {
  identity: string;
  skill: string;
  entryId: string;
  summary: string;
  keywords: string[];
  body: string;
  path: string;
}

export interface ExperienceDirectoryValidationError {
  file: string;
  message: string;
}

export interface ExperienceDirectoryValidationResult {
  valid: boolean;
  entries: SkillExperienceEntry[];
  errors: ExperienceDirectoryValidationError[];
}

export interface ExperienceSearchParams {
  skillNames: readonly string[];
  query?: string;
  limit?: number;
}
