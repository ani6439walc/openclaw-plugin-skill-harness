import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PendingCurationSchedule,
  SessionCurationRecord,
} from "./types.js";
import {
  evaluateCurationCadence,
  reconcileCurationSchedules,
  validateAndCommitCuration as validateAndCommitCurationProduction,
} from "./scheduler.js";
import type { SessionData, SessionState } from "../session/index.js";
import { SkillExperienceCatalog } from "../experiences/index.js";
import type { AvailableSkill } from "../skills/types.js";
import type { CuratorProposal } from "./subagent.js";

const CURATION: SessionCurationRecord = {
  topicEpoch: 1,
  intentId: "coding",
  revision: 0,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  startedByTurnKey: "turn-1",
  candidates: [],
  recommendedExperienceRefs: [],
  completedTurnCursor: 0,
};

function schedule(
  turnKey: string,
  status: PendingCurationSchedule["status"],
  revision = 0,
): PendingCurationSchedule {
  return {
    agentId: "main",
    schedulingTurnKey: turnKey,
    expectedTopicEpoch: 1,
    expectedRevision: revision,
    status,
    reservedAt: "2026-08-13T00:00:10.000Z",
    ...(status === "pending" ? {} : { finishedAt: "2026-08-13T00:00:11.000Z" }),
  };
}

function turn(
  index: number,
  options: {
    topicEpoch?: number;
    revision?: number;
    finalized?: boolean;
    error?: string;
    legacy?: boolean;
    schedule?: PendingCurationSchedule;
  } = {},
): SessionState {
  const turnKey = `turn-${index}`;
  return {
    turnKey,
    timestamps: {
      start: `2026-08-13T00:00:${String(index).padStart(2, "0")}.000Z`,
      ...(options.finalized === false
        ? {}
        : {
            end: `2026-08-13T00:01:${String(index).padStart(2, "0")}.000Z`,
          }),
    },
    ...(options.error ? { error: options.error } : {}),
    intent: options.legacy
      ? {}
      : {
          recommendationState: {
            topicEpoch: options.topicEpoch ?? 1,
            curationRevision: options.revision ?? 0,
            candidates: [],
            ...(options.schedule ? { curationSchedule: options.schedule } : {}),
          },
        },
  };
}

function session(
  turns: readonly SessionState[],
  curation: SessionCurationRecord = CURATION,
  sessionId = "session-a",
): SessionData {
  return {
    sessionId,
    agentId: "main",
    curation,
    history: turns.slice(0, -1),
    current: turns.at(-1) ?? {},
  };
}

function accepted(...turnKeys: string[]): ReadonlySet<string> {
  return new Set(turnKeys.map((key) => `session-a:turn:${key}`));
}

describe("evaluateCurationCadence", () => {
  it.each([
    { count: 0, eligible: false, schedulingTurnKey: undefined },
    { count: 1, eligible: true, schedulingTurnKey: "turn-1" },
    { count: 2, eligible: true, schedulingTurnKey: "turn-1" },
    { count: 3, eligible: true, schedulingTurnKey: "turn-1" },
    { count: 4, eligible: true, schedulingTurnKey: "turn-1" },
  ])(
    "selects the earliest unattempted boundary starting at turn 1 at count $count",
    (fixture) => {
      const finalizedTurns = Array.from({ length: fixture.count }, (_, index) =>
        turn(index + 1),
      );

      expect(
        evaluateCurationCadence({ curation: CURATION, finalizedTurns }),
      ).toEqual({
        eligible: fixture.eligible,
        ...(fixture.schedulingTurnKey
          ? { schedulingTurnKey: fixture.schedulingTurnKey }
          : {}),
      });
    },
  );

  it("excludes errored, prior-epoch, and legacy turns", () => {
    const finalizedTurns = [
      turn(1, { error: "failed" }),
      turn(2, { topicEpoch: 0 }),
      turn(3, { legacy: true }),
      turn(4),
    ];

    expect(
      evaluateCurationCadence({ curation: CURATION, finalizedTurns }),
    ).toEqual({ eligible: true, schedulingTurnKey: "turn-4" });
  });

  it("defers later boundaries while one schedule is pending", () => {
    const finalizedTurns = Array.from({ length: 6 }, (_, index) =>
      turn(index + 1, {
        schedule: index === 0 ? schedule("turn-1", "pending") : undefined,
      }),
    );

    expect(
      evaluateCurationCadence({ curation: CURATION, finalizedTurns }),
    ).toEqual({ eligible: false });
  });

  it.each(["failed", "obsolete"] as const)(
    "moves to turn four after turn one is %s",
    (status) => {
      const finalizedTurns = Array.from({ length: 6 }, (_, index) =>
        turn(index + 1, {
          schedule: index === 0 ? schedule("turn-1", status) : undefined,
        }),
      );

      expect(
        evaluateCurationCadence({ curation: CURATION, finalizedTurns }),
      ).toEqual({ eligible: true, schedulingTurnKey: "turn-4" });
    },
  );

  it("starts after the completed cursor and requires the current revision", () => {
    const curation = { ...CURATION, revision: 1, completedTurnCursor: 1 };
    const finalizedTurns = [
      turn(1, { schedule: schedule("turn-1", "completed") }),
      turn(2, { revision: 1 }),
      turn(3, { revision: 1 }),
      turn(4, { revision: 1 }),
    ];

    expect(evaluateCurationCadence({ curation, finalizedTurns })).toEqual({
      eligible: true,
      schedulingTurnKey: "turn-4",
    });
  });
});

