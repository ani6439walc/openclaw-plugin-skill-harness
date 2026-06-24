import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type {
  IntentCatalogEntry,
  IntentDefinition,
  ResolvedIntentionHintPluginConfig,
} from "./types.js";
import { logger } from "../api.js";
import { pluginRoot } from "./file-utils.js";

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
  config: ResolvedIntentionHintPluginConfig,
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

function parseFastpath(
  data: Record<string, unknown>,
  fileName: string,
  silent: boolean,
): IntentDefinition["fastpath"] {
  const legacyKeywords = Array.isArray(data.keywords)
    ? data.keywords.filter(
        (x): x is string => typeof x === "string" && !!x.trim(),
      )
    : [];
  if (legacyKeywords.length && !silent) {
    logger.warn(
      `${fileName}: top-level keywords are deprecated; move them to fastpath.keywords.`,
    );
  }

  const fastpath =
    data.fastpath &&
    typeof data.fastpath === "object" &&
    !Array.isArray(data.fastpath)
      ? (data.fastpath as Record<string, unknown>)
      : {};
  const keywords = Array.isArray(fastpath.keywords)
    ? fastpath.keywords.filter(
        (x): x is string => typeof x === "string" && !!x.trim(),
      )
    : legacyKeywords;
  const hint =
    typeof fastpath.hint === "string" && fastpath.hint.trim()
      ? fastpath.hint.trim()
      : undefined;

  return hint ? { keywords, hint } : { keywords };
}

export function filterIntentsForAgent(
  intents: readonly IntentCatalogEntry[],
  config: ResolvedIntentionHintPluginConfig,
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
    return new IntentCatalog(pluginRoot);
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
    config: ResolvedIntentionHintPluginConfig,
    agentId: string | undefined,
  ): IntentCatalogEntry[] {
    return filterIntentsForAgent(this.intents, config, agentId);
  }

  private loadFromDir(
    intentDirectory: string,
    silent: boolean,
  ): IntentCatalogEntry[] {
    const result: IntentCatalogEntry[] = [];

    if (!fs.existsSync(intentDirectory)) {
      return result;
    }

    const entries = fs
      .readdirSync(intentDirectory)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (const entry of entries) {
      const filePath = path.join(intentDirectory, entry);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(content);

      const data = parsed.data as Record<string, unknown>;
      const id = entry.slice(0, -".md".length);
      const triggers = Array.isArray(data.triggers)
        ? data.triggers.filter((x): x is string => typeof x === "string")
        : [];
      const examples = Array.isArray(data.examples)
        ? data.examples.filter((x): x is string => typeof x === "string")
        : [];
      const domain = typeof data.domain === "string" ? data.domain.trim() : "";
      const fastpath = parseFastpath(data, entry, silent);

      if (!triggers.length) {
        if (!silent) {
          logger.warn(
            `skipping invalid intent file: ${entry}. (missing triggers)`,
          );
        }
        continue;
      }
      if (!domain) {
        if (!silent) {
          logger.warn(
            `skipping invalid intent file: ${entry}. (missing domain)`,
          );
        }
        continue;
      }

      const definition: IntentDefinition = {
        triggers,
        examples,
        domain,
        fastpath,
        prompt: parsed.content.trim(),
      };

      result.push({ id, definition });
    }

    return result;
  }
}

export const defaultCatalog = IntentCatalog.create(pluginRoot);
