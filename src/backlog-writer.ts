import * as path from "node:path";
import { logger } from "../api.js";
import { pluginRoot, fileExists, safeWriteJson } from "./file-utils.js";
import type { EvolutionFinding, EvolutionSource } from "./evolution-types.js";
import {
  createBacklog,
  readBacklog,
  EvolutionBacklogSchema,
  type EvolutionBacklog,
} from "./evolution-backlog.js";

function nextItemId(backlog: EvolutionBacklog, nowIso: string): string {
  const date = nowIso.slice(0, 10).replaceAll("-", "");
  const prefix = `IMP-${date}-`;
  const sequence =
    Math.max(
      0,
      ...backlog.items.map((item) => {
        const suffix = item.id.startsWith(prefix)
          ? Number(item.id.slice(prefix.length))
          : 0;
        return Number.isInteger(suffix) ? suffix : 0;
      }),
    ) + 1;
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

export class BacklogWriter {
  private constructor(private readonly pluginRoot: string) {}

  static create(pluginRoot: string): BacklogWriter {
    return new BacklogWriter(pluginRoot);
  }

  record(
    eventId: string,
    source: EvolutionSource,
    findings: readonly EvolutionFinding[],
    options: { nowMs?: number } = {},
  ): boolean {
    if (!eventId) return false;
    const backlogPath = path.join(
      this.pluginRoot,
      "sessions",
      "evolution.json",
    );

    try {
      const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
      const backlog = fileExists(backlogPath)
        ? readBacklog(backlogPath)
        : createBacklog(nowIso);
      if (backlog.processedEvents[eventId]) return false;

      for (const finding of findings) {
        const existing = backlog.items.find(
          (item) =>
            item.status === "pending" &&
            item.type === finding.trigger &&
            item.dedupeKey === finding.dedupeKey,
        );
        if (existing) {
          existing.frequency += 1;
          existing.sources.push(source);
          existing.updatedAt = nowIso;
          existing.operation = finding.operation;
          existing.targetIntentIds = [...finding.targetIntentIds];
          existing.summary = finding.summary;
          existing.correctionGoal = finding.correctionGoal;
          existing.details = {
            evidence: finding.evidence,
            suggestedChange: finding.suggestedChange,
          };
          continue;
        }

        backlog.items.push({
          id: nextItemId(backlog, nowIso),
          type: finding.trigger,
          operation: finding.operation,
          targetIntentIds: [...finding.targetIntentIds],
          dedupeKey: finding.dedupeKey,
          summary: finding.summary,
          correctionGoal: finding.correctionGoal,
          details: {
            evidence: finding.evidence,
            suggestedChange: finding.suggestedChange,
          },
          frequency: 1,
          sources: [source],
          createdAt: nowIso,
          updatedAt: nowIso,
          status: "pending",
        });
      }

      backlog.updatedAt = nowIso;
      backlog.processedEvents[eventId] = nowIso;
      const validated = EvolutionBacklogSchema.parse(backlog);
      return safeWriteJson(
        backlogPath,
        validated,
        "failed to write evolution backlog",
      );
    } catch (err) {
      logger.warn("failed to update evolution backlog", {
        error: err,
        path: backlogPath,
      });
      return false;
    }
  }
}

export const defaultBacklogWriter = BacklogWriter.create(pluginRoot);
