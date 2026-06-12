import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { checkEvolutionTriggers } from "./trigger-checker.js";
import type { SessionState } from "./session-tracker.js";

function state(overrides: Partial<SessionState> = {}): SessionState {
  return {
    input: "Please do this",
    intent: {
      result: {
        intent: "CODE_REVIEW",
        reason: "test",
        goal: "Review code",
        confidence: 0.9,
        complexity: "medium",
      },
    },
    ...overrides,
  };
}

describe("checkEvolutionTriggers", () => {
  const triggers = resolveConfig({}).evolution.triggers;

  it("returns all matching current-turn triggers", () => {
    expect(
      checkEvolutionTriggers(
        state({
          input: "不對，應該是另一個做法",
          intent: {
            result: {
              intent: "OTHER",
              reason: "unclear",
              goal: "Unknown",
              confidence: 0.2,
              complexity: "high",
            },
          },
          toolCalls: Array.from({ length: 5 }, (_, index) => ({
            name: `tool-${index}`,
            params: {},
            error: index < 2 ? "failed" : undefined,
          })),
        }),
        10,
        triggers,
      ),
    ).toEqual([
      "skill_candidate",
      "process_gap",
      "satisfaction_check",
      "missing_intent",
      "weak_intent",
      "behavior_fix",
    ]);
  });

  it("only runs satisfaction checks on the configured turn interval", () => {
    expect(checkEvolutionTriggers(state(), 9, triggers)).not.toContain(
      "satisfaction_check",
    );
    expect(checkEvolutionTriggers(state(), 10, triggers)).toContain(
      "satisfaction_check",
    );
    expect(checkEvolutionTriggers(state(), 20, triggers)).toContain(
      "satisfaction_check",
    );
  });

  it("honors custom thresholds and disabled triggers", () => {
    const custom = resolveConfig({
      evolution: {
        triggers: {
          skillCandidate: { enabled: false },
          processGap: { toolFailures: 1 },
          satisfactionCheck: { everyTurns: 3 },
          weakIntent: { confidenceBelow: 0.95 },
          behaviorFix: { keywords: ["redo"] },
        },
      },
    }).evolution.triggers;

    expect(
      checkEvolutionTriggers(
        state({
          input: "redo this",
          toolCalls: [{ name: "exec", params: {}, error: "failed" }],
        }),
        3,
        custom,
      ),
    ).toEqual([
      "process_gap",
      "satisfaction_check",
      "weak_intent",
      "behavior_fix",
    ]);
  });
});
