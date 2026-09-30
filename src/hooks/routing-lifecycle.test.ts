import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "../../api.js";
import { resolveConfig } from "../config.js";
import { SkillExperienceCatalog } from "../experiences/catalog.js";
import { SessionTracker } from "../session/tracker.js";
import { StatsAggregator } from "../stats/aggregator.js";
import { weightedReciprocalRankFusion } from "../qmd/rrf.js";
import { createHookHandlers } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("routing lifecycle with real session and stats persistence", () => {
  it.each([true, false])(
    "records experience-only and unmatched turns (hit=%s) and schedules review",
    async (hasHit) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "routing-lifecycle-"));
      roots.push(root);
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace);
      const entryDir = path.join(root, "experiences", "recovery");
      fs.mkdirSync(entryDir, { recursive: true });
      fs.writeFileSync(
        path.join(entryDir, "summary.md"),
        "Recover a failed deployment.",
      );
      fs.writeFileSync(
        path.join(entryDir, "keywords.md"),
        "deployment\nrecovery",
      );
      fs.writeFileSync(
        path.join(entryDir, "body.md"),
        "Inspect the deployment and verify recovery.",
      );
      const tracker = SessionTracker.create(root);
      const stats = StatsAggregator.create(root);
      const schedule = vi.fn(() => true);
      const skillSearch = vi.fn();
      const [fused] = weightedReciprocalRankFusion({
        lists: [
          [{ id: "recovery" }],
          [{ id: "recovery" }],
          [{ id: "recovery" }],
        ],
        weights: [1, 0.8, 0.5],
      });
      const experienceSearch = vi.fn(async () =>
        hasHit
          ? [
              {
                id: "recovery",
                skills: [],
                score: fused.score,
                semanticScore: 0.95,
                matchedCollections: ["keywords", "summary", "body"],
                evidence: [],
              },
            ]
          : [],
      );
      const selector = vi.fn(async () => ({
        skills: [],
        experiences: ["recovery"],
        confidence: 0.4,
        reason: "Relevant recovery",
      }));
      const handlers = createHookHandlers({
        api: {
          config: {},
          runtime: {
            state: { resolveStateDir: () => root },
            agent: { resolveAgentWorkspaceDir: () => workspace },
          },
        } as unknown as OpenClawPluginApi,
        dataRoot: root,
        tracker,
        statsAggregator: stats,
        skillInventoryResolver: async () => [],
        experienceCatalog: new SkillExperienceCatalog(root),
        config: () =>
          resolveConfig({
            routing: { skills: { maxInjectedSkills: 0 } },
            review: {
              enabled: true,
              model: "test/reviewer",
              triggers: {
                experienceHealthCheck: { enabled: true, everyTurns: 1 },
              },
            },
          }),
        refreshLiveConfigFromRuntime: () => {},
        qmdSkillIndex: { search: skillSearch } as never,
        qmdExperienceIndex: {
          search: experienceSearch,
          schedule: () => {},
          getStatus: () => "ready",
          close: async () => {},
        },
        routingSelector: selector,
        reviewScheduler: {
          schedule,
          setRunner: () => {},
          setOnDiscard: () => {},
        },
      });
      const ctx = {
        trigger: "user",
        messageProvider: "webchat",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        runId: "run-1",
      };
      const result = await handlers.onBeforePromptBuild(
        {
          prompt: "recover deployment",
          messages: [{ role: "user", content: "recover deployment" }],
        },
        ctx,
      );
      expect(experienceSearch).toHaveBeenCalledOnce();
      expect(skillSearch).not.toHaveBeenCalled();
      if (hasHit) {
        expect(selector).toHaveBeenCalledOnce();
        expect(result?.prependContext).toContain('<experience id="recovery">');
        expect(result?.prependContext).not.toContain("<matched_skills>");
      } else {
        expect(selector).not.toHaveBeenCalled();
        expect(result?.prependContext).toBeUndefined();
      }
      await handlers.onAgentEnd(
        { messages: [{ role: "assistant", content: "Done" }], success: true },
        ctx,
      );
      const state = tracker.getCurrentState("session-1");
      expect(state).toMatchObject({
        matchedSkills: [],
        matchedExperiences: hasHit ? ["recovery"] : [],
        confidence: hasHit ? 0.4 : 0,
      });
      expect(state?.intent?.result).toBeUndefined();
      const persisted = JSON.parse(
        fs.readFileSync(path.join(root, "stats.json"), "utf8"),
      );
      expect(persisted.summary).toMatchObject({ turns: 1, completedTurns: 1 });
      expect(persisted.intents).toEqual({});
      expect(persisted.skillDiscovery.turns).toBe(1);
      expect(schedule).toHaveBeenCalledOnce();
      expect(schedule.mock.calls[0][0]).toMatchObject({
        triggers: expect.arrayContaining([
          "experience-health-check",
          "routing-uncertainty",
        ]),
        snapshot: {
          current: { matchedExperiences: hasHit ? ["recovery"] : [] },
        },
      });
      await handlers.onAgentEnd({ messages: [], success: true }, ctx);
      expect(stats.getAcceptedTurnCount()).toBe(1);
      expect(schedule).toHaveBeenCalledOnce();
    },
  );
});
