import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVOLUTION_OPERATIONS,
  markPendingProcessed,
  readBacklog,
  selectPendingItem,
  updatePendingTarget,
  writeBacklogAtomic,
  type EvolutionOperation,
} from "./evolution-backlog.js";
import { validateIntentDirectory } from "./intent-validation.js";

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

export function runBacklogCli(
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
    const backlogPath = path.join(pluginRoot, "sessions", "evolution.json");
    if (!command)
      throw new Error(
        "usage: backlog <list|show|set-target|validate-intents|mark-processed>",
      );

    if (command === "validate-intents") {
      const result = validateIntentDirectory(
        path.join(pluginRoot, "intents"),
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
      const id = requireOption(args, "--id");
      markPendingProcessed(
        backlog,
        id,
        requireOption(args, "--expected-updated-at"),
        nowIso(),
      );
      writeBacklogAtomic(backlogPath, backlog);
      io.stdout(
        JSON.stringify(
          backlog.items.find((item) => item.id === id),
          null,
          2,
        ),
      );
      return 0;
    }

    throw new Error(`unknown backlog command: ${command}`);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const pluginRoot = path.resolve(path.dirname(currentFile), "..", "..");
  process.exitCode = runBacklogCli(process.argv.slice(2), pluginRoot);
}
