import type { OpenClawPluginApi } from "../api.js";
import {
  runEvolutionBacklogAction,
  type EvolutionBacklogAction,
} from "./evolution-backlog-actions.js";
import type { EvolutionOperation } from "./evolution-backlog.js";

type PluginCommandDefinition = Parameters<
  OpenClawPluginApi["registerCommand"]
>[0];
type PluginCommandResult = Awaited<
  ReturnType<PluginCommandDefinition["handler"]>
>;

const HELP_TEXT = [
  "/skill-harness evolution list",
  "/skill-harness evolution show [--id <item-id>]",
  "/skill-harness evolution review-health [--days 7]",
  "/skill-harness evolution validate-intents [intent-id ...]",
  "/skill-harness evolution set-target --id <item-id> --operation <create|refine|split|merge> --target-intent <intent-id>",
  "/skill-harness evolution mark-processed --id <item-id> --expected-updated-at <timestamp>",
  "/skill-harness evolution mark-dismissed --id <item-id> --expected-updated-at <timestamp>",
].join("\n");

const VALUE_OPTIONS = new Set([
  "--days",
  "--expected-updated-at",
  "--id",
  "--now",
  "--operation",
  "--target-intent",
]);

function splitArgs(input: string | undefined): string[] {
  if (!input) return [];
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|\S+/g;
  for (const match of input.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) =>
    arg === name && args[index + 1] && !args[index + 1].startsWith("--")
      ? [args[index + 1]]
      : [],
  );
}

function requireOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      const consumesValue =
        VALUE_OPTIONS.has(args[index]) && !args[index + 1]?.startsWith("--");
      if (consumesValue) index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function parseEvolutionCommandAction(args: string[]): EvolutionBacklogAction {
  const command = args[0] ?? "help";

  if (command === "list") return { action: "list" };
  if (command === "show") return { action: "show", id: option(args, "--id") };
  if (command === "review-health") {
    const days = Number(option(args, "--days") ?? 7);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error("--days must be a positive number");
    }
    const now = option(args, "--now");
    if (now && Number.isNaN(Date.parse(now))) {
      throw new Error("--now must be a valid date/time");
    }
    return { action: "review-health", days, now };
  }
  if (command === "validate-intents") {
    const flagIds = options(args, "--id");
    const positionalIds = positionalArgs(args);
    return { action: "validate-intents", ids: [...flagIds, ...positionalIds] };
  }
  if (command === "set-target") {
    return {
      action: "set-target",
      id: requireOption(args, "--id"),
      operation: requireOption(args, "--operation") as EvolutionOperation,
      targetIntentIds: options(args, "--target-intent"),
    };
  }
  if (command === "mark-processed") {
    return {
      action: "mark-processed",
      id: requireOption(args, "--id"),
      expectedUpdatedAt: requireOption(args, "--expected-updated-at"),
    };
  }
  if (command === "mark-dismissed") {
    return {
      action: "mark-dismissed",
      id: requireOption(args, "--id"),
      expectedUpdatedAt: requireOption(args, "--expected-updated-at"),
    };
  }
  throw new Error(`unknown evolution command: ${command}`);
}

function formatCommandActionResult(
  action: EvolutionBacklogAction,
  result: unknown,
): string {
  if (action.action === "list") {
    const items = Array.isArray(result) ? result : [];
    return items.length
      ? items
          .map((item) => {
            const record = item as Record<string, unknown>;
            return `${record.id}\t${record.frequency}\t${record.operation}\t${record.summary}`;
          })
          .join("\n")
      : "No pending evolution backlog items.";
  }
  return JSON.stringify(result, null, 2);
}

function commandResult(text: string): PluginCommandResult {
  return { text, continueAgent: false };
}

export function handleEvolutionCommand(params: {
  args?: string;
  dataRoot: string;
}): PluginCommandResult {
  const [namespace, ...rest] = splitArgs(params.args);
  if (!namespace || namespace === "help") return commandResult(HELP_TEXT);
  if (namespace !== "evolution") {
    return commandResult(
      `Unknown /skill-harness command: ${namespace}\n\n${HELP_TEXT}`,
    );
  }
  if (rest.length === 0 || rest[0] === "help") return commandResult(HELP_TEXT);

  try {
    const action = parseEvolutionCommandAction(rest);
    const result = runEvolutionBacklogAction({
      action,
      dataRoot: params.dataRoot,
    });
    if (!result.ok) throw new Error(result.error);
    return commandResult(formatCommandActionResult(action, result.result));
  } catch (error) {
    return commandResult(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createEvolutionCommand(
  dataRoot: string,
): PluginCommandDefinition {
  return {
    name: "skill-harness",
    description: "Manage Skill Harness plugin workflows.",
    acceptsArgs: true,
    handler: async (ctx) =>
      handleEvolutionCommand({ args: ctx.args, dataRoot }),
  };
}
