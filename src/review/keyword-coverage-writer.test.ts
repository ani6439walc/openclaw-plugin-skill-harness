import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KeywordCoverageWriter } from "./keyword-coverage-writer.js";

const sourceEventId = "session-123:2026-08-08T00:00:00.000Z";

describe("KeywordCoverageWriter", () => {
  let root: string;
  let writer: KeywordCoverageWriter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "keyword-coverage-writer-"));
    writer = new KeywordCoverageWriter(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates keyword state and applies an event only once", async () => {
    const input = {
      eventId: sourceEventId,
      policy: "ordinary" as const,
      targets: ["successful-pattern"] as const,
      mutations: [
        {
          target: "successful-pattern" as const,
          add: ["ship it"],
          remove: [],
        },
      ],
      nowMs: Date.parse("2026-08-08T00:01:00.000Z"),
    };

    expect(await writer.recordKeywordEvent(input)).toBe("applied");
    expect(await writer.recordKeywordEvent(input)).toBe("already-applied");

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "keyword-coverage.json"), "utf8"),
    );
    expect(log.triggerKeywords.successfulPattern).toContain("ship it");
    expect(JSON.stringify(log)).not.toContain(sourceEventId);
    expect(Object.keys(log.processedKeywordEvents)).toHaveLength(1);
  });

  it("applies no-finding events idempotently without changing keywords", async () => {
    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:nofinding",
        policy: "ordinary",
        targets: ["behavior-fix"],
        mutations: [],
        nowMs: Date.parse("2026-08-08T00:01:00.000Z"),
      }),
    ).toBe("applied");
    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:nofinding",
        policy: "ordinary",
        targets: ["behavior-fix"],
        mutations: [],
      }),
    ).toBe("already-applied");

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "keyword-coverage.json"), "utf8"),
    );
    expect(Object.keys(log.processedKeywordEvents)[0]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(Object.values(log.processedKeywordEvents)[0]).toMatchObject({
      outcome: "nofinding",
      mutations: [],
    });
  });

  it("rejects mutations that exceed the caller policy without creating state", async () => {
    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:coverage-over-cap",
        policy: "coverage",
        targets: ["successful-pattern"],
        mutations: [
          {
            target: "successful-pattern",
            add: ["one", "two"],
            remove: [],
          },
        ],
      }),
    ).toBe("retryable-failure");
    expect(fs.existsSync(path.join(root, "keyword-coverage.json"))).toBe(false);
  });

  it("rejects normalized add/remove conflicts without creating state", async () => {
    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:conflict",
        policy: "coverage",
        targets: ["successful-pattern"],
        mutations: [
          {
            target: "successful-pattern",
            add: ["Ship It"],
            remove: ["ship it"],
          },
        ],
      }),
    ).toBe("retryable-failure");
    expect(fs.existsSync(path.join(root, "keyword-coverage.json"))).toBe(false);
  });

  it("rejects mutations outside requested targets and split conflicts", async () => {
    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:outside-target",
        policy: "coverage",
        targets: ["successful-pattern"],
        mutations: [{ target: "behavior-fix", add: ["repair"], remove: [] }],
      }),
    ).toBe("retryable-failure");
    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:split-conflict",
        policy: "coverage",
        targets: ["successful-pattern"],
        mutations: [
          { target: "successful-pattern", add: ["ship it"], remove: [] },
          { target: "successful-pattern", add: [], remove: ["Ship It"] },
        ],
      }),
    ).toBe("retryable-failure");
    expect(fs.existsSync(path.join(root, "keyword-coverage.json"))).toBe(false);
  });

  it("reserves an epoch once and releases it for a later retry", async () => {
    const reservation = {
      epochKey: "a".repeat(64),
      targets: ["successful-pattern", "behavior-fix"] as const,
      acceptedTurn: 50,
      nowMs: Date.parse("2026-08-08T00:01:00.000Z"),
    };

    expect(await writer.reserveCoverageEpoch(reservation)).toBe("applied");
    expect(await writer.reserveCoverageEpoch(reservation)).toBe(
      "already-applied",
    );
    expect(await writer.releaseCoverageEpoch(reservation)).toBe("applied");
    expect(await writer.reserveCoverageEpoch(reservation)).toBe("applied");
  });

  it("replaces a stale pending reservation instead of blocking coverage forever", async () => {
    const reservation = {
      epochKey: "d".repeat(64),
      targets: ["entity-context"] as const,
      acceptedTurn: 50,
      nowMs: Date.parse("2026-08-01T00:00:00.000Z"),
    };
    await writer.reserveCoverageEpoch(reservation);

    expect(
      await writer.reserveCoverageEpoch({
        ...reservation,
        nowMs: Date.parse("2026-08-02T00:01:00.000Z"),
      }),
    ).toBe("applied");
  });

  it("rejects non-opaque epoch keys before creating state", async () => {
    expect(
      await writer.reserveCoverageEpoch({
        epochKey: "session-123",
        targets: ["entity-context"],
        acceptedTurn: 50,
      }),
    ).toBe("retryable-failure");
    expect(fs.existsSync(path.join(root, "keyword-coverage.json"))).toBe(false);
  });

  it("completes a reserved epoch and advances only its target watermarks", async () => {
    const reservation = {
      epochKey: "c".repeat(64),
      targets: ["successful-pattern", "behavior-fix"] as const,
      acceptedTurn: 50,
      nowMs: Date.parse("2026-08-08T00:01:00.000Z"),
    };
    await writer.reserveCoverageEpoch(reservation);

    expect(
      await writer.completeCoverageEpoch({
        epochKey: reservation.epochKey,
        outcome: "nofinding",
        nowMs: Date.parse("2026-08-08T00:02:00.000Z"),
      }),
    ).toBe("applied");

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "keyword-coverage.json"), "utf8"),
    );
    expect(log.coverageEpochs[reservation.epochKey]).toMatchObject({
      outcome: "nofinding",
      completedAt: "2026-08-08T00:02:00.000Z",
    });
    expect(log.targets["successful-pattern"]).toMatchObject({
      lastCompletedAcceptedTurn: 50,
    });
    expect(log.targets["behavior-fix"]).toMatchObject({
      lastCompletedAcceptedTurn: 50,
    });
    expect(log.targets["entity-context"]).toBeUndefined();
    expect(await writer.releaseCoverageEpoch(reservation)).toBe(
      "already-applied",
    );
  });

  it("keeps target watermarks monotonic when epochs complete out of order", async () => {
    await writer.reserveCoverageEpoch({
      epochKey: "e".repeat(64),
      targets: ["entity-context"],
      acceptedTurn: 100,
    });
    await writer.reserveCoverageEpoch({
      epochKey: "f".repeat(64),
      targets: ["entity-context"],
      acceptedTurn: 50,
    });
    await writer.completeCoverageEpoch({
      epochKey: "e".repeat(64),
      outcome: "nofinding",
    });
    await writer.completeCoverageEpoch({
      epochKey: "f".repeat(64),
      outcome: "nofinding",
    });

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "keyword-coverage.json"), "utf8"),
    );
    expect(log.targets["entity-context"].lastCompletedAcceptedTurn).toBe(100);
  });

  it("preserves malformed state instead of replacing it with defaults", async () => {
    const logPath = path.join(root, "keyword-coverage.json");
    fs.writeFileSync(logPath, "{ malformed");

    expect(
      await writer.recordKeywordEvent({
        eventId: "session-123:malformed",
        policy: "ordinary",
        targets: ["entity-context"],
        mutations: [],
      }),
    ).toBe("retryable-failure");
    expect(fs.readFileSync(logPath, "utf8")).toBe("{ malformed");
  });

  it("prunes expired processed events within a later locked write", async () => {
    await writer.recordKeywordEvent({
      eventId: "session-123:old",
      policy: "ordinary",
      targets: ["entity-context"],
      mutations: [],
      nowMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });
    await writer.recordKeywordEvent({
      eventId: "session-123:new",
      policy: "ordinary",
      targets: ["entity-context"],
      mutations: [],
      nowMs: Date.parse("2026-08-01T00:00:00.000Z"),
    });

    const log = JSON.parse(
      fs.readFileSync(path.join(root, "keyword-coverage.json"), "utf8"),
    );
    expect(Object.keys(log.processedKeywordEvents)).toHaveLength(1);
  });

  it("persists pruning before returning an expired duplicate event", async () => {
    await writer.recordKeywordEvent({
      eventId: "session-123:expired",
      policy: "ordinary" as const,
      targets: ["entity-context"] as const,
      mutations: [],
      nowMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });
    const duplicate = {
      eventId: "session-123:fresh-duplicate",
      policy: "ordinary" as const,
      targets: ["entity-context"] as const,
      mutations: [],
      nowMs: Date.parse("2026-07-15T00:00:00.000Z"),
    };
    await writer.recordKeywordEvent(duplicate);

    expect(
      await writer.recordKeywordEvent({
        ...duplicate,
        nowMs: Date.parse("2026-08-01T00:00:00.000Z"),
      }),
    ).toBe("already-applied");
    const log = JSON.parse(
      fs.readFileSync(path.join(root, "keyword-coverage.json"), "utf8"),
    );
    expect(Object.keys(log.processedKeywordEvents)).toHaveLength(1);
    expect(Object.values(log.processedKeywordEvents)[0]).toMatchObject({
      processedAt: "2026-07-15T00:00:00.000Z",
    });
  });
});
