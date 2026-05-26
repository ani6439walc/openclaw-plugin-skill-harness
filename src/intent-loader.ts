import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type {
  IntentDefinition,
  ResolvedIntentionHintPluginConfig,
} from "./types.js";
import { logger } from "../api.js";

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

export function filterIntentsForAgent(
  intents: readonly IntentDefinition[],
  config: ResolvedIntentionHintPluginConfig,
  agentId: string | undefined,
): IntentDefinition[] {
  const denyPatterns = resolveIntentDenyPatterns(config, agentId);
  if (denyPatterns.length === 0) return [...intents];

  return intents.filter(
    (intent) =>
      !denyPatterns.some((pattern) => matchesWildcard(pattern, intent.id)),
  );
}

export class IntentCatalog {
  private intents: IntentDefinition[] = [];
  private pluginRoot: string;

  private constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  static create(pluginRoot: string): IntentCatalog {
    return new IntentCatalog(pluginRoot);
  }

  load(intentsDir: string): number {
    const resolvedDir = path.resolve(this.pluginRoot, intentsDir);
    const loaded = this.loadFromDir(resolvedDir);
    this.intents = loaded;
    logger.debug(
      `loaded ${loaded.length} dynamic intents from ${resolvedDir}.`,
    );
    return loaded.length;
  }

  reset(): void {
    this.intents = [];
  }

  setIntents(intents: IntentDefinition[]): void {
    this.intents = [...intents];
  }

  get(): readonly IntentDefinition[] {
    return this.intents;
  }

  get count(): number {
    return this.intents.length;
  }

  filterForAgent(
    config: ResolvedIntentionHintPluginConfig,
    agentId: string | undefined,
  ): IntentDefinition[] {
    return filterIntentsForAgent(this.intents, config, agentId);
  }

  private loadFromDir(intentsDir: string): IntentDefinition[] {
    const result: IntentDefinition[] = [];

    if (!fs.existsSync(intentsDir)) {
      return result;
    }

    const entries = fs
      .readdirSync(intentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    for (const entry of entries) {
      const filePath = path.join(intentsDir, entry);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(content);

      const data = parsed.data as Record<string, unknown>;
      const id = typeof data.id === "string" ? data.id.trim() : undefined;
      const name =
        typeof data.name === "string"
          ? data.name.trim()
          : (id ?? entry.replace(".md", ""));
      const enabled = data.enabled !== false;
      const triggers = Array.isArray(data.triggers)
        ? data.triggers.filter((x): x is string => typeof x === "string")
        : [];
      const examples = Array.isArray(data.examples)
        ? data.examples.filter((x): x is string => typeof x === "string")
        : [];

      if (!id || !triggers.length) {
        logger.warn(
          `skipping invalid intent file: ${entry}. (missing id or triggers)`,
        );
        continue;
      }

      const existingIndex = result.findIndex((d) => d.id === id);
      const definition: IntentDefinition = {
        id,
        name,
        enabled,
        triggers,
        examples,
        prompt: parsed.content.trim(),
      };

      if (existingIndex >= 0) {
        result[existingIndex] = definition;
      } else {
        result.push(definition);
      }
    }

    return result;
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// Compiled code lives in dist/src/, so go up 2 levels to reach plugin root.
const pluginRoot = path.resolve(currentDir, "..", "..");

export const defaultCatalog = IntentCatalog.create(pluginRoot);
