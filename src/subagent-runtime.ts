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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatEmbeddedError(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (!isRecord(error)) return;

  const message =
    typeof error.message === "string" ? error.message.trim() : undefined;
  const kind = typeof error.kind === "string" ? error.kind.trim() : undefined;
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
