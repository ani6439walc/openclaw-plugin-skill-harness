import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTracker } from "./tracker.js";

const FIRST = [{ name: "alpha", provenance: "historical-top" as const }];
const NEXT = [{ name: "beta", provenance: "random-exploration" as const }];

describe("SessionTracker curation state", () => {
  let root: string;
  let tracker: SessionTracker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-state-"));
    tracker = new SessionTracker(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function prepare(sessionId: string, runId: string, input = runId) {
    return tracker.preparePromptTurn({
      sessionId,
      agentId: "main",
      runId,
      input,
      startedAt: `2026-08-12T00:00:0${runId === "run-a" ? "0" : "1"}.000Z`,
    });
  }

  it.each([
    {
      name: "recognized changed topic",
      nextIntent: "coding",
      reason: "shift",
      sameTopic: false,
      trustworthy: true,
      epoch: 2,
      status: "applied",
    },
    {
      name: "different final intent",
      nextIntent: "writing",
      reason: undefined,
      sameTopic: true,
      trustworthy: true,
      epoch: 2,
      status: "applied",
    },
    {
      name: "exact same intent",
      nextIntent: "coding",
      reason: undefined,
      sameTopic: false,
      trustworthy: true,
      epoch: 1,
      status: "reused",
    },
    {
      name: "trusted same topic",
      nextIntent: "coding",
      reason: "same-topic",
      sameTopic: true,
      trustworthy: true,
      epoch: 1,
      status: "reused",
    },
    {
      name: "same intent when topic evidence flags are false",
      nextIntent: "coding",
      reason: undefined,
      sameTopic: false,
      trustworthy: false,
      epoch: 1,
      status: "reused",
    },
  ])("resolves monotonic epoch for $name", async (fixture) => {
    await prepare("epoch-session", "run-a");
    const first = await tracker.ensureColdStart({
      sessionId: "epoch-session",
      turnKey: "run-a",
      intentId: "coding",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: FIRST,
      now: "2026-08-12T00:00:00.000Z",
    });
    expect(first).toMatchObject({
      status: "applied",
      curation: { topicEpoch: 1, revision: 0 },
    });
    await prepare("epoch-session", "run-b");

    const result = await tracker.ensureColdStart({
      sessionId: "epoch-session",
      turnKey: "run-b",
      intentId: fixture.nextIntent,
      topicChangeReason: fixture.reason,
      trustworthySameTopic: fixture.sameTopic,
      trustworthyTopicEvidence: fixture.trustworthy,
      draftCandidates: NEXT,
      now: "2026-08-12T00:00:02.000Z",
    });

    expect(result.status).toBe(fixture.status);
    expect(
      result.status === "retryable-failure"
        ? undefined
        : result.curation.topicEpoch,
    ).toBe(fixture.epoch);
    expect(tracker.getCuration("epoch-session")?.intentId).toBe(
      fixture.nextIntent,
    );
  });

  it("creates epoch one once and reuses it on prompt retry", async () => {
    await prepare("retry-session", "run-a");
    const params = {
      sessionId: "retry-session",
      turnKey: "run-a",
      intentId: "coding",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: FIRST,
      now: "2026-08-12T00:00:00.000Z",
    } as const;
    await expect(tracker.ensureColdStart(params)).resolves.toMatchObject({
      status: "applied",
      curation: { topicEpoch: 1 },
    });
    await expect(tracker.ensureColdStart(params)).resolves.toMatchObject({
      status: "reused",
      curation: { topicEpoch: 1 },
    });
  });

  it("persists recommendation state only under exact current-turn curation guards", async () => {
    await prepare("recommendation-session", "run-a");
    await tracker.ensureColdStart({
      sessionId: "recommendation-session",
      turnKey: "run-a",
      intentId: "coding",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: FIRST,
      now: "2026-08-12T00:00:00.000Z",
    });
    const recommendationState = {
      topicEpoch: 1,
      curationRevision: 0,
      candidates: FIRST,
    };

    await expect(
      tracker.commitPromptRecommendation({
        sessionId: "recommendation-session",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        recommendedSkills: ["alpha"],
        recommendationState,
      }),
    ).resolves.toBe("applied");
    await expect(
      tracker.commitPromptRecommendation({
        sessionId: "recommendation-session",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 1,
        recommendedSkills: ["must-not-land"],
        recommendationState: { ...recommendationState, curationRevision: 1 },
      }),
    ).resolves.toBe("stale");
    expect(
      tracker.getTurnState("recommendation-session", "run-a")?.intent,
    ).toMatchObject({
      recommendedSkills: ["alpha"],
      recommendationState,
    });
  });

  it("refuses root curation changes for a turn rotated into history", async () => {
    await prepare("overlap-session", "run-a");
    await tracker.ensureColdStart({
      sessionId: "overlap-session",
      turnKey: "run-a",
      intentId: "coding",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: FIRST,
      now: "2026-08-12T00:00:00.000Z",
    });
    await prepare("overlap-session", "run-b");

    await expect(
      tracker.commitPromptRecommendation({
        sessionId: "overlap-session",
        turnKey: "run-a",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
        recommendedSkills: ["late"],
        recommendationState: {
          topicEpoch: 1,
          curationRevision: 0,
          candidates: NEXT,
        },
      }),
    ).resolves.toBe("stale");
    expect(tracker.getCuration("overlap-session")?.candidates).toEqual(FIRST);
  });
});
