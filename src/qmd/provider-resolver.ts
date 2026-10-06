import type { OpenClawConfig } from "../../api.js";
import type { ResolvedQmdConfig } from "../types.js";

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
  voyage: "https://api.voyageai.com/v1",
  voyageai: "https://api.voyageai.com/v1",
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
  const specificVar =
    normalized === "VOYAGE" || normalized === "VOYAGEAI"
      ? "VOYAGE_API_KEY"
      : `${normalized}_API_KEY`;
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

  // Find model-specific entry under providerEntry.models if present
  let matchedModelEntry: Record<string, unknown> | undefined;
  if (providerEntry && providerEntry.models) {
    if (Array.isArray(providerEntry.models)) {
      const found = providerEntry.models.find(
        (m: unknown) =>
          typeof m === "object" &&
          m !== null &&
          ((m as { id?: string }).id === modelId ||
            (m as { id?: string }).id === rawModel ||
            (m as { name?: string }).name === modelId ||
            (m as { name?: string }).name === rawModel),
      );
      if (found && typeof found === "object") {
        matchedModelEntry = found as Record<string, unknown>;
      }
    } else if (
      typeof providerEntry.models === "object" &&
      providerEntry.models !== null
    ) {
      const modelsObj = providerEntry.models as Record<string, unknown>;
      const matchVal = modelsObj[modelId] ?? modelsObj[rawModel];
      if (typeof matchVal === "object" && matchVal !== null) {
        matchedModelEntry = matchVal as Record<string, unknown>;
      }
    }
  }

  const explicitBaseUrl = rawEndpoint.baseUrl?.trim();
  let resolvedBaseUrl = explicitBaseUrl || "";

  // 1. Check model-specific baseUrl under providerEntry.models first
  if (
    !resolvedBaseUrl &&
    matchedModelEntry &&
    typeof matchedModelEntry.baseUrl === "string" &&
    matchedModelEntry.baseUrl.trim()
  ) {
    resolvedBaseUrl = matchedModelEntry.baseUrl.trim();
  }

  // 2. Fall back to providerEntry.baseUrl
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

  // 1. Check model-specific apiKey under providerEntry.models first
  if (
    !resolvedApiKey &&
    matchedModelEntry &&
    matchedModelEntry.apiKey !== undefined
  ) {
    resolvedApiKey = extractApiKeyFromProvider(matchedModelEntry.apiKey, env);
  }

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

/**
 * Normalizes an embedding model reference by stripping any 'provider/' prefix.
 * For example, 'bifrost/text-embedding-3-small' and 'openai/text-embedding-3-small'
 * both normalize to 'text-embedding-3-small'.
 */
export function normalizeEmbeddingModel(rawModel?: string): string {
  if (!rawModel) return "";
  const trimmed = rawModel.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    return trimmed.slice(slashIndex + 1).trim();
  }
  return trimmed;
}

/**
 * Checks whether a given model string references TypeSafe Jev.
 */
export function isJevModel(model?: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (lower.startsWith("typesafe/") || lower.includes("/typesafe/"))
    return true;

  // Extract the model name without the provider prefix
  const parts = lower.split("/");
  const modelName = parts[parts.length - 1] ?? "";

  return modelName === "jev" || modelName.startsWith("jev-");
}

/**
 * Normalizes a base URL for TypeSafeClient (@typesafe-ai/sdk).
 * The SDK appends '/v1/systemone' to baseURL. If the provided URL ends with '/v1',
 * we strip it (e.g. 'https://openrouter.ai/api/v1' -> 'https://openrouter.ai/api').
 */
export function normalizeTypeSafeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  if (trimmed.endsWith("/v1/systemone")) {
    return trimmed.slice(0, -"/v1/systemone".length);
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }
  return trimmed;
}

/**
 * Builds the C++ QMD store models configuration, resolving Jev endpoints
 * from config.jev (even if model is omitted) or fallback to expansion.
 */
export function buildStoreModels(config: ResolvedQmdConfig) {
  const jevEndpoint =
    config.jev ??
    (isJevModel(config.expansion.model) ? config.expansion : undefined);

  const embeddingCacheDir = config.embeddingCacheDir?.trim();

  return {
    ...(embeddingCacheDir ? { embed_cache_dir: embeddingCacheDir } : {}),
    embed_api_url: config.embedding.baseUrl,
    embed_api_model: config.embedding.model,
    ...(config.embedding.apiKey
      ? { embed_api_key: config.embedding.apiKey }
      : {}),
    ...(config.embedding.dimension
      ? { embed_dimension: config.embedding.dimension }
      : {}),
    generate_api_url: config.expansion.baseUrl,
    generate_api_model: config.expansion.model,
    ...(config.expansion.apiKey
      ? { generate_api_key: config.expansion.apiKey }
      : {}),
    ...(jevEndpoint?.baseUrl ? { jev_base_url: jevEndpoint.baseUrl } : {}),
    ...(jevEndpoint?.model ? { jev_api_model: jevEndpoint.model } : {}),
    ...(jevEndpoint?.apiKey ? { jev_api_key: jevEndpoint.apiKey } : {}),
  };
}
