import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "../api.js";
import type { EvolutionFinding, EvolutionSource } from "./evolution-types.js";
import {
  EVOLUTION_TRIGGER_TYPES,
  type EvolutionTrigger,
} from "./trigger-checker.js";

type BacklogItem = {
  id: string;
  type: EvolutionTrigger;
  dedupeKey: string;
  summary: string;
  correctionGoal: string;
  details: {
    evidence: string[];
    suggestedChange: string;
  };
  frequency: number;
  sources: EvolutionSource[];
  createdAt: string;
  updatedAt: string;
  status: "pending" | "processed" | "dismissed";
};

type EvolutionBacklog = {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  processedEvents: Record<string, string>;
  items: BacklogItem[];
};

const EvolutionSourceSchema = z.object({
  sessionId: z.string(),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  turnStart: z.string(),
});

const EvolutionBacklogSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  processedEvents: z.record(z.string(), z.string()),
  items: z.array(
    z.object({
      id: z.string(),
      type: z.enum(EVOLUTION_TRIGGER_TYPES),
      dedupeKey: z.string(),
      summary: z.string(),
      correctionGoal: z.string(),
      details: z.object({
        evidence: z.array(z.string()),
        suggestedChange: z.string(),
      }),
      frequency: z.number().int().positive(),
      sources: z.array(EvolutionSourceSchema),
      createdAt: z.string(),
      updatedAt: z.string(),
      status: z.enum(["pending", "processed", "dismissed"]),
    }),
  ),
});

function createBacklog(nowIso: string): EvolutionBacklog {
  return {
    schemaVersion: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    processedEvents: {},
    items: [],
  };
}

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
      const backlog = fs.existsSync(backlogPath)
        ? EvolutionBacklogSchema.parse(
            JSON.parse(fs.readFileSync(backlogPath, "utf-8")),
          )
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
      return this.write(backlogPath, backlog);
    } catch (err) {
      logger.warn("failed to update evolution backlog", {
        error: err,
        path: backlogPath,
      });
      return false;
    }
  }

  private write(backlogPath: string, backlog: EvolutionBacklog): boolean {
    const sessionsDir = path.dirname(backlogPath);
    const tempPath = `${backlogPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(backlog, null, 2));
      fs.renameSync(tempPath, backlogPath);
      return true;
    } catch (err) {
      logger.warn("failed to write evolution backlog", {
        error: err,
        path: backlogPath,
      });
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      return false;
    }
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(currentDir, "..", "..");
export const defaultBacklogWriter = BacklogWriter.create(pluginRoot);
