import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLock, sessionsPath } from "../file-utils.js";
import { SessionTracker } from "./tracker.js";

describe("SessionTracker exact-turn finalization", () => {
  let root: string;
  let tracker: SessionTracker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-finalization-"));
    tracker = new SessionTracker(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function prepare(runId: string, input: string) {
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      sessionKey: "agent:main:direct:a",
      agentId: "main",
      runId,
      input,
      startedAt: "2026-08-12T00:00:00.000Z",
    });
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: runId,
      data: {
        intent: {
          result: {
            intent: "coding",
            reason: "test",
            domain: "coding",
            confidence: 1,
            complexity: "low",
          },
        },
      },
    });
  }

  it("finalizes only the exact retained turn and atomically includes staged tool evidence", async () => {
    await prepare("run-a", "first");
    await prepare("run-b", "second");

    await expect(
      tracker.finalizeTurnFromAgentEnd({
        sessionId: "session-a",
        expectedTurnKey: "run-a",
        stagedToolFallbacks: [
          {
            toolCallId: "tool-a",
            name: "read",
            params: { path: "/safe/a" },
            result: "done",
            success: true,
          },
        ],
        result: "answer-a",
        endedAt: "2026-08-12T00:00:03.000Z",
      }),
    ).resolves.toBe("applied");

    expect(tracker.getTurnState("session-a", "run-a")).toMatchObject({
      result: "answer-a",
      timestamps: { end: "2026-08-12T00:00:03.000Z" },
      toolCalls: [{ toolCallId: "tool-a", name: "read", result: "done" }],
    });
    expect(tracker.getTurnState("session-a", "run-b")).not.toHaveProperty(
      "result",
    );
  });

  it("atomically includes every distinct staged tool fallback before terminalizing", async () => {
    await prepare("run-a", "first");

    await expect(
      tracker.finalizeTurnFromAgentEnd({
        sessionId: "session-a",
        expectedTurnKey: "run-a",
        stagedToolFallbacks: [
          {
            toolCallId: "tool-a",
            name: "read",
            params: { path: "/safe/a" },
            result: "done-a",
            success: true,
          },
          {
            toolCallId: "tool-b",
            name: "skill_view",
            params: { name: "alpha" },
            result: "done-b",
            success: true,
          },
          {
            toolCallId: "tool-a",
            name: "read",
            params: { path: "/safe/a" },
            result: "done-a",
            success: true,
          },
        ],
        result: "answer-a",
        endedAt: "2026-08-12T00:00:03.000Z",
      }),
    ).resolves.toBe("applied");

    expect(tracker.getTurnState("session-a", "run-a")).toMatchObject({
      timestamps: { end: "2026-08-12T00:00:03.000Z" },
      toolCalls: [
        { toolCallId: "tool-a", result: "done-a" },
        { toolCallId: "tool-b", result: "done-b" },
      ],
    });
  });

  it("acknowledges matching duplicate terminal delivery but rejects conflicts", async () => {
    await prepare("run-a", "first");
    const params = {
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      result: "answer-a",
      endedAt: "2026-08-12T00:00:03.000Z",
    } as const;
    await expect(tracker.finalizeTurnFromAgentEnd(params)).resolves.toBe(
      "applied",
    );
    await expect(
      tracker.finalizeTurnFromAgentEnd({
        ...params,
        endedAt: "2026-08-12T00:00:09.000Z",
      }),
    ).resolves.toBe("already-finalized");
    await expect(
      tracker.finalizeTurnFromAgentEnd({
        ...params,
        result: "different",
        endedAt: "2026-08-12T00:00:10.000Z",
      }),
    ).resolves.toBe("stale");
    expect(tracker.getTurnState("session-a", "run-a")?.timestamps?.end).toBe(
      "2026-08-12T00:00:03.000Z",
    );
  });

  it("builds Review evidence and event identity around the exact finalized turn", async () => {
    await prepare("run-a", "first");
    await tracker.finalizeTurnFromAgentEnd({
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      result: "answer-a",
      endedAt: "2026-08-12T00:00:03.000Z",
    });
    await prepare("run-b", "second");

    const snapshot = tracker.getReviewSnapshotForTurn("session-a", "run-a");
    expect(snapshot).toMatchObject({
      eventId: "session-a:turn:run-a",
      current: { input: "first", result: "answer-a" },
    });
    expect(snapshot?.recent).toEqual([]);
    expect(snapshot?.current.input).not.toBe("second");
  });

  it("fails closed for missing, duplicate, and already-terminal ordinary merges", async () => {
    await prepare("run-a", "first");
    await tracker.finalizeTurnFromAgentEnd({
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      result: "answer-a",
      endedAt: "2026-08-12T00:00:03.000Z",
    });
    await expect(
      tracker.mergeTurnAndPersist({
        sessionId: "session-a",
        expectedTurnKey: "run-a",
        data: { result: "late mutation" },
      }),
    ).resolves.toBe("stale");
    await expect(
      tracker.finalizeTurnFromAgentEnd({
        sessionId: "session-a",
        expectedTurnKey: "missing",
        result: "answer",
        endedAt: "2026-08-12T00:00:04.000Z",
      }),
    ).resolves.toBe("stale");
  });

  it("deduplicates ordinary tool merges by durable toolCallId", async () => {
    await prepare("run-a", "first");
    const data = {
      toolCalls: [
        {
          toolCallId: "tool-a",
          name: "read",
          params: { path: "/safe/a" },
          result: "done",
          success: true,
        },
      ],
    };
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      data,
    });
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      data,
    });
    expect(tracker.getTurnState("session-a", "run-a")?.toolCalls).toHaveLength(
      1,
    );
  });

  it("waits through bounded lock contention before applying the terminal write", async () => {
    await prepare("run-a", "first");
    const lock = new FileLock(sessionsPath("session-a.json", root));
    expect(await lock.acquire()).toBe(true);
    const release = setTimeout(() => lock.release(), 20);

    try {
      await expect(
        tracker.finalizeTurnFromAgentEnd({
          sessionId: "session-a",
          expectedTurnKey: "run-a",
          result: "answer-a",
          endedAt: "2026-08-12T00:00:03.000Z",
        }),
      ).resolves.toBe("applied");
    } finally {
      clearTimeout(release);
      lock.release();
    }
  });
});
