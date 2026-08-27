import path from "node:path";
import type { IntentCatalogEntry } from "../types.js";
import { logger } from "../../api.js";
import { packageRoot } from "../file-utils.js";
import { validateRoutingIntentDirectory } from "./routing-validation.js";
import { getOrCache } from "../singleton.js";

const catalogCache = new Map<string, IntentCatalog>();

export class IntentCatalog {
  private intents: IntentCatalogEntry[] = [];
  private pluginRoot: string;

  private constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  static create(pluginRoot: string): IntentCatalog {
    return getOrCache(
      catalogCache,
      pluginRoot,
      (normalizedRoot) => new IntentCatalog(normalizedRoot),
    );
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

  get(): readonly IntentCatalogEntry[] {
    return this.intents;
  }

  get count(): number {
    return this.intents.length;
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

export const defaultCatalog = IntentCatalog.create(packageRoot);
