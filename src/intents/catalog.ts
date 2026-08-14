import path from "node:path";
import type {
  IntentCatalogEntry,
  ResolvedSkillHarnessPluginConfig,
} from "../types.js";
import { logger } from "../../api.js";
import { pluginRoot } from "../file-utils.js";
import { validateRoutingIntentDirectory } from "./routing-validation.js";

const catalogCache = new Map<string, IntentCatalog>();

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesWildcard(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return false;
  return wildcardToRegExp(normalizedPattern).test(value);
}

function resolveIntentDenyPatterns(
  config: ResolvedSkillHarnessPluginConfig,
  agentId: string | undefined,
): string[] {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) return [];

  const patterns: string[] = [];
  for (const [agentPattern, intentPatterns] of Object.entries(
    config.intentDeny,
  )) {
    if (matchesWildcard(agentPattern, normalizedAgentId)) {
      patterns.push(...intentPatterns);
    }
  }
  return [...new Set(patterns)];
}

export function filterIntentsForAgent(
  intents: readonly IntentCatalogEntry[],
  config: ResolvedSkillHarnessPluginConfig,
  agentId: string | undefined,
): IntentCatalogEntry[] {
  const denyPatterns = resolveIntentDenyPatterns(config, agentId);
  if (denyPatterns.length === 0) return [...intents];

  return intents.filter(
    (intent) =>
      !denyPatterns.some((pattern) => matchesWildcard(pattern, intent.id)),
  );
}

export class IntentCatalog {
  private intents: IntentCatalogEntry[] = [];
  private pluginRoot: string;

  private constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  static create(pluginRoot: string): IntentCatalog {
    const normalizedPluginRoot = path.resolve(pluginRoot);
    const existing = catalogCache.get(normalizedPluginRoot);
    if (existing) return existing;

    const catalog = new IntentCatalog(normalizedPluginRoot);
    catalogCache.set(normalizedPluginRoot, catalog);
    return catalog;
  }

  load(intentDirectory: string, options: { silent?: boolean } = {}): number {
    const resolvedDir = path.resolve(this.pluginRoot, intentDirectory);
    const loaded = this.loadFromDir(resolvedDir, options.silent ?? false);
    this.intents = loaded;
    if (!options.silent) {
      logger.debug(
        `loaded ${loaded.length} dynamic intents from ${resolvedDir}.`,
      );
    }
    return loaded.length;
  }

  reset(): void {
    this.intents = [];
  }

  setIntents(intents: IntentCatalogEntry[]): void {
    this.intents = [...intents];
  }

  get(): readonly IntentCatalogEntry[] {
    return this.intents;
  }

  get count(): number {
    return this.intents.length;
  }

  filterForAgent(
    config: ResolvedSkillHarnessPluginConfig,
    agentId: string | undefined,
  ): IntentCatalogEntry[] {
    return filterIntentsForAgent(this.intents, config, agentId);
  }

  private loadFromDir(
    intentDirectory: string,
    silent: boolean,
  ): IntentCatalogEntry[] {
    const validation = validateRoutingIntentDirectory(intentDirectory);
    if (!validation.valid) {
      if (!silent) {
        for (const error of validation.errors) {
          logger.warn(`skipping invalid intent catalog: ${error}`);
        }
      }
    }
    return validation.intents.map(({ id, definition }) => ({ id, definition }));
  }
}

export const defaultCatalog = IntentCatalog.create(pluginRoot);
