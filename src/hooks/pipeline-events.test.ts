import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitPipelineEvent } from "./pipeline-events.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  emitAgentEvent: vi.fn(),
}));

const mockEmitAgentEvent = vi.mocked(emitAgentEvent);

it("does not retain the removed generated-hint pipeline phase", () => {
  const source = readFileSync(
    new URL("./pipeline-events.ts", import.meta.url),
    "utf8",
  );

  expect(source).not.toContain(["hint", "generate"].join("-"));
});

it("rounds confidence to two decimal places before emitting", () => {
  mockEmitAgentEvent.mockClear();

  emitPipelineEvent(
    { runId: "test-run" },
    "test-session",
    "qmd-hybrid",
    "completed",
    {
      intent: "meme-maker",
      confidence: 0.7688711881637573,
      reason:
        "QMD intent-examples-and-keywords match: meme-maker (vec,hyde,original)",
    },
  );

  expect(mockEmitAgentEvent).toHaveBeenCalledWith({
    runId: "test-run",
    sessionKey: "test-session",
    stream: "plugin:skill-harness",
    data: {
      kind: "skill-harness.pipeline",
      phase: "qmd-hybrid",
      state: "completed",
      sessionKey: "test-session",
      intent: "meme-maker",
      confidence: 0.77,
      reason:
        "QMD intent-examples-and-keywords match: meme-maker (vec,hyde,original)",
    },
  });
});
