import { describe, expect, it, vi } from "vitest";
import { IntentReviewScheduler, type ReviewCandidate } from "./scheduler.js";
import type { ReviewSnapshot } from "./types.js";

function createMockCandidate(
  overrides?: Partial<ReviewCandidate>,
): ReviewCandidate {
  const snapshot: ReviewSnapshot = {
    sessionId: "sess-1",
    sessionKey: "agent:main:sess-1",
    agentId: "main",
    eventId: "evt-1",
    turnNumber: 1,
    current: { timestamps: { start: new Date().toISOString() } },
    recent: [],
    intentCatalog: [],
  };

  return {
    agentId: "main",
    sessionKey: "agent:main:sess-1",
    ctx: {
      sessionId: "sess-1",
      sessionKey: "agent:main:sess-1",
      runId: "run-1",
    },
    resolvedConfig: {} as any,
    modelRef: { provider: "mock", model: "model-1" },
    snapshot,
    triggers: ["intent-health-check"],
    ...overrides,
  };
}

describe("IntentReviewScheduler", () => {
  it("debounces multiple turns in the same session and reviews only the latest candidate", async () => {
    const executed: ReviewCandidate[] = [];
    const discarded: ReviewCandidate[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 20,
      runReview: async (candidate) => {
        executed.push(candidate);
      },
      onDiscard: (candidate) => {
        discarded.push(candidate);
      },
    });

    const c1 = createMockCandidate({
      snapshot: { ...createMockCandidate().snapshot, eventId: "turn-1" },
    });
    const c2 = createMockCandidate({
      snapshot: { ...createMockCandidate().snapshot, eventId: "turn-2" },
    });
    const c3 = createMockCandidate({
      snapshot: { ...createMockCandidate().snapshot, eventId: "turn-3" },
    });

    expect(scheduler.schedule(c1)).toBe(true);
    expect(scheduler.getPendingCount()).toBe(1);

    // Immediate subsequent turns
    expect(scheduler.schedule(c2)).toBe(true);
    expect(scheduler.schedule(c3)).toBe(true);

    expect(discarded).toEqual([c1, c2]);

    await scheduler.waitForIdle();

    expect(executed).toHaveLength(1);
    expect(executed[0].snapshot.eventId).toBe("turn-3");
    expect(scheduler.getPendingCount()).toBe(0);
  });

  it("handles different sessions independently", async () => {
    const executed: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 15,
      runReview: async (candidate) => {
        executed.push(candidate.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-1" },
    });
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-2" },
    });

    scheduler.schedule(c1);
    scheduler.schedule(c2);
    expect(scheduler.getPendingCount()).toBe(2);

    await scheduler.waitForIdle();

    expect(executed).toContain("sess-1");
    expect(executed).toContain("sess-2");
    expect(executed).toHaveLength(2);
  });

  it("enforces concurrency limit (max 1 review in flight) and retries idle after backoff", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((res) => {
      resolveFirst = res;
    });

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 10,
      retryIdleMs: 15,
      runReview: async (candidate) => {
        order.push(`start:${candidate.snapshot.sessionId}`);
        if (candidate.snapshot.sessionId === "sess-1") {
          await firstBlocked;
        }
        order.push(`finish:${candidate.snapshot.sessionId}`);
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-1" },
    });
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-2" },
    });

    scheduler.schedule(c1);
    // Wait for first to start running
    await new Promise((r) => setTimeout(r, 20));
    expect(scheduler.isReviewInFlight()).toBe(true);

    // Schedule second while first is in flight
    scheduler.schedule(c2);

    // Wait until second timer fires once and hits backoff
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start:sess-1"]);

    // Complete first review
    resolveFirst!();

    await scheduler.waitForIdle();

    expect(order).toEqual([
      "start:sess-1",
      "finish:sess-1",
      "start:sess-2",
      "finish:sess-2",
    ]);
  });

  it("backs off when isSystemActive returns true", async () => {
    let systemActive = true;
    const executed: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 10,
      retryIdleMs: 15,
      isSystemActive: () => systemActive,
      runReview: async (candidate) => {
        executed.push(candidate.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate();
    scheduler.schedule(c1);

    // Timer expires while system is active
    await new Promise((r) => setTimeout(r, 25));
    expect(executed).toHaveLength(0);
    expect(scheduler.getPendingCount()).toBe(1);

    // Now system becomes idle
    systemActive = false;
    await scheduler.waitForIdle();

    expect(executed).toEqual(["sess-1"]);
  });

  it("evicts oldest pending entry when maxPending is exceeded", async () => {
    const discarded: string[] = [];
    const executed: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 40,
      maxPending: 2,
      onDiscard: (candidate) => {
        discarded.push(candidate.snapshot.sessionId);
      },
      runReview: async (candidate) => {
        executed.push(candidate.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-1" },
    });
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-2" },
    });
    const c3 = createMockCandidate({
      sessionKey: "agent:main:sess-3",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-3" },
    });

    scheduler.schedule(c1);
    scheduler.schedule(c2);
    expect(scheduler.getPendingCount()).toBe(2);

    // Scheduling 3rd should evict sess-1
    scheduler.schedule(c3);
    expect(scheduler.getPendingCount()).toBe(2);
    expect(discarded).toEqual(["sess-1"]);

    await scheduler.waitForIdle();
    expect(executed).toEqual(["sess-2", "sess-3"]);
  });

  it("rejects scheduling and drops pending reviews when gateway is draining", async () => {
    let draining = false;
    const discarded: string[] = [];
    const executed: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 15,
      isDraining: () => draining,
      onDiscard: (c) => discarded.push(c.snapshot.sessionId),
      runReview: async (c) => {
        executed.push(c.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-1" },
    });

    scheduler.schedule(c1);

    // Now gateway starts draining before timer fires
    draining = true;

    await scheduler.waitForIdle();

    expect(executed).toHaveLength(0);
    expect(discarded).toEqual(["sess-1"]);

    // Any new schedule while draining is rejected immediately
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-2" },
    });
    expect(scheduler.schedule(c2)).toBe(false);
  });

  it("cancels pending reviews and aborts in-flight review on dispose", async () => {
    let inFlightAborted = false;
    let resolveRunner: (() => void) | undefined;
    const runnerStarted = new Promise<void>((res) => {
      resolveRunner = res;
    });

    const discarded: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 10,
      onDiscard: (c) => discarded.push(c.snapshot.sessionId),
      runReview: async (candidate, abortSignal) => {
        resolveRunner!();
        await new Promise<void>((res) => {
          abortSignal.addEventListener("abort", () => {
            inFlightAborted = true;
            res();
          });
        });
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-1" },
    });
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-2" },
    });

    scheduler.schedule(c1);
    await runnerStarted;

    // c2 is pending in timer while c1 is running
    scheduler.schedule(c2);
    expect(scheduler.getPendingCount()).toBe(1);

    // Dispose
    scheduler.dispose();

    expect(scheduler.isDisposed()).toBe(true);
    expect(scheduler.getPendingCount()).toBe(0);
    expect(discarded).toEqual(["sess-2"]);
    expect(inFlightAborted).toBe(true);

    // Subsequent schedule attempts return false
    expect(scheduler.schedule(c1)).toBe(false);
  });

  it("recovers and stays operational when runReview throws", async () => {
    let attempts = 0;
    const executed: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 10,
      runReview: async (c) => {
        attempts++;
        if (attempts === 1) {
          throw new Error("simulated subagent failure");
        }
        executed.push(c.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-1" },
    });
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: { ...createMockCandidate().snapshot, sessionId: "sess-2" },
    });

    scheduler.schedule(c1);
    await scheduler.waitForIdle();
    expect(attempts).toBe(1);
    expect(executed).toHaveLength(0);
    expect(scheduler.isReviewInFlight()).toBe(false);

    // Next schedule should work normally
    scheduler.schedule(c2);
    await scheduler.waitForIdle();
    expect(attempts).toBe(2);
    expect(executed).toEqual(["sess-2"]);
  });

  it("clear cancels all pending reviews without disposing", async () => {
    const discarded: string[] = [];
    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 20,
      onDiscard: (c) => discarded.push(c.snapshot.sessionId),
    });

    const c1 = createMockCandidate();
    scheduler.schedule(c1);
    expect(scheduler.getPendingCount()).toBe(1);

    scheduler.clear();
    expect(scheduler.getPendingCount()).toBe(0);
    expect(scheduler.isDisposed()).toBe(false);
    expect(discarded).toEqual(["sess-1"]);

    // Can still schedule after clear()
    expect(scheduler.schedule(c1)).toBe(true);
    expect(scheduler.getPendingCount()).toBe(1);
    scheduler.clear();
  });

  it("freshens LRU order when updating an existing session so active sessions are not prematurely evicted", async () => {
    const discardedEventIds: string[] = [];
    const executed: string[] = [];

    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 40,
      maxPending: 2,
      onDiscard: (candidate) => {
        discardedEventIds.push(candidate.snapshot.eventId);
      },
      runReview: async (candidate) => {
        executed.push(candidate.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: {
        ...createMockCandidate().snapshot,
        sessionId: "sess-1",
        eventId: "turn-1",
      },
    });
    const c2 = createMockCandidate({
      sessionKey: "agent:main:sess-2",
      snapshot: {
        ...createMockCandidate().snapshot,
        sessionId: "sess-2",
        eventId: "turn-sess-2",
      },
    });

    // sess-1 first, then sess-2
    scheduler.schedule(c1);
    scheduler.schedule(c2);

    // Freshen sess-1 with a new turn
    const c1Updated = createMockCandidate({
      sessionKey: "agent:main:sess-1",
      snapshot: {
        ...createMockCandidate().snapshot,
        sessionId: "sess-1",
        eventId: "turn-2",
      },
    });
    scheduler.schedule(c1Updated);
    expect(discardedEventIds).toEqual(["turn-1"]);

    // Now sess-2 is the oldest (LRU). Adding sess-3 should evict sess-2, NOT sess-1
    const c3 = createMockCandidate({
      sessionKey: "agent:main:sess-3",
      snapshot: {
        ...createMockCandidate().snapshot,
        sessionId: "sess-3",
        eventId: "turn-sess-3",
      },
    });
    scheduler.schedule(c3);

    expect(discardedEventIds).toEqual(["turn-1", "turn-sess-2"]);

    await scheduler.waitForIdle();
    expect(executed).toEqual(["sess-1", "sess-3"]);
  });

  it("safely catches synchronous errors from isSystemActive without uncaughtException", async () => {
    const discarded: string[] = [];
    const scheduler = new IntentReviewScheduler({
      idleDelayMs: 10,
      isSystemActive: () => {
        throw new TypeError("synchronous type error in active check");
      },
      onDiscard: (candidate) => {
        discarded.push(candidate.snapshot.sessionId);
      },
    });

    const c1 = createMockCandidate();
    scheduler.schedule(c1);

    await scheduler.waitForIdle();
    expect(discarded).toEqual(["sess-1"]);
    expect(scheduler.getPendingCount()).toBe(0);
  });

  it("waitForIdle resolves immediately when nothing is pending or in flight", async () => {
    const scheduler = new IntentReviewScheduler();
    await expect(scheduler.waitForIdle()).resolves.toBeUndefined();
  });
});
