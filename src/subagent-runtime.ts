import type { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "./guards.js";

/**
 * Executes a background task detached from OpenClaw's turn-scoped AsyncWorkScope.
 *
 * OpenClaw tracks turns via AsyncWorkScope in an AsyncLocalStorage singleton.
 * Background review tasks run after the turn finishes, at which point the parent
 * AsyncWorkScope has already drained and transitioned to 'closed'. If the background
 * task inherits that closed scope, calling runEmbeddedAgent immediately throws
 * "Async work scope is closed".
 *
 * Exiting openclaw.asyncWorkScope allows the subagent to establish its own root
 * AsyncWorkScope while preserving other runtime contexts like pluginRuntimeGatewayRequestScope.
 */
export function runDetachedFromWorkScope<T>(fn: () => T): T {
  const scopeKey = Symbol.for("openclaw.asyncWorkScope");
  const scopeStorage = (globalThis as Record<symbol, unknown>)[scopeKey] as
    AsyncLocalStorage<unknown> | undefined;

  if (scopeStorage && typeof scopeStorage.exit === "function") {
    return scopeStorage.exit(fn);
  }
  return fn();
}

export function buildEmbeddedSubagentRunDefaults() {
  return {
    trigger: "manual" as const,
    disableMessageTool: true,
    allowGatewaySubagentBinding: true,
    bootstrapContextMode: "lightweight" as const,
    verboseLevel: "off" as const,
    reasoningLevel: "off" as const,
    silentExpected: true,
    authProfileFailurePolicy: "local" as const,
    cleanupBundleMcpOnRunEnd: true,
  };
}

export function isGatewayDrainingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === "GatewayDrainingError" ||
    candidate.message === "Gateway is draining; new tasks are not accepted" ||
    candidate.message === "gateway is draining for restart"
  );
}

export function isGatewayDraining(): boolean {
  try {
    const admissionKey = Symbol.for("openclaw.gatewayWorkAdmissionState");
    const state = (globalThis as Record<symbol, unknown>)[admissionKey] as
      { restartDraining?: boolean } | undefined;
    return state?.restartDraining === true;
  } catch {
    return false;
  }
}

export function formatEmbeddedError(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return;
  }
  const errorFields = error as { message?: unknown; kind?: unknown };

  const message =
    typeof errorFields.message === "string"
      ? errorFields.message.trim()
      : undefined;
  const kind =
    typeof errorFields.kind === "string" ? errorFields.kind.trim() : undefined;
  if (kind && message) return `${kind}: ${message}`;
  return message || kind || undefined;
}

export function extractEmbeddedRunError(result: {
  payloads?: unknown[];
  meta?: unknown;
}): string | undefined {
  const errorPayload = (result.payloads ?? [])
    .filter(isRecord)
    .find((payload) => payload.isError === true);
  if (errorPayload) {
    const payloadText =
      typeof errorPayload.text === "string" ? errorPayload.text.trim() : "";
    return payloadText || "embedded agent returned an error payload";
  }

  if (!isRecord(result.meta)) return;
  return formatEmbeddedError(result.meta.error);
}
