import type { OpenClawConfig } from "../../api.js";

export interface RawQmdEndpointInput {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  dimension?: number;
}

export interface ResolvedQmdEndpointResult {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  dimension?: number;
}

export interface ResolveQmdEndpointOptions {
  openClawConfig?: OpenClawConfig | undefined;
  env?: NodeJS.ProcessEnv;
  defaultDimension?: number;
}

const WELL_KNOWN_PROVIDER_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  together: "https://api.together.xyz/v1",
  ollama: "http://localhost:11434/v1",
};

/**
 * Extracts a secret string value from an OpenClaw provider apiKey field,
 * resolving environment variable templates like `${VAR}`, `$VAR`,
 * `__env__:VAR`, `secretref-env:VAR`, or SecretRef objects.
 */
function extractApiKeyFromProvider(
  apiKeyVal: unknown,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (typeof apiKeyVal === "string") {
    const trimmed = apiKeyVal.trim();
    if (!trimmed) return undefined;

    const templateMatch = /^\$\{?([A-Z0-9_]+)\}?$/.exec(trimmed);
    if (templateMatch && templateMatch[1]) {
      return env[templateMatch[1]]?.trim() || undefined;
    }

    if (trimmed.startsWith("__env__:")) {
      const varName = trimmed.slice("__env__:".length).trim();
      return env[varName]?.trim() || undefined;
    }

    if (trimmed.startsWith("secretref-env:")) {
      const varName = trimmed.slice("secretref-env:".length).trim();
      return env[varName]?.trim() || undefined;
    }

    return trimmed;
  }

  if (typeof apiKeyVal === "object" && apiKeyVal !== null) {
    const obj = apiKeyVal as Record<string, unknown>;
    if (typeof obj.id === "string" && obj.id.trim()) {
      const source = typeof obj.source === "string" ? obj.source : "env";
      if (source === "env") {
        return env[obj.id.trim()]?.trim() || undefined;
      }
    }
  }

  return undefined;
}

/**
 * Checks standard environment variable naming conventions for a provider API key.
 */
function extractFallbackEnvApiKey(
  providerKey: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const normalized = providerKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const specificVar = `${normalized}_API_KEY`;
  return env[specificVar]?.trim() || undefined;
}

/**
 * Resolves a QMD endpoint's baseUrl, model, and apiKey.
 *
 * If baseUrl or apiKey are omitted, and model uses OpenClaw's 'provider/model'
 * format, they are dynamically retrieved from the current OpenClaw configuration
 * (models.providers[provider]) or well-known defaults and environment variables.
 */
export function resolveQmdEndpoint(
  rawEndpoint: RawQmdEndpointInput,
  options?: ResolveQmdEndpointOptions,
): ResolvedQmdEndpointResult {
  const rawModel = (rawEndpoint.model ?? "").trim();
  const env = options?.env ?? process.env;

  let providerKey: string | undefined;
  let modelId = rawModel;

  const slashIndex = rawModel.indexOf("/");
  if (slashIndex > 0) {
    providerKey = rawModel.slice(0, slashIndex).trim();
    modelId = rawModel.slice(slashIndex + 1).trim();
  }

  let providerEntry: Record<string, unknown> | undefined;
  if (providerKey && options?.openClawConfig?.models?.providers) {
    const providers = options.openClawConfig.models.providers as Record<
      string,
      unknown
    >;
    let matchKey = Object.keys(providers).find(
      (k) => k.toLowerCase() === providerKey!.toLowerCase(),
    );
    if (!matchKey) {
      const lower = providerKey.toLowerCase();
      if (lower === "bitfrost") {
        matchKey = Object.keys(providers).find(
          (k) => k.toLowerCase() === "bifrost",
        );
      } else if (lower === "bifrost") {
        matchKey = Object.keys(providers).find(
          (k) => k.toLowerCase() === "bitfrost",
        );
      }
    }
    if (
      matchKey &&
      typeof providers[matchKey] === "object" &&
      providers[matchKey] !== null
    ) {
      providerEntry = providers[matchKey] as Record<string, unknown>;
    }
  }

  // If no provider prefix was used, attempt to discover the provider from configured model catalogs
  if (!providerKey && options?.openClawConfig?.models?.providers) {
    const providers = options.openClawConfig.models.providers as Record<
      string,
      unknown
    >;
    for (const [key, val] of Object.entries(providers)) {
      if (typeof val === "object" && val !== null) {
        const candidateModels = (val as { models?: Array<{ id?: string }> })
          .models;
        if (
          Array.isArray(candidateModels) &&
          candidateModels.some((m) => m?.id === rawModel)
        ) {
          providerKey = key;
          providerEntry = val as Record<string, unknown>;
          break;
        }
      }
    }
  }

  const explicitBaseUrl = rawEndpoint.baseUrl?.trim();
  let resolvedBaseUrl = explicitBaseUrl || "";

  if (
    !resolvedBaseUrl &&
    providerEntry &&
    typeof providerEntry.baseUrl === "string"
  ) {
    resolvedBaseUrl = providerEntry.baseUrl.trim();
  }

  if (!resolvedBaseUrl && providerKey) {
    const defaultUrl = WELL_KNOWN_PROVIDER_BASE_URLS[providerKey.toLowerCase()];
    if (defaultUrl) {
      resolvedBaseUrl = defaultUrl;
    }
  }

  const explicitApiKey = rawEndpoint.apiKey?.trim();
  let resolvedApiKey: string | undefined = explicitApiKey || undefined;

  if (!resolvedApiKey && providerEntry) {
    resolvedApiKey = extractApiKeyFromProvider(providerEntry.apiKey, env);
  }

  if (!resolvedApiKey && providerKey) {
    resolvedApiKey = extractFallbackEnvApiKey(providerKey, env);
  }

  const resolvedModel = providerKey ? modelId : rawModel;

  const resolvedDimension =
    rawEndpoint.dimension !== undefined
      ? rawEndpoint.dimension
      : options?.defaultDimension;

  return {
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
    apiKey: resolvedApiKey,
    ...(resolvedDimension !== undefined
      ? { dimension: resolvedDimension }
      : {}),
  };
}
