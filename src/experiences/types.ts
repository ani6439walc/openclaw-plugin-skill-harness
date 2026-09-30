export interface SkillExperienceEntry {
  id: string;
  skills: string[];
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
  query?: string;
  skills?: readonly string[];
  limit?: number;
}
