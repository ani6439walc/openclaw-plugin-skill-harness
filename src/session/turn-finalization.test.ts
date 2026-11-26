import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLock, sessionsPath } from "../file-utils.js";
import { extractSkillInfo, SessionTracker } from "./tracker.js";

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
            confidence: 1,
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
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: "run-a",
      data: { matchedSkills: ["alpha"] },
    });
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

  it("counts completed skill-bearing turns once in completion order across reloads", async () => {
    // Older session files have neither count nor per-turn ordinals.
    const file = sessionsPath("session-a.json", root);
    const routed = (turnKey: string) => ({
      turnKey,
      matchedSkills: ["alpha"],
      timestamps: { end: "2026-08-12T00:00:00.000Z" },
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        sessionId: "session-a",
        history: [
          ...Array.from({ length: 7 }, (_, i) => routed(`old-${i}`)),
          { ...routed("empty"), matchedSkills: [] },
          { ...routed("unfinished"), timestamps: {} },
        ],
        current: {
          ...routed("legacy"),
          matchedSkills: undefined,
          intent: { intentMatchedSkills: ["old-format"] },
        },
      }),
    );
    await prepare("first", "first");
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: "first",
      data: { matchedSkills: ["alpha"] },
    });
    await prepare("later", "later");
    const finish = (run: string) => ({
      sessionId: "session-a",
      expectedTurnKey: run,
      endedAt: "2026-08-12T00:00:04.000Z",
    });
    const skillRead = {
      toolCallId: "load",
      name: "read",
      params: { path: "/skills/beta/SKILL.md" },
      result: "---\nname: beta\n---\nSkill instructions",
      success: true,
    };
    await tracker.finalizeTurnFromAgentEnd({
      ...finish("later"),
      stagedToolFallbacks: [skillRead],
    });
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "later")?.turnNumber,
    ).toBe(9);
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "first"),
    ).toBeUndefined();

    // Reload from disk after the newer prompt has already finished.
    tracker = SessionTracker.create(root);
    await tracker.finalizeTurnFromAgentEnd({
      ...finish("first"),
      stagedToolFallbacks: [skillRead], // both a recommendation and a load
    });
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "first")?.turnNumber,
    ).toBe(10);
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "later")?.turnNumber,
    ).toBe(9);
    expect(await tracker.finalizeTurnFromAgentEnd(finish("first"))).toBe(
      "already-finalized",
    );

    await prepare("no-skills", "ordinary turn");
    await tracker.finalizeTurnFromAgentEnd({
      ...finish("no-skills"),
      stagedToolFallbacks: [
        { ...skillRead, success: false, error: "read failed" },
      ],
    });
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "no-skills"),
    ).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).skillTurnCount).toBe(10);
  });

  it("reserves the tenth ordinal for the exact terminal after a tool-use preamble", async () => {
    for (let i = 1; i <= 9; i++) {
      const runId = `seed-${i}`;
      await prepare(runId, runId);
      await tracker.mergeTurnAndPersist({
        sessionId: "session-a",
        expectedTurnKey: runId,
        data: { matchedSkills: ["alpha"] },
      });
      await tracker.finalizeTurnFromAgentEnd({
        sessionId: "session-a",
        expectedTurnKey: runId,
        endedAt: "2026-08-12T00:00:03.000Z",
      });
    }
    await prepare("recovered", "unique");
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: "recovered",
      data: { matchedSkills: ["alpha"] },
    });
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "repeat-1",
      input: "same",
      startedAt: "2026-08-12T00:00:03.000Z",
      recentTurns: [
        { role: "user", text: "unique" },
        { role: "assistant", text: "Checking the inputs." },
      ],
    });
    await prepare("repeat-2", "same");
    await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "ambiguous-reply",
      input: "repeated transcript input",
      startedAt: "2026-08-12T00:00:04.000Z",
      recentTurns: [
        { role: "user", text: "same" },
        { role: "assistant", text: "ambiguous" },
      ],
    });
    const next = {
      sessionId: "session-a",
      agentId: "main",
      runId: "current",
      input: "next",
      startedAt: "2026-08-12T00:00:04.000Z",
      recentTurns: [
        { role: "user", text: "same" },
        { role: "assistant", text: "ambiguous" },
        { role: "user", text: "repeated transcript input" },
        { role: "assistant", text: "old" },
        { role: "user", text: "repeated transcript input" },
        { role: "assistant", text: "new" },
        { role: "user", text: "unique" },
        { role: "assistant", text: "Checking the inputs." },
      ],
    };
    await tracker.preparePromptTurn(next);
    await tracker.preparePromptTurn(next);
    tracker = SessionTracker.create(root);
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "recovered"),
    ).toBeUndefined();
    const pending = tracker.getTurnState("session-a", "recovered")!;
    expect(pending.assistantReplyObserved).toBe(true);
    expect(pending.result).toBeUndefined();
    expect(pending.timestamps?.end).toBeUndefined();
    expect(pending.skillTurnNumber).toBeUndefined();
    for (const id of ["repeat-1", "repeat-2", "ambiguous-reply"]) {
      expect(
        tracker.getTurnState("session-a", id)?.assistantReplyObserved,
      ).toBeUndefined();
    }
    const finish = {
      sessionId: "session-a",
      expectedTurnKey: "recovered",
      result: "The relation is supported.",
      endedAt: "2026-08-12T00:00:05.000Z",
    };
    expect(await tracker.finalizeTurnFromAgentEnd(finish)).toBe("applied");
    expect(await tracker.finalizeTurnFromAgentEnd(finish)).toBe(
      "already-finalized",
    );
    expect(
      await tracker.finalizeTurnFromAgentEnd({
        ...finish,
        result: "conflicting terminal",
      }),
    ).toBe("stale");
    expect(
      tracker.getTurnState("session-a", "recovered")?.assistantReplyObserved,
    ).toBeUndefined();
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "recovered"),
    ).toMatchObject({
      turnNumber: 10,
      current: { result: finish.result, timestamps: { end: finish.endedAt } },
    });
  });

  it("rebinds a retained pending run on replay after reload without replacing the current run", async () => {
    await prepare("retained", "first");
    await tracker.mergeTurnAndPersist({
      sessionId: "session-a",
      expectedTurnKey: "retained",
      data: { matchedSkills: ["alpha"] },
    });
    await prepare("newer", "second");
    tracker = SessionTracker.create(root);
    const file = sessionsPath("session-a.json", root);
    const before = fs.readFileSync(file, "utf8");
    const replay = await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      runId: "retained",
      input: "first",
      startedAt: "2026-08-12T00:00:10.000Z",
      recentTurns: [
        { role: "user", text: "second" },
        { role: "assistant", text: "unrelated" },
      ],
    });
    expect(replay).toEqual({
      status: "reused",
      identity: {
        turnKey: "retained",
        reused: true,
        sessionKey: "agent:main:direct:a",
      },
    });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    if (replay.status !== "reused")
      throw new Error("missing retained association");
    expect(
      await tracker.mergeTurnAndPersist({
        sessionId: "session-a",
        expectedTurnKey: replay.identity.turnKey,
        currentTurnOnly: true,
        data: { matchedSkills: ["wrong"] },
      }),
    ).toBe("stale");
    expect(
      await tracker.finalizeTurnFromAgentEnd({
        sessionId: "session-a",
        expectedTurnKey: replay.identity.turnKey,
        result: "first answer",
        endedAt: "2026-08-12T00:00:11.000Z",
      }),
    ).toBe("applied");
    expect(
      tracker.getReviewSnapshotForTurn("session-a", "retained"),
    ).toMatchObject({
      turnNumber: 1,
      current: { matchedSkills: ["alpha"], result: "first answer" },
    });
    expect(tracker.getCurrentState("session-a")?.turnKey).toBe("newer");
    expect(
      tracker.getCurrentState("session-a")?.timestamps?.end,
    ).toBeUndefined();
  });

  it("reuses durable native identities across reload, independently of aliases, text and current row", async () => {
    const base = {
      sessionId: "session-a",
      agentId: "main",
      runId: "shared-alias",
      forceNew: true,
      input: "continue",
      startedAt: "2026-08-12T00:00:00.000Z",
    };
    const prepareNative = async (admissionId: string) => {
      const result = await tracker.preparePromptTurn({
        ...base,
        nativeAdmissionId: admissionId,
      });
      if (!("identity" in result)) throw new Error(result.status);
      return result.identity;
    };
    const completed = await prepareNative("private-admission");
    const finish = (turnKey: string) =>
      tracker.finalizeTurnFromAgentEnd({
        sessionId: "session-a",
        expectedTurnKey: turnKey,
        endedAt: "2026-08-12T00:00:03.000Z",
      });
    const load = (turnKey: string) =>
      tracker.mergeTurnAndPersist({
        sessionId: "session-a",
        expectedTurnKey: turnKey,
        data: { matchedSkills: ["alpha"] },
      });
    await load(completed.turnKey);
    await finish(completed.turnKey);
    const pending = await prepareNative("");
    await load(pending.turnKey);
    const newest = await prepareNative(" ");
    expect(
      new Set([completed.turnKey, pending.turnKey, newest.turnKey]).size,
    ).toBe(3);
    const file = sessionsPath("session-a.json", root);
    const saved = fs.readFileSync(file, "utf8");
    expect(saved).not.toContain("private-admission");
    expect(JSON.parse(saved).current.nativeAdmissionDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    tracker = SessionTracker.create(root);
    expect(
      tracker.getNativeTurnIdentity("session-a", "main", "private-admission"),
    ).toEqual({
      turnKey: completed.turnKey,
      reused: true,
      finalized: true,
    });
    expect(
      tracker.getNativeTurnIdentity("session-a", "other", ""),
    ).toBeUndefined();
    expect(
      tracker.getNativeTurnIdentity("other-session", "main", ""),
    ).toBeUndefined();
    expect(await prepareNative("private-admission")).toEqual({
      turnKey: completed.turnKey,
      reused: true,
      finalized: true,
    });
    expect(await finish(completed.turnKey)).toBe("already-finalized");
    expect(await prepareNative("")).toEqual({
      turnKey: pending.turnKey,
      reused: true,
    });
    expect(fs.readFileSync(file, "utf8")).toBe(saved);
    expect(await finish(pending.turnKey)).toBe("applied");
    expect(
      tracker.getReviewSnapshotForTurn("session-a", pending.turnKey)
        ?.turnNumber,
    ).toBe(2);
    expect(
      tracker.getReviewSnapshotForTurn("session-a", completed.turnKey)
        ?.turnNumber,
    ).toBe(1);
    expect(tracker.getCurrentState("session-a")?.turnKey).toBe(newest.turnKey);
  });

  it("rejects ambiguous durable native identities without allocating a UUID or overwriting either row", async () => {
    const params = {
      sessionId: "session-a",
      agentId: "main",
      forceNew: true,
      nativeAdmissionId: "native",
      input: "same",
      startedAt: "2026-08-12T00:00:00.000Z",
    };
    const first = await tracker.preparePromptTurn(params);
    expect(first.status).toBe("applied");
    const file = sessionsPath("session-a.json", root);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const other of [
      { ...saved.current, turnKey: "other-key" },
      { ...saved.current, nativeAdmissionDigest: undefined },
    ]) {
      const damaged = JSON.stringify({ ...saved, history: [other] });
      fs.writeFileSync(file, damaged);
      expect(await tracker.preparePromptTurn(params)).toEqual({
        status: "ambiguous",
      });
      expect(fs.readFileSync(file, "utf8")).toBe(damaged);
    }
  });

  it("never infers a native identity from a legacy row with matching alias and input", async () => {
    await prepare("legacy-alias", "same");
    const native = await tracker.preparePromptTurn({
      sessionId: "session-a",
      agentId: "main",
      forceNew: true,
      runId: "legacy-alias",
      nativeAdmissionId: "legacy-alias",
      input: "same",
      startedAt: "2026-08-12T00:00:03.000Z",
    });
    expect(native.status).toBe("applied");
    if (native.status !== "applied")
      throw new Error("missing distinct native turn");
    expect(native.identity.turnKey).not.toBe("legacy-alias");
    expect(
      tracker.getTurnState("session-a", "legacy-alias")?.nativeAdmissionDigest,
    ).toBeUndefined();
  });

  it.each([false, true])(
    "counts a staged full skill_view result once (already finalized: %s)",
    async (alreadyFinalized) => {
      await prepare("late-load", "manual");
      const finish = {
        sessionId: "session-a",
        expectedTurnKey: "late-load",
        endedAt: "2026-08-12T00:00:04.000Z",
      };
      if (alreadyFinalized) await tracker.finalizeTurnFromAgentEnd(finish);
      expect(
        tracker.getReviewSnapshotForTurn("session-a", "late-load"),
      ).toBeUndefined();
      const skill = { name: "alpha", path: "/skills/alpha/SKILL.md" };
      const params = { name: "alpha" };
      const fullResult = JSON.stringify({
        ...skill,
        success: true,
        content: "# Operating instructions\n".repeat(50),
      });
      const preview = fullResult.slice(0, 200);
      expect(extractSkillInfo("skill_view", params, preview)).toBeUndefined();
      const valid = {
        toolCallId: "load",
        name: "skill_view",
        params,
        result: preview,
        success: true,
        skillUsed: extractSkillInfo("skill_view", params, fullResult),
      };
      const neverLoaded = { name: "other", path: "/skills/other/SKILL.md" };
      const fallback = {
        ...finish,
        stagedToolFallbacks: [
          valid,
          { ...valid, skillUsed: neverLoaded },
          {
            ...valid,
            toolCallId: "failed",
            success: false,
            skillUsed: neverLoaded,
          },
          {
            ...valid,
            toolCallId: "error",
            error: "failure",
            skillUsed: neverLoaded,
          },
        ],
      };
      expect(await tracker.finalizeTurnFromAgentEnd(fallback)).toBe(
        alreadyFinalized ? "became-review-eligible" : "applied",
      );
      expect(await tracker.finalizeTurnFromAgentEnd(fallback)).toBe(
        "already-finalized",
      );
      expect(
        tracker.getReviewSnapshotForTurn("session-a", "late-load")?.turnNumber,
      ).toBe(1);
      const current = tracker.getTurnState("session-a", "late-load")!;
      expect(current.skillsUsed).toEqual([skill]);
      expect(current.toolCalls).toHaveLength(3);
      for (const call of current.toolCalls!)
        expect(call).not.toHaveProperty("skillUsed");
    },
  );

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