describe("reconcileCurationSchedules", () => {
  it("returns only the earliest missing boundary accepted by Stats", () => {
    const turns = Array.from({ length: 6 }, (_, index) => turn(index + 1));

    expect(
      reconcileCurationSchedules({
        sessions: [session(turns)],
        acceptedEventIds: accepted(
          "turn-1",
          "turn-2",
          "turn-3",
          "turn-4",
          "turn-5",
          "turn-6",
        ),
      }),
    ).toEqual([
      {
        sessionId: "session-a",
        turnKey: "turn-1",
        expectedTopicEpoch: 1,
        expectedRevision: 0,
      },
    ]);
  });

  it("does not count a terminal turn that Stats never accepted", () => {
    const turns = [turn(1), turn(2)];

    expect(
      reconcileCurationSchedules({
        sessions: [session(turns)],
        acceptedEventIds: accepted("turn-2"),
      }),
    ).toEqual([expect.objectContaining({ turnKey: "turn-2" })]);
  });

  it("still defers reconciliation for a pending schedule outside the accepted set", () => {
    const turns = [
      turn(1, { schedule: schedule("turn-1", "pending") }),
      turn(2),
      turn(3),
      turn(4),
    ];

    expect(
      reconcileCurationSchedules({
        sessions: [session(turns)],
        acceptedEventIds: accepted("turn-2", "turn-3", "turn-4"),
      }),
    ).toEqual([]);
  });

  it("reconciles turn four after a terminal failed turn-one schedule", () => {
    const turns = Array.from({ length: 6 }, (_, index) =>
      turn(index + 1, {
        schedule: index === 0 ? schedule("turn-1", "failed") : undefined,
      }),
    );

    expect(
      reconcileCurationSchedules({
        sessions: [session(turns)],
        acceptedEventIds: accepted(
          "turn-1",
          "turn-2",
          "turn-3",
          "turn-4",
          "turn-5",
          "turn-6",
        ),
      }),
    ).toEqual([
      expect.objectContaining({
        turnKey: "turn-4",
        expectedRevision: 0,
      }),
    ]);
  });

  it("uses each session identity and preserves input session order", () => {
    const turns = [turn(1)];

    expect(
      reconcileCurationSchedules({
        sessions: [
          session(turns, CURATION, "session-b"),
          session(turns, CURATION, "session-a"),
        ],
        acceptedEventIds: new Set([
          "session-b:turn:turn-1",
          "session-a:turn:turn-1",
        ]),
      }),
    ).toEqual([
      expect.objectContaining({ sessionId: "session-b", turnKey: "turn-1" }),
      expect.objectContaining({ sessionId: "session-a", turnKey: "turn-1" }),
    ]);
  });
});

