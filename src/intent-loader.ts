import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { IntentDefinition } from "./types.js";
import { logger } from "../api.js";

export class IntentCatalog {
  private intents: IntentDefinition[] = [];
  private pluginRoot: string;

  constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  load(intentsDir: string): number {
    const resolvedDir = path.resolve(this.pluginRoot, intentsDir);
    const loaded = this.loadFromDir(resolvedDir);
    this.intents = loaded;
    logger.debug(`Loaded ${loaded.length} dynamic intents from ${resolvedDir}`);
    return loaded.length;
  }

  reset(): void {
    this.intents = [];
  }

  get(): readonly IntentDefinition[] {
    return this.intents;
  }

  get count(): number {
    return this.intents.length;
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
          `Skipping invalid intent file: ${entry} (missing id or triggers)`,
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
