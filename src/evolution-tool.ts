import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { runEvolutionBacklogAction } from "./evolution-backlog-actions.js";
import type { EvolutionBacklogAction } from "./evolution-backlog-actions.js";
import type { EvolutionOperation } from "./evolution-backlog.js";

const TOOL_NAME = "intention_hint_evolution";

const EVOLUTION_ACTIONS = [
  "list",
  "show",
  "review-health",
  "set-target",
  "validate-intents",
  "mark-processed",
  "mark-dismissed",
] as const;

const EVOLUTION_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: EVOLUTION_ACTIONS,
      description: "Evolution backlog operation to run.",
    },
    id: {
      type: "string",
      description:
        "Backlog item ID for show, set-target, mark-processed, or mark-dismissed.",
    },
    operation: {
      type: "string",
      enum: ["create", "refine", "split", "merge"],
      description: "Resolved intent-markdown operation for set-target.",
    },
    targetIntentIds: {
      type: "array",
      items: { type: "string" },
      description: "Target intent IDs for set-target.",
    },
    expectedUpdatedAt: {
      type: "string",
      description:
        "Optimistic-concurrency timestamp from the selected backlog item.",
    },
    days: {
      type: "number",
      description: "Review-health lookback window in days. Defaults to 7.",
    },
    now: {
      type: "string",
      description: "Optional ISO-like timestamp used by review-health tests.",
    },
    ids: {
      type: "array",
      items: { type: "string" },
      description: "Intent IDs to validate for validate-intents.",
    },
  },
  required: ["action"],
} as AnyAgentTool["parameters"];

function jsonToolResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key);
  if (!value) throw new Error(`missing required parameter: ${key}`);
  return value;
}

function stringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function optionalNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`${key} must be a number`);
  return value;
}

export function parseEvolutionToolAction(
  params: unknown,
): EvolutionBacklogAction {
  const record = asRecord(params);
  const action = requiredString(record, "action");

  if (action === "list") return { action };
  if (action === "show") return { action, id: optionalString(record, "id") };
  if (action === "review-health") {
    return {
      action,
      days: optionalNumber(record, "days"),
      now: optionalString(record, "now"),
    };
  }
  if (action === "set-target") {
    return {
      action,
      id: requiredString(record, "id"),
      operation: requiredString(record, "operation") as EvolutionOperation,
      targetIntentIds: stringArray(record, "targetIntentIds"),
    };
  }
  if (action === "validate-intents") {
    return { action, ids: stringArray(record, "ids") };
  }
  if (action === "mark-processed") {
    return {
      action,
      id: requiredString(record, "id"),
      expectedUpdatedAt: requiredString(record, "expectedUpdatedAt"),
    };
  }
  if (action === "mark-dismissed") {
    return {
      action,
      id: requiredString(record, "id"),
      expectedUpdatedAt: requiredString(record, "expectedUpdatedAt"),
    };
  }
  throw new Error(`unknown evolution action: ${action}`);
}

export function createEvolutionTool(dataRoot: string): AnyAgentTool {
  return {
    name: TOOL_NAME,
    label: "Intention Hint Evolution",
    description:
      "List, inspect, validate, target, and mark Intention Hint Evolution backlog items in the plugin runtime data root.",
    parameters: EVOLUTION_TOOL_PARAMETERS,
    async execute(_toolCallId, params) {
      const action = parseEvolutionToolAction(params);
      return jsonToolResult(runEvolutionBacklogAction({ action, dataRoot }));
    },
  };
}

export const EVOLUTION_TOOL_NAME = TOOL_NAME;