describe("validateAndCommitCuration", () => {
  const roots: string[] = [];
  const visibleSkills: AvailableSkill[] = [
    {
      name: "Alpha",
      location: "/skills/alpha",
      description: "Alpha skill",
    },
    {
      name: "Beta",
      location: "/skills/beta",
      description: "Beta skill",
    },
    {
      name: "Gamma",
      location: "/skills/gamma",
      description: "Gamma skill",
    },
  ];
  const expected: SessionCurationRecord = {
    ...CURATION,
    candidates: [
      { name: "Alpha", provenance: "historical-top" },
      { name: "Beta", provenance: "random-exploration" },
    ],
  };
  const reservation = {
    sessionId: "session-a",
    schedule: schedule("turn-1", "pending"),
  } as const;
  const proposal: CuratorProposal = {
    topicEpoch: 1,
    expectedRevision: 0,
    candidates: [" beta ", "GAMMA"],
    recommendedExperienceRefs: ["beta/verify"],
    reason: "Keep beta and add gamma.",
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function experienceCatalog(): SkillExperienceCatalog {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-scheduler-"));
    roots.push(root);
    const directory = path.join(root, "experiences", "beta");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "verify.md"),
      [
        "---",
        "skill: beta",
        "summary: Verify beta",
        "keywords:",
        "  - verify",
        "---",
        "Verify beta output.",
      ].join("\n"),
    );
    return SkillExperienceCatalog.create(root);
  }

  function deps() {
    return {
      commit: vi.fn().mockResolvedValue({
        status: "applied",
        curation: { ...expected, revision: 1 },
      }),
      finish: vi.fn().mockResolvedValue("applied"),
    };
  }

  function evidence() {
    return {
      finalizedTurns: [turn(1)],
      acceptedEventIds: accepted("turn-1"),
    };
  }

  type ValidationParams = Parameters<
    typeof validateAndCommitCurationProduction
  >[0];

  function validateAndCommitCuration(
    params: Omit<
      ValidationParams,
      "directSkills" | "finalizedTurns" | "acceptedEventIds"
    > &
      Partial<
        Pick<
          ValidationParams,
          "directSkills" | "finalizedTurns" | "acceptedEventIds"
        >
      >,
  ) {
    return validateAndCommitCurationProduction({
      ...evidence(),
      directSkills: visibleSkills,
      ...params,
    });
  }

  it("canonicalizes visible candidates and derives host-owned provenance before CAS", async () => {
    const { commit, finish } = deps();

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(commit).toHaveBeenCalledWith({
      sessionId: "session-a",
      schedulingTurnKey: "turn-1",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      expectedIntentId: "coding",
      candidates: [
        { name: "Beta", provenance: "curator-kept" },
        { name: "Gamma", provenance: "curator-added" },
      ],
      recommendedExperienceRefs: ["beta/verify"],
      completedTurnCursor: 1,
      reason: "Keep beta and add gamma.",
      now: "2026-08-13T00:02:00.000Z",
    });
    expect(finish).not.toHaveBeenCalled();
  });

  it("accepts a visible candidate discovered by curator even if absent from direct skills", async () => {
    const { commit, finish } = deps();

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal,
        visibleSkills,
        directSkills: visibleSkills.slice(0, 2),
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          { name: "Beta", provenance: "curator-kept" },
          { name: "Gamma", provenance: "curator-added" },
        ],
      }),
    );
    expect(finish).not.toHaveBeenCalled();
  });

  it("rejects a completed cursor that does not identify the accepted scheduling turn", async () => {
    const { commit, finish } = deps();

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 4,
        finalizedTurns: [turn(1)],
        acceptedEventIds: accepted("turn-1"),
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "stale" });

    expect(commit).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("accepts the verified turn-four cursor after an earlier boundary finished", async () => {
    const { commit, finish } = deps();
    const finalizedTurns = Array.from({ length: 4 }, (_, index) =>
      turn(index + 1, {
        schedule: index === 0 ? schedule("turn-1", "failed") : undefined,
      }),
    );

    await expect(
      validateAndCommitCuration({
        schedule: {
          sessionId: "session-a",
          schedule: schedule("turn-4", "pending"),
        },
        expected,
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 4,
        finalizedTurns,
        acceptedEventIds: accepted("turn-1", "turn-2", "turn-3", "turn-4"),
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        schedulingTurnKey: "turn-4",
        completedTurnCursor: 4,
      }),
    );
    expect(finish).not.toHaveBeenCalled();
  });

  it("commits no-change proposals so revision and cursor still advance", async () => {
    const { commit, finish } = deps();

    await validateAndCommitCuration({
      schedule: reservation,
      expected,
      proposal: {
        ...proposal,
        candidates: ["alpha", "BETA"],
        recommendedExperienceRefs: [],
      },
      visibleSkills,
      experienceCatalog: experienceCatalog(),
      completedTurnCursor: 1,
      now: "2026-08-13T00:02:00.000Z",
      commit,
      finish,
    });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          { name: "Alpha", provenance: "curator-kept" },
          { name: "Beta", provenance: "curator-kept" },
        ],
        completedTurnCursor: 1,
      }),
    );
  });

  it("treats a candidate absent from the current revision as curator-added", async () => {
    const { commit, finish } = deps();

    await validateAndCommitCuration({
      schedule: reservation,
      expected: {
        ...expected,
        candidates: [{ name: "Alpha", provenance: "curator-kept" }],
      },
      proposal: {
        ...proposal,
        candidates: ["Beta"],
        recommendedExperienceRefs: [],
      },
      visibleSkills,
      experienceCatalog: experienceCatalog(),
      completedTurnCursor: 1,
      now: "2026-08-13T00:02:00.000Z",
      commit,
      finish,
    });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [{ name: "Beta", provenance: "curator-added" }],
      }),
    );
  });

  it.each([0, 1, 2, 3, 1.5])(
    "rejects invalid completed cursor %s before CAS",
    async (completedTurnCursor) => {
      const { commit, finish } = deps();
      const current =
        completedTurnCursor === 1
          ? { ...expected, completedTurnCursor: 1 }
          : expected;

      await expect(
        validateAndCommitCuration({
          schedule: reservation,
          expected: current,
          proposal,
          visibleSkills,
          experienceCatalog: experienceCatalog(),
          completedTurnCursor,
          now: "2026-08-13T00:02:00.000Z",
          commit,
          finish,
        }),
      ).resolves.toMatchObject({ status: "stale" });
      expect(commit).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "failed" }),
      );
    },
  );

  it.each([
    {
      name: "invisible candidate",
      proposal: { ...proposal, candidates: ["missing"] },
    },
    {
      name: "duplicate case-variant candidate",
      proposal: { ...proposal, candidates: ["Alpha", " alpha "] },
    },
    {
      name: "experience for a removed candidate",
      proposal: { ...proposal, candidates: ["Gamma"] },
    },
    {
      name: "unresolved experience",
      proposal: { ...proposal, recommendedExperienceRefs: ["beta/missing"] },
    },
    {
      name: "duplicate resolved experience",
      proposal: {
        ...proposal,
        recommendedExperienceRefs: ["beta/verify", "beta / verify"],
      },
    },
    {
      name: "blank reason",
      proposal: { ...proposal, reason: "   " },
    },
  ])("finishes observed host-validation failure: $name", async (fixture) => {
    const { commit, finish } = deps();

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal: fixture.proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "stale" });

    expect(commit).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith({
      sessionId: "session-a",
      turnKey: "turn-1",
      expectedTopicEpoch: 1,
      expectedRevision: 0,
      outcome: "failed",
      now: "2026-08-13T00:02:00.000Z",
    });
  });

  it("finishes a schedule proven obsolete by the current curation snapshot", async () => {
    const { commit, finish } = deps();

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected: { ...expected, revision: 1 },
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "stale" });

    expect(commit).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "obsolete" }),
    );
  });

  it("leaves pending intact when a storage operation throws", async () => {
    const { finish } = deps();
    const commit = vi.fn().mockRejectedValue(new Error("lock timeout"));

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).rejects.toThrow("lock timeout");
    expect(finish).not.toHaveBeenCalled();
  });

  it("leaves pending intact when CAS reports a retryable failure", async () => {
    const { finish } = deps();
    const commit = vi.fn().mockResolvedValue({ status: "retryable-failure" });

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toEqual({ status: "retryable-failure" });
    expect(finish).not.toHaveBeenCalled();
  });

  it("finishes obsolete after an observed stale CAS race", async () => {
    const { finish } = deps();
    const commit = vi.fn().mockResolvedValue({
      status: "stale",
      curation: { ...expected, revision: 1 },
    });

    await expect(
      validateAndCommitCuration({
        schedule: reservation,
        expected,
        proposal,
        visibleSkills,
        experienceCatalog: experienceCatalog(),
        completedTurnCursor: 1,
        now: "2026-08-13T00:02:00.000Z",
        commit,
        finish,
      }),
    ).resolves.toMatchObject({ status: "stale" });
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "obsolete" }),
    );
  });
});
