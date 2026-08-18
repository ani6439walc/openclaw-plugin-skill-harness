import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTracker } from "./tracker.js";

const FIRST = [{ name: "alpha", provenance: "historical-top" as const }];
const REVISED = [{ name: "beta", provenance: "curator-added" as const }];

describe("SessionTracker curation schedule CAS", () => {
  let root: string;
  let tracker: SessionTracker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-schedule-"));
    tracker = new SessionTracker(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function prepareRoutedTurn(runId: string, input: string) {
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId,
      input,
      startedAt: `2026-08-12T00:00:${runId === "run-a" ? "00" : "01"}.000Z`,
    });
    if (!tracker.getCuration("session-a")) {
      await tracker.ensureColdStart({
        sessionId: "session-a",
        turnKey: runId,
        intentId: "coding",
        trustworthySameTopic: false,
        trustworthyTopicEvidence: true,
        draftCandidates: FIRST,
        now: "2026-08-12T00:00:00.000Z",
      });
    }
    const curation = tracker.getCuration("session-a");
    expect(curation).toBeDefined();
    await tracker.commitPromptRecommendation({
      sessionId: "session-a",
      turnKey: runId,
      expectedTopicEpoch: curation!.topicEpoch,
      expectedRevision: curation!.revision,
      recommendedSkills: curation!.candidates.map(({ name }) => name),
      recommendationState: {
        topicEpoch: curation!.topicEpoch,
        curationRevision: curation!.revision,
        candidates: curation!.candidates,
      },
    });
    await tracker.finalizeTurnFromAgentEnd({
      sessionId: "session-a",
      expectedTurnKey: runId,
      result: `result-${runId}`,
      endedAt: `2026-08-12T00:00:${runId === "run-a" ? "02" : "03"}.000Z`,
    });
  }

  it("permits one durable pending reservation per session epoch and lists its envelope", async () => {
    await prepareRoutedTurn("run-a", "first");
    const results = await Promise.all([
      tracker.reserveCurationSchedule({
        sessionId: "session-a",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        now: "2026-08-12T00:00:03.000Z",
      }),
      tracker.reserveCurationSchedule({
        sessionId: "session-a",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        now: "2026-08-12T00:00:04.000Z",
      }),
    ]);

    expect(results.sort()).toEqual(["already-pending", "reserved"]);
    await expect(tracker.listPendingCurationSchedules()).resolves.toEqual([
      {
        sessionId: "session-a",
        schedule: {
          agentId: "main",
          schedulingTurnKey: "run-a",
          expectedTopicEpoch: 1,
          expectedRevision: 0,
          status: "pending",
          reservedAt: "2026-08-12T00:00:03.000Z",
        },
      },
    ]);
  });

  it("rejects curation reservation for an errored finalized turn", async () => {
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "run-error",
      input: "failed",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    await tracker.ensureColdStart({
      sessionId: "session-a",
      turnKey: "run-error",
      intentId: "coding",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: FIRST,
      now: "2026-08-12T00:00:00.000Z",
    });
    await tracker.commitPromptRecommendation({
      sessionId: "session-a",
      turnKey: "run-error",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      recommendedSkills: ["alpha"],
      recommendationState: {
        topicEpoch: 1,
        curationRevision: 0,
        candidates: FIRST,
      },
    });
    await tracker.finalizeTurnFromAgentEnd({
      sessionId: "session-a",
      expectedTurnKey: "run-error",
      error: "failure",
      endedAt: "2026-08-12T00:00:01.000Z",
    });

    await expect(
      tracker.reserveCurationSchedule({
        sessionId: "session-a",
        turnKey: "run-error",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        now: "2026-08-12T00:00:02.000Z",
      }),
    ).resolves.toBe("stale");
  });

  it("commits one revision, cursor, and completed turn-local outbox atomically", async () => {
    await prepareRoutedTurn("run-a", "first");
    await tracker.reserveCurationSchedule({
      sessionId: "session-a",
      turnKey: "run-a",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      now: "2026-08-12T00:00:03.000Z",
    });

    const params = {
      sessionId: "session-a",
      schedulingTurnKey: "run-a",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      expectedIntentId: "coding",
      candidates: REVISED,
      recommendedExperienceRefs: ["alpha/verify"],
      completedTurnCursor: 3,
      now: "2026-08-12T00:00:05.000Z",
    } as const;
    const results = await Promise.all([
      tracker.commitCurationSchedule(params),
      tracker.commitCurationSchedule(params),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "applied",
      "reused",
    ]);
    expect(tracker.getCuration("session-a")).toMatchObject({
      topicEpoch: 1,
      revision: 1,
      candidates: REVISED,
      recommendedExperienceRefs: ["alpha/verify"],
      completedTurnCursor: 3,
      updatedAt: "2026-08-12T00:00:05.000Z",
    });
    expect(
      tracker.getTurnState("session-a", "run-a")?.intent?.recommendationState
        ?.curationSchedule,
    ).toMatchObject({
      status: "completed",
      finishedAt: "2026-08-12T00:00:05.000Z",
    });
    expect(tracker.getTurnState("session-a", "run-a")?.curationResult).toEqual({
      status: "applied",
      topicEpoch: 1,
      revision: 1,
      candidates: REVISED,
      recommendedExperienceRefs: ["alpha/verify"],
      reason: "",
      finishedAt: "2026-08-12T00:00:05.000Z",
    });
    await expect(tracker.listPendingCurationSchedules()).resolves.toEqual([]);
  });

  it("preserves a concurrent current-turn merge across background curation commit", async () => {
    await prepareRoutedTurn("run-a", "first");
    await tracker.reserveCurationSchedule({
      sessionId: "session-a",
      turnKey: "run-a",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      now: "2026-08-12T00:00:03.000Z",
    });
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "run-b",
      input: "second",
      startedAt: "2026-08-12T00:00:04.000Z",
    });

    const [curationResult, mergeResult] = await Promise.all([
      tracker.commitCurationSchedule({
        sessionId: "session-a",
        schedulingTurnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        expectedIntentId: "coding",
        candidates: REVISED,
        recommendedExperienceRefs: ["beta/verify"],
        completedTurnCursor: 3,
        now: "2026-08-12T00:00:05.000Z",
      }),
      tracker.mergeTurnAndPersist({
        sessionId: "session-a",
        expectedTurnKey: "run-b",
        data: {
          toolCalls: [
            {
              toolCallId: "tool-b",
              name: "read",
              params: { path: "/safe/b" },
              result: "done",
              success: true,
            },
          ],
        },
      }),
    ]);

    expect(curationResult.status).toBe("applied");
    expect(mergeResult).toBe("applied");
    const restarted = SessionTracker.create(root);
    expect(restarted.getCuration("session-a")).toMatchObject({
      revision: 1,
      candidates: REVISED,
      recommendedExperienceRefs: ["beta/verify"],
    });
    expect(restarted.getTurnState("session-a", "run-b")?.toolCalls).toEqual([
      expect.objectContaining({ toolCallId: "tool-b", result: "done" }),
    ]);
    expect(
      restarted.getTurnState("session-a", "run-a")?.intent?.recommendationState,
    ).toMatchObject({
      curationSchedule: { status: "completed" },
    });
  });

  it("marks observed failures terminal and never reopens them", async () => {
    await prepareRoutedTurn("run-a", "first");
    await tracker.reserveCurationSchedule({
      sessionId: "session-a",
      turnKey: "run-a",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      now: "2026-08-12T00:00:03.000Z",
    });

    await expect(
      tracker.finishCurationSchedule({
        sessionId: "session-a",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        outcome: "failed",
        now: "2026-08-12T00:00:05.000Z",
      }),
    ).resolves.toBe("applied");
    await expect(
      tracker.finishCurationSchedule({
        sessionId: "session-a",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        outcome: "failed",
        now: "2026-08-12T00:00:06.000Z",
      }),
    ).resolves.toBe("already-finished");
    await expect(
      tracker.reserveCurationSchedule({
        sessionId: "session-a",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        now: "2026-08-12T00:00:07.000Z",
      }),
    ).resolves.toBe("already-finished");
  });
});
