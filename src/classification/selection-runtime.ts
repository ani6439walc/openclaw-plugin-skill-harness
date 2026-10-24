import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";

const hostUnavailableReasons = new Set<string>([
  "credentials-unavailable",
  "authentication",
  "rate-limited",
  "transport",
  "unsupported-input",
  "invalid-response",
  "disabled",
  "not-configured",
  "retiring",
  "overloaded",
  "circuit-open",
  "deadline",
]);

export function selectDecisionRoute(
  agentModel: unknown,
  getGlobalModel: () => unknown,
): "host" | "legacy" {
  if (typeof agentModel === "string")
    return agentModel.trim() ? "host" : "legacy";
  const globalModel = getGlobalModel();
  return typeof globalModel === "string" && globalModel.trim()
    ? "host"
    : "legacy";
}

/** Check finite data before serialization, without invoking evidence getters. */
function supportedInput(batch: DecisionBatch): boolean {
  let nodes = 0;
  let stringBytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 32) return false;
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
      return stringBytes <= 1_048_576;
    }
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== null && prototype !== Object.prototype
    )
      return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    ancestors.add(value);
    try {
      const keys = Object.getOwnPropertyNames(value);
      if (array && keys.length !== value.length + 1) return false;
      for (const key of keys) {
        if (array && key === "length") continue;
        stringBytes += Buffer.byteLength(key, "utf8");
        if (stringBytes > 1_048_576) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !descriptor?.enumerable ||
          !("value" in descriptor) ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
      return true;
    } finally {
      ancestors.delete(value);
    }
  };
  if (!visit(batch, 0)) return false;
  const questionCount = Object.keys(batch.questions).length;
  return (
    questionCount > 0 &&
    questionCount <= 256 &&
    Buffer.byteLength(JSON.stringify(batch), "utf8") <= 1_048_576
  );
}

export async function evaluateSelection(params: {
  api: OpenClawPluginApi;
  agentId: string;
  batch: DecisionBatch;
  signal: AbortSignal;
  timeoutMs: number;
  assertActive?: () => void;
  legacy?: () => Promise<unknown>;
}): Promise<unknown | undefined> {
  params.signal.throwIfAborted();
  try {
    params.assertActive?.();
    if (!supportedInput(params.batch)) {
      logger.warn("selection unavailable reason=unsupported-input");
      return undefined;
    }
    const config = params.api.config;
    const route = selectDecisionRoute(
      resolveAgentConfig(config, params.agentId)?.decisionModel,
      () => config.agents?.defaults?.decisionModel,
    );
    params.signal.throwIfAborted();
    params.assertActive?.();
    if (route === "legacy") {
      const result = await params.legacy?.();
      params.signal.throwIfAborted();
      params.assertActive?.();
      return result;
    }
    const outcome = await params.api.runtime.decisions.evaluate(params.batch, {
      agentId: params.agentId,
      purpose: "skill-harness.unified-selection",
      rubricVersion: "1",
      timeoutMs: Math.min(params.timeoutMs, 30_000),
      signal: params.signal,
    });
    params.signal.throwIfAborted();
    params.assertActive?.();
    if (outcome?.status === "ok") return outcome.result;
    const reason =
      outcome?.status === "unavailable" &&
      hostUnavailableReasons.has(outcome.reason)
        ? outcome.reason
        : "invalid-response";
    logger.warn(
      `selection unavailable route=host reason=${reason} questionCount=${Object.keys(params.batch.questions).length}`,
    );
    return undefined;
  } catch {
    params.signal.throwIfAborted();
    logger.warn("selection unavailable reason=operation-failed");
    return undefined;
  }
}
