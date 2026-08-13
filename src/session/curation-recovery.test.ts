import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionsDirPath } from "../file-utils.js";
import { SessionTracker } from "./tracker.js";

const FIRST = [{ name: "alpha", provenance: "historical-top" as const }];

describe("SessionTracker durable curation recovery", () => {
  let roots: string[];
  let root: string;
  let tracker: SessionTracker;

  beforeEach(() => {
    roots = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-recovery-"));
    roots.push(root);
    tracker = SessionTracker.create(root);
  });

  afterEach(() => {
    for (const candidate of roots) {
      try {
        fs.chmodSync(sessionsDirPath(candidate), 0o700);
      } catch {
        // Directory may not have been created.
      }
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  });

  async function prepareCuration() {
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "run-a",
      input: "first",
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    await tracker.ensureColdStart({
      sessionId: "session-a",
      turnKey: "run-a",
      intentId: "coding",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: FIRST,
      now: "2026-08-12T00:00:00.000Z",
    });
    await tracker.commitPromptRecommendation({
      sessionId: "session-a",
      turnKey: "run-a",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      recommendedSkills: ["alpha"],
      recommendationState: {
        topicEpoch: 1,
        curationRevision: 0,
        candidates: FIRST,
      },
    });
  }

  it("does not publish an in-memory curation change when atomic persistence fails", async () => {
    await prepareCuration();
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "run-b",
      input: "second",
      startedAt: "2026-08-12T00:00:01.000Z",
    });
    const beforeMemory = tracker.getCuration("session-a");
    const file = path.join(sessionsDirPath(root), "session-a.json");
    const beforeBytes = fs.readFileSync(file);

    fs.chmodSync(sessionsDirPath(root), 0o500);
    const result = await tracker.ensureColdStart({
      sessionId: "session-a",
      turnKey: "run-b",
      intentId: "writing",
      topicChangeReason: "shift",
      trustworthySameTopic: false,
      trustworthyTopicEvidence: true,
      draftCandidates: [{ name: "beta", provenance: "random-exploration" }],
      now: "2026-08-12T00:00:02.000Z",
    });
    fs.chmodSync(sessionsDirPath(root), 0o700);

    expect(result).toEqual({ status: "retryable-failure" });
    expect(tracker.getCuration("session-a")).toEqual(beforeMemory);
    expect(fs.readFileSync(file)).toEqual(beforeBytes);
  });

  it("recovers the exact pending schedule and curation from a fresh plugin root", async () => {
    await prepareCuration();
    await tracker.finalizeTurnFromAgentEnd({
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      result: "done",
      endedAt: "2026-08-12T00:00:02.000Z",
    });
    await tracker.reserveCurationSchedule({
      sessionId: "session-a",
      turnKey: "run-a",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      now: "2026-08-12T00:00:03.000Z",
    });

    const restartedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "curation-restarted-"),
    );
    roots.push(restartedRoot);
    fs.mkdirSync(sessionsDirPath(restartedRoot), { recursive: true });
    fs.copyFileSync(
      path.join(sessionsDirPath(root), "session-a.json"),
      path.join(sessionsDirPath(restartedRoot), "session-a.json"),
    );
    const restarted = SessionTracker.create(restartedRoot);

    expect(restarted.getCuration("session-a")).toEqual(
      tracker.getCuration("session-a"),
    );
    await expect(restarted.listPendingCurationSchedules()).resolves.toEqual(
      await tracker.listPendingCurationSchedules(),
    );
  });
});
