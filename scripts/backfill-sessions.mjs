#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginRuntime } from "../node_modules/openclaw/dist/plugins/runtime/index.js";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { BacklogWriter } from "../dist/src/backlog-writer.js";
import { readBacklog } from "../dist/src/evolution-backlog.js";
import { IntentCatalog } from "../dist/src/intent-loader.js";
import { runReviewSubagent } from "../dist/src/review-subagent.js";
import { StatsAggregator } from "../dist/src/stats-aggregator.js";
import { getReviewModelRef } from "../dist/src/subagent.js";
import { checkEvolutionTriggers } from "../dist/src/trigger-checker.js";
import { resolveConfig } from "../dist/src/config.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const sessionsDir = path.join(pluginRoot, "sessions");
const reserved = new Set(["stats.json", "evolution.json"]);

function parseArgs(args) {
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const limit = option("--limit");
  return {
    dryRun: args.includes("--dry-run"),
    stats: !args.includes("--evolution-only"),
    evolution: !args.includes("--stats-only"),
    confirmExternalReview: args.includes("--confirm-external-review"),
    limit: limit === undefined ? Infinity : Number.parseInt(limit, 10),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function copyIfExists(source, destination) {
  if (fs.existsSync(source)) fs.copyFileSync(source, destination);
}

function createBackup() {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupDir = path.join(
    "/tmp",
    "intention-hint-session-backfill",
    stamp,
  );
  fs.mkdirSync(backupDir, { recursive: true });
  copyIfExists(
    path.join(sessionsDir, "stats.json"),
    path.join(backupDir, "stats.json"),
  );
  copyIfExists(
    path.join(sessionsDir, "evolution.json"),
    path.join(backupDir, "evolution.json"),
  );
  return backupDir;
}

function loadSessions() {
  return fs
    .readdirSync(sessionsDir)
    .filter((file) => file.endsWith(".json") && !reserved.has(file))
    .sort()
    .map((file) => readJson(path.join(sessionsDir, file)));
}

function completedStates(session) {
  return [...(session.history ?? []), session.current].filter(
    (state) => state?.intent?.result && state.timestamps?.start,
  );
}

function intentId(value) {
  return value?.match(/^([A-Za-z0-9_-]+)/)?.[1];
}

function findIntent(catalog, value) {
  const id = intentId(value);
  return id
    ? catalog.find((definition) => definition.id.toLowerCase() === id.toLowerCase())
    : undefined;
}

function truncate(value, maxChars) {
  return value?.slice(0, maxChars);
}

function reviewState(state) {
  return {
    input: truncate(state.input, 1000),
    intent: state.intent?.result ? { ...state.intent.result } : undefined,
    skillsUsed: state.skillsUsed?.map((skill) => skill.name),
    toolCalls: state.toolCalls?.map((call) => ({
      name: call.name,
      error: truncate(call.error, 500),
      durationMs: call.durationMs,
    })),
    result: truncate(state.result, 1500),
    error: truncate(state.error, 500),
    timestamps: state.timestamps ? { ...state.timestamps } : undefined,
  };
}

function buildEvents(sessions, catalog, config) {
  const compactCatalog = catalog.map(({ id, name, triggers, examples }) => ({
    id,
    name,
    triggers: [...triggers],
    examples: [...examples],
  }));
  return sessions
    .flatMap((session) => {
      const states = completedStates(session);
      return states.map((state, index) => {
        const matchedIntent = findIntent(catalog, state.intent.result.intent);
        const snapshot = {
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          eventId: `${session.sessionId}:${state.timestamps.start}`,
          turnNumber: index + 1,
          current: reviewState(state),
          recent: states
            .slice(Math.max(0, index - 9), index)
            .map(reviewState),
          matchedIntent: matchedIntent
            ? {
                ...matchedIntent,
                triggers: [...matchedIntent.triggers],
                examples: [...matchedIntent.examples],
              }
            : undefined,
          intentCatalog: compactCatalog,
        };
        return {
          session,
          state,
          matchedIntent,
          snapshot,
          triggers: checkEvolutionTriggers(
            snapshot.current,
            snapshot.turnNumber,
            config.selfEvolution.triggers,
          ),
        };
      });
    })
    .sort((a, b) =>
      a.state.timestamps.start.localeCompare(b.state.timestamps.start),
    );
}

function existingProcessed(fileName) {
  const filePath = path.join(sessionsDir, fileName);
  if (!fs.existsSync(filePath)) return new Set();
  const data =
    fileName === "evolution.json" ? readBacklog(filePath) : readJson(filePath);
  return new Set(Object.keys(data.processedEvents ?? {}));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(options.limit) && options.limit !== Infinity) {
    throw new Error("--limit must be an integer");
  }
  if (
    options.evolution &&
    !options.dryRun &&
    !options.confirmExternalReview
  ) {
    throw new Error(
      "Evolution backfill sends bounded historical review snapshots to the configured external review model. Re-run with --confirm-external-review after explicit approval.",
    );
  }

  const openClawConfig = loadConfig();
  const pluginConfig =
    resolvePluginConfigObject(openClawConfig, "intention-hint") ?? {};
  const config = resolveConfig(pluginConfig);
  const catalogLoader = IntentCatalog.create(pluginRoot);
  catalogLoader.load(config.intentsDir ?? "./intents", { silent: true });
  const catalog = [...catalogLoader.get()];
  const sessions = loadSessions();
  const events = buildEvents(sessions, catalog, config);
  const statsProcessed = existingProcessed("stats.json");
  const evolutionProcessed = existingProcessed("evolution.json");
  const statsCandidates = events.filter(
    ({ snapshot }) => !statsProcessed.has(snapshot.eventId),
  );
  const evolutionCandidates = events.filter(
    ({ snapshot, triggers }) =>
      triggers.length > 0 && !evolutionProcessed.has(snapshot.eventId),
  );

  const summary = {
    dryRun: options.dryRun,
    sessionFiles: sessions.length,
    eligibleTurns: events.length,
    statsAlreadyProcessed: events.length - statsCandidates.length,
    statsCandidates: statsCandidates.length,
    evolutionAlreadyProcessed:
      events.filter(({ triggers }) => triggers.length > 0).length -
      evolutionCandidates.length,
    evolutionCandidates: evolutionCandidates.length,
    evolutionTriggerHits: evolutionCandidates.reduce(
      (total, event) => total + event.triggers.length,
      0,
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (options.dryRun) return;

  const backupDir = createBackup();
  const report = {
    ...summary,
    backupDir,
    startedAt: new Date().toISOString(),
    stats: { recorded: 0, skippedOrFailed: 0 },
    evolution: { reviewed: 0, recorded: 0, failed: 0 },
  };

  if (options.stats) {
    const aggregator = StatsAggregator.create(pluginRoot);
    for (const event of statsCandidates.slice(0, options.limit)) {
      const recorded = aggregator.record(
        event.session.sessionId,
        event.state,
        event.matchedIntent,
      );
      if (recorded) report.stats.recorded += 1;
      else report.stats.skippedOrFailed += 1;
    }
    console.log(`stats recorded: ${report.stats.recorded}`);
  }

  if (options.evolution) {
    const runtime = createPluginRuntime();
    const api = {
      config: openClawConfig,
      pluginConfig,
      runtime: {
        ...runtime,
        config: { current: () => openClawConfig },
      },
    };
    const writer = BacklogWriter.create(pluginRoot);
    for (const [index, event] of evolutionCandidates
      .slice(0, options.limit)
      .entries()) {
      const agentId = event.session.agentId ?? "main";
      const modelRef = getReviewModelRef(api, agentId, config, {});
      if (!modelRef) {
        report.evolution.failed += 1;
        console.error(`no review model for ${event.snapshot.eventId}`);
        continue;
      }
      console.log(
        `review ${index + 1}/${Math.min(evolutionCandidates.length, options.limit)} ${event.snapshot.eventId} [${event.triggers.join(",")}]`,
      );
      const findings = await runReviewSubagent({
        api,
        config,
        agentId,
        sessionKey: event.session.sessionKey,
        modelRef,
        snapshot: event.snapshot,
        triggers: event.triggers,
      });
      report.evolution.reviewed += 1;
      if (!findings) {
        report.evolution.failed += 1;
        continue;
      }
      const recorded = writer.record(
        event.snapshot.eventId,
        {
          sessionId: event.session.sessionId,
          sessionKey: event.session.sessionKey,
          agentId: event.session.agentId,
          turnStart: event.state.timestamps.start,
        },
        findings,
      );
      if (recorded) report.evolution.recorded += 1;
      else report.evolution.failed += 1;
    }
  }

  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(backupDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

await main();
