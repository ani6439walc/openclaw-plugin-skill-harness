import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  evolutionBacklogPath,
  intentsPath,
  resolvePluginDataRoot,
} from "./file-utils.js";
import {
  EVOLUTION_OPERATIONS,
  markPendingDismissed,
  markPendingProcessed,
  readBacklog,
  selectPendingItem,
  updatePendingTarget,
  writeBacklogAtomic,
  type EvolutionOperation,
} from "./evolution-backlog.js";
import { validateIntentDirectory } from "./intent-validation.js";

const PLUGIN_ID = "intention-hint";

type CliIo = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) =>
    arg === name && args[index + 1] ? [args[index + 1]] : [],
  );
}

function requireOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function markAndWriteItem(params: {
  args: string[];
  backlog: ReturnType<typeof readBacklog>;
  backlogPath: string;
  io: CliIo;
  mark: (
    backlog: ReturnType<typeof readBacklog>,
    id: string,
    expectedUpdatedAt: string,
    nowIso: string,
  ) => unknown;
}): number {
  const id = requireOption(params.args, "--id");
  params.mark(
    params.backlog,
    id,
    requireOption(params.args, "--expected-updated-at"),
    nowIso(),
  );
  writeBacklogAtomic(params.backlogPath, params.backlog);
  params.io.stdout(
    JSON.stringify(
      params.backlog.items.find((item) => item.id === id),
      null,
      2,
    ),
  );
  return 0;
}

export function resolveDefaultEvolutionBacklogRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePluginDataRoot(resolveStateDir(env), PLUGIN_ID);
}

export function runEvolutionBacklogCommand(
  rawArgs: string[],
  pluginRoot: string,
  io: CliIo = {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  },
): number {
  try {
    const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
    const command = args[0];
    const backlogPath = evolutionBacklogPath(pluginRoot);
    if (!command)
      throw new Error(
        "usage: evolution-backlog <list|show|set-target|validate-intents|mark-processed|mark-dismissed>",
      );

    if (command === "validate-intents") {
      const result = validateIntentDirectory(
        intentsPath(pluginRoot),
        options(args, "--id"),
      );
      io.stdout(JSON.stringify(result, null, 2));
      return result.valid ? 0 : 1;
    }

    if (!fs.existsSync(backlogPath))
      throw new Error(`backlog not found: ${backlogPath}`);
    const backlog = readBacklog(backlogPath);

    if (command === "list") {
      const items = backlog.items
        .filter((item) => item.status === "pending")
        .sort(
          (a, b) =>
            b.frequency - a.frequency ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      io.stdout(
        args.includes("--json")
          ? JSON.stringify(items, null, 2)
          : items
              .map(
                (item) =>
                  `${item.id}\t${item.frequency}\t${item.operation}\t${item.summary}`,
              )
              .join("\n"),
      );
      return 0;
    }

    if (command === "show") {
      const item = selectPendingItem(backlog, option(args, "--id"));
      if (!item) throw new Error("pending backlog item not found");
      io.stdout(JSON.stringify(item, null, 2));
      return 0;
    }

    if (command === "set-target") {
      const id = requireOption(args, "--id");
      const operation = requireOption(args, "--operation");
      if (!EVOLUTION_OPERATIONS.includes(operation as EvolutionOperation)) {
        throw new Error(`invalid operation: ${operation}`);
      }
      const targets = options(args, "--target-intent");
      updatePendingTarget(
        backlog,
        id,
        operation as EvolutionOperation,
        targets,
        nowIso(),
      );
      writeBacklogAtomic(backlogPath, backlog);
      io.stdout(JSON.stringify(selectPendingItem(backlog, id), null, 2));
      return 0;
    }

    if (command === "mark-processed") {
      return markAndWriteItem({
        args,
        backlog,
        backlogPath,
        io,
        mark: markPendingProcessed,
      });
    }

    if (command === "mark-dismissed") {
      return markAndWriteItem({
        args,
        backlog,
        backlogPath,
        io,
        mark: markPendingDismissed,
      });
    }

    throw new Error(`unknown backlog command: ${command}`);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = runEvolutionBacklogCommand(
    process.argv.slice(2),
    resolveDefaultEvolutionBacklogRoot(),
  );
}
