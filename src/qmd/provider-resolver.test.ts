import { describe, expect, it } from "vitest";
import {
  buildStoreModels,
  isJevModel,
  normalizeEmbeddingModel,
  normalizeTypeSafeBaseUrl,
  resolveQmdEndpoint,
} from "./provider-resolver.js";
import type { OpenClawConfig } from "../../api.js";
import type { ResolvedQmdConfig } from "../types.js";

describe("resolveQmdEndpoint", () => {
  it.each(["voyage", "voyageai"])(
    "resolves %s using the native Voyage endpoint and key",
    (provider) => {
      expect(
        resolveQmdEndpoint(
          { model: `${provider}/voyage-4`, dimension: 1024 },
          {
            env: {
              VOYAGE_API_KEY: " voyage-key ",
              OPENAI_API_KEY: "unrelated-key",
            },
          },
        ),
      ).toEqual({
        baseUrl: "https://api.voyageai.com/v1",
        model: "voyage-4",
        apiKey: "voyage-key",
        dimension: 1024,
      });
      expect(
        resolveQmdEndpoint(
          { model: `${provider}/voyage-4` },
          {
            env: { OPENAI_API_KEY: "unrelated-key" },
          },
        ).apiKey,
      ).toBeUndefined();
    },
  );

  it("preserves explicit Voyage connection settings ahead of aliases and env", () => {
    expect(
      resolveQmdEndpoint(
        {
          model: "voyageai/voyage-4",
          dimension: 1024,
          baseUrl: "https://voyage.example/v1",
          apiKey: "explicit-key",
        },
        {
          env: { VOYAGE_API_KEY: "env-key" },
        },
      ),
    ).toEqual({
      baseUrl: "https://voyage.example/v1",
      model: "voyage-4",
      apiKey: "explicit-key",
      dimension: 1024,
    });
  });

  it("preserves explicit baseUrl and apiKey", () => {
    const result = resolveQmdEndpoint({
      baseUrl: "https://explicit.example.com/v1",
      model: "text-embedding-3-small",
      apiKey: "explicit-key",
      dimension: 1536,
    });

    expect(result).toEqual({
      baseUrl: "https://explicit.example.com/v1",
      model: "text-embedding-3-small",
      apiKey: "explicit-key",
      dimension: 1536,
    });
  });

  it("resolves baseUrl and plain apiKey from OpenClaw provider configuration", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          bifrost: {
            baseUrl: "https://bifrost.infra.example.com/openai/v1",
            apiKey: "bifrost-secret-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      {
        model: "bifrost/text-embedding-3-small",
        dimension: 768,
      },
      { openClawConfig: mockConfig },
    );

    expect(result).toEqual({
      baseUrl: "https://bifrost.infra.example.com/openai/v1",
      model: "text-embedding-3-small",
      apiKey: "bifrost-secret-key",
      dimension: 768,
    });
  });

  it("performs case-insensitive matching for provider keys", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          Bifrost: {
            baseUrl: "https://bifrost.infra.example.com/openai/v1",
            apiKey: "bifrost-secret",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      { model: "bifrost/gpt-4o-mini" },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe("https://bifrost.infra.example.com/openai/v1");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.apiKey).toBe("bifrost-secret");
  });

  it("resolves apiKey from env templates ${VAR} and $VAR", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://custom.endpoint/v1",
            apiKey: "${CUSTOM_KEY_NAME}",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const env = { CUSTOM_KEY_NAME: "resolved-from-env" } as NodeJS.ProcessEnv;

    const result = resolveQmdEndpoint(
      { model: "custom/my-model" },
      { openClawConfig: mockConfig, env },
    );

    expect(result.baseUrl).toBe("https://custom.endpoint/v1");
    expect(result.apiKey).toBe("resolved-from-env");
    expect(result.model).toBe("my-model");
  });

  it("resolves apiKey from __env__:VAR and secretref-env:VAR markers", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          p1: {
            baseUrl: "https://p1.endpoint/v1",
            apiKey: "__env__:MY_P1_KEY",
            models: [],
          },
          p2: {
            baseUrl: "https://p2.endpoint/v1",
            apiKey: "secretref-env:MY_P2_KEY",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const env = {
      MY_P1_KEY: "val1",
      MY_P2_KEY: "val2",
    } as NodeJS.ProcessEnv;

    const res1 = resolveQmdEndpoint(
      { model: "p1/mod" },
      { openClawConfig: mockConfig, env },
    );
    const res2 = resolveQmdEndpoint(
      { model: "p2/mod" },
      { openClawConfig: mockConfig, env },
    );

    expect(res1.apiKey).toBe("val1");
    expect(res2.apiKey).toBe("val2");
  });

  it("resolves apiKey from SecretRef objects", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          vaultProvider: {
            baseUrl: "https://vault.endpoint/v1",
            apiKey: { source: "env", id: "VAULT_API_TOKEN" },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const env = { VAULT_API_TOKEN: "token-abc" } as NodeJS.ProcessEnv;

    const result = resolveQmdEndpoint(
      { model: "vaultProvider/embed-v1" },
      { openClawConfig: mockConfig, env },
    );

    expect(result.apiKey).toBe("token-abc");
  });

  it("falls back to well-known default baseUrls and environment variables", () => {
    const env = {
      OPENAI_API_KEY: "openai-test-key",
      OLLAMA_API_KEY: "ollama-key",
    } as NodeJS.ProcessEnv;

    const openaiRes = resolveQmdEndpoint(
      { model: "openai/text-embedding-3-small" },
      { env },
    );
    expect(openaiRes.baseUrl).toBe("https://api.openai.com/v1");
    expect(openaiRes.model).toBe("text-embedding-3-small");
    expect(openaiRes.apiKey).toBe("openai-test-key");

    const ollamaRes = resolveQmdEndpoint(
      { model: "ollama/nomic-embed-text" },
      { env },
    );
    expect(ollamaRes.baseUrl).toBe("http://localhost:11434/v1");
    expect(ollamaRes.model).toBe("nomic-embed-text");
    expect(ollamaRes.apiKey).toBe("ollama-key");
  });

  it("handles model names containing additional slashes (e.g. openrouter/anthropic/claude-3.5)", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "or-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      { model: "openrouter/anthropic/claude-3.5-sonnet" },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(result.model).toBe("anthropic/claude-3.5-sonnet");
    expect(result.apiKey).toBe("or-key");
  });

  it("allows user to override baseUrl while resolving apiKey from provider", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "auto-resolved-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      {
        baseUrl: "https://my-custom-proxy.internal/v1",
        model: "openai/text-embedding-3-small",
      },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe("https://my-custom-proxy.internal/v1");
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.apiKey).toBe("auto-resolved-key");
  });

  it("returns empty baseUrl when provider cannot be resolved and no default exists", () => {
    const result = resolveQmdEndpoint({
      model: "unknown-corp/some-model",
    });

    expect(result.baseUrl).toBe("");
    expect(result.model).toBe("some-model");
    expect(result.apiKey).toBeUndefined();
  });

  it("supports bifrost / bitfrost alias matching", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          bifrost: {
            baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
            apiKey: "bifrost-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      { model: "bitfrost/text-embedding-3-small" },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe(
      "https://bifrost.home-infra.weii.cloud/openai/v1",
    );
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.apiKey).toBe("bifrost-key");
  });

  it("auto-discovers provider when model ID matches a model defined under an OpenClaw provider", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          bifrost: {
            baseUrl: "https://bifrost.home-infra.weii.cloud/openai/v1",
            apiKey: "bifrost-key",
            models: [{ id: "text-embedding-3-small" } as never],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      { model: "text-embedding-3-small" },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe(
      "https://bifrost.home-infra.weii.cloud/openai/v1",
    );
    expect(result.model).toBe("text-embedding-3-small");
    expect(result.apiKey).toBe("bifrost-key");
  });

  it("uses defaultDimension when dimension is not explicitly provided in raw input", () => {
    const result = resolveQmdEndpoint(
      { model: "openai/text-embedding-3-small" },
      { defaultDimension: 1536 },
    );

    expect(result.dimension).toBe(1536);
  });

  it("prioritizes model-specific baseUrl from provider models array over provider baseUrl", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "or-general-key",
            models: [
              {
                id: "typesafe/jev-latest",
                baseUrl: "https://openrouter.ai/api",
                apiKey: "or-jev-key",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      { model: "openrouter/typesafe/jev-latest" },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe("https://openrouter.ai/api");
    expect(result.model).toBe("typesafe/jev-latest");
    expect(result.apiKey).toBe("or-jev-key");
  });

  it("prioritizes model-specific baseUrl from provider models object map over provider baseUrl", () => {
    const mockConfig: OpenClawConfig = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "or-general-key",
            models: {
              "typesafe/jev-1.13": {
                baseUrl: "https://custom.openrouter.proxy/api",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveQmdEndpoint(
      { model: "openrouter/typesafe/jev-1.13" },
      { openClawConfig: mockConfig },
    );

    expect(result.baseUrl).toBe("https://custom.openrouter.proxy/api");
    expect(result.model).toBe("typesafe/jev-1.13");
    expect(result.apiKey).toBe("or-general-key");
  });
});

describe("normalizeEmbeddingModel", () => {
  it("strips provider prefix from provider/model format", () => {
    expect(normalizeEmbeddingModel("bifrost/text-embedding-3-small")).toBe(
      "text-embedding-3-small",
    );
    expect(normalizeEmbeddingModel("openai/text-embedding-3-small")).toBe(
      "text-embedding-3-small",
    );
  });

  it("leaves plain model names unchanged", () => {
    expect(normalizeEmbeddingModel("text-embedding-3-small")).toBe(
      "text-embedding-3-small",
    );
  });

  it("handles undefined and empty string", () => {
    expect(normalizeEmbeddingModel(undefined)).toBe("");
    expect(normalizeEmbeddingModel("")).toBe("");
  });
});

describe("isJevModel", () => {
  it("recognizes valid TypeSafe Jev model references", () => {
    expect(isJevModel("typesafe/jev-latest")).toBe(true);
    expect(isJevModel("jev-latest")).toBe(true);
    expect(isJevModel("jev")).toBe(true);
    expect(isJevModel("openrouter/typesafe/jev-1.13")).toBe(true);
    expect(isJevModel("typesafe/my-custom-model")).toBe(true);
  });

  it("does not inadvertently match unrelated model names with 'jev' substrings", () => {
    expect(isJevModel("jeven-7b")).toBe(false);
    expect(isJevModel("openrouter/jeven-7b")).toBe(false);
    expect(isJevModel("huggingface/jevic-model")).toBe(false);
    expect(isJevModel("my-jeven-model")).toBe(false);
    expect(isJevModel("openai/gpt-4o")).toBe(false);
    expect(isJevModel("deepseek-ai/DeepSeek-V3")).toBe(false);
    expect(isJevModel(undefined)).toBe(false);
  });
});

describe("normalizeTypeSafeBaseUrl", () => {
  it("strips /v1 and /v1/systemone from base URLs", () => {
    expect(
      normalizeTypeSafeBaseUrl("https://openrouter.ai/api/v1/systemone"),
    ).toBe("https://openrouter.ai/api");
    expect(normalizeTypeSafeBaseUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api",
    );
    expect(normalizeTypeSafeBaseUrl("https://api.typesafe.ai/v1/")).toBe(
      "https://api.typesafe.ai",
    );
    expect(normalizeTypeSafeBaseUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
    expect(normalizeTypeSafeBaseUrl(undefined)).toBeUndefined();
  });
});

describe("buildStoreModels", () => {
  const baseConfig: ResolvedQmdConfig = {
    embedding: {
      baseUrl: "https://embed.example.com",
      model: "text-embedding-3",
      apiKey: "embed-key",
      dimension: 1536,
    },
    expansion: {
      baseUrl: "https://expand.example.com",
      model: "gpt-4o-mini",
      apiKey: "expand-key",
    },
    timeoutMs: 15000,
    indexRefreshIntervalSeconds: 300,
  };

  it.each([undefined, "", "   "])(
    "omits an unset or blank cache directory: %s",
    (embeddingCacheDir) => {
      expect(
        buildStoreModels({ ...baseConfig, embeddingCacheDir }),
      ).not.toHaveProperty("embed_cache_dir");
    },
  );

  it("passes a shared cache directory and native Voyage settings to QMD", () => {
    const models = buildStoreModels({
      ...baseConfig,
      embeddingCacheDir: "  /dev/shm/shared-embeddings  ",
      embedding: {
        baseUrl: "https://api.voyageai.com/v1",
        model: "voyage-4",
        apiKey: "voyage-key",
        dimension: 1024,
      },
    });
    expect(models).toMatchObject({
      embed_cache_dir: "/dev/shm/shared-embeddings",
      embed_api_url: "https://api.voyageai.com/v1",
      embed_api_model: "voyage-4",
      embed_api_key: "voyage-key",
      embed_dimension: 1024,
    });
    expect(models).not.toHaveProperty("embed_provider");
  });

  it("resolves Jev endpoint when config.jev has only baseUrl and no model", () => {
    const config: ResolvedQmdConfig = {
      ...baseConfig,
      jev: {
        baseUrl: "http://proxy.local/v1",
      } as any,
    };

    const models = buildStoreModels(config);
    expect(models.jev_base_url).toBe("http://proxy.local/v1");
    expect(models.jev_api_model).toBeUndefined();
    expect(models.embed_api_url).toBe("https://embed.example.com");
  });

  it("resolves Jev endpoint from expansion when expansion.model is a Jev model", () => {
    const config: ResolvedQmdConfig = {
      ...baseConfig,
      expansion: {
        baseUrl: "https://api.typesafe.ai/v1",
        model: "typesafe/jev-latest",
        apiKey: "jev-key",
      },
    };

    const models = buildStoreModels(config);
    expect(models.jev_base_url).toBe("https://api.typesafe.ai/v1");
    expect(models.jev_api_model).toBe("typesafe/jev-latest");
    expect(models.jev_api_key).toBe("jev-key");
  });

  it("does not populate Jev store models when no Jev config or model is present", () => {
    const models = buildStoreModels(baseConfig);
    expect(models).not.toHaveProperty("jev_base_url");
    expect(models).not.toHaveProperty("jev_api_model");
    expect(models).not.toHaveProperty("jev_api_key");
  });
});
