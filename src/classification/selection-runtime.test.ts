import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { logger } from "../../api.js";
import { evaluateSelection, selectDecisionRoute } from "./selection-runtime.js";

const batch = {
  state: { latest_message: "Review changes" },
  questions: { skill_0: { type: "boolean" as const, instructions: "Useful?" } },
};
const result = {
  model: "host-model",
  answers: { skill_0: { type: "boolean", probabilityTrue: 0.9 } },
};

function fixture(agentModel: unknown, globalModel: unknown) {
  const evaluate = vi.fn().mockResolvedValue({ status: "ok", result });
  const legacy = vi.fn().mockResolvedValue(result);
  const api = {
    config: {
      agents: {
        defaults: { decisionModel: globalModel },
        entries: { main: { decisionModel: agentModel } },
      },
    },
    runtime: { decisions: { evaluate } },
  } as unknown as OpenClawPluginApi;
  return {
    api,
    evaluate,
    legacy,
    agentId: "main",
    batch,
    timeoutMs: 60_000,
    signal: new AbortController().signal,
  };
}

describe("Decision selection runtime", () => {
  it("does not read the global model for explicit-empty agent selection", () => {
    const global = vi.fn(() => "typesafe/host");
    expect(selectDecisionRoute(" ", global)).toBe("legacy");
    expect(global).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 12])(
    "inherits the global model for non-string agent setting %j",
    (agent) => {
      expect(selectDecisionRoute(agent, () => "typesafe/host")).toBe("host");
    },
  );

  it.each(["typesafe/agent", undefined])(
    "uses host once with owning agent and a capped deadline",
    async (agentModel) => {
      const f = fixture(agentModel, "typesafe/global");
      expect(await evaluateSelection(f)).toEqual(result);
      expect(f.evaluate).toHaveBeenCalledExactlyOnceWith(
        batch,
        expect.objectContaining({
          agentId: "main",
          timeoutMs: 30_000,
          signal: f.signal,
          purpose: "skill-harness.unified-selection",
          rubricVersion: "1",
        }),
      );
      expect(f.legacy).not.toHaveBeenCalled();
    },
  );

  it.each(["", "  "])(
    "selects only the plugin adapter when the agent disables host with %j",
    async (agentModel) => {
      const f = fixture(agentModel, "typesafe/global");
      await evaluateSelection(f);
      expect(f.evaluate).not.toHaveBeenCalled();
      expect(f.legacy).toHaveBeenCalledOnce();
    },
  );

  it("does not retry or call legacy after unavailable, invalid outcome, or throw", async () => {
    for (const response of [
      { status: "unavailable", reason: "deadline" },
      undefined,
    ]) {
      const f = fixture("typesafe/agent", "typesafe/global");
      f.evaluate.mockResolvedValue(response);
      expect(await evaluateSelection(f)).toBeUndefined();
      expect(f.evaluate).toHaveBeenCalledOnce();
      expect(f.legacy).not.toHaveBeenCalled();
    }
    const f = fixture("typesafe/agent", undefined);
    f.evaluate.mockRejectedValue(new Error("private provider payload"));
    expect(await evaluateSelection(f)).toBeUndefined();
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("reports allowlisted host reasons without logging untrusted provider values", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const reason of ["deadline", "private-provider-value"]) {
        const f = fixture("typesafe/agent", undefined);
        f.evaluate.mockResolvedValue({ status: "unavailable", reason });
        await evaluateSelection(f);
      }
      expect(warn.mock.calls[0][0]).toContain("reason=deadline");
      expect(warn.mock.calls[1][0]).toContain("reason=invalid-response");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "private-provider-value",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not call any model for an empty or oversized batch", async () => {
    for (const input of [
      { ...batch, questions: {} },
      { ...batch, state: "x".repeat(1024 * 1024) },
      {
        ...batch,
        questions: Object.fromEntries(
          Array.from({ length: 257 }, (_, i) => [
            `q${i}`,
            batch.questions.skill_0,
          ]),
        ),
      },
    ]) {
      const f = fixture("typesafe/agent", undefined);
      expect(await evaluateSelection({ ...f, batch: input })).toBeUndefined();
      expect(f.evaluate).not.toHaveBeenCalled();
      expect(f.legacy).not.toHaveBeenCalled();
    }
  });

  it("rejects non-finite or accessor evidence without invoking the accessor", async () => {
    const getter = vi.fn(() => "private evidence");
    for (const state of [
      { n: Infinity },
      Object.defineProperty({}, "text", { get: getter, enumerable: true }),
    ]) {
      const f = fixture("typesafe/agent", undefined);
      expect(
        await evaluateSelection({ ...f, batch: { ...batch, state } }),
      ).toBeUndefined();
      expect(f.evaluate).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects hidden serialization hooks without executing them", async () => {
    const toJSON = vi.fn(() => "private evidence");
    const f = fixture("typesafe/agent", undefined);
    const state = Object.defineProperty({}, "toJSON", { value: toJSON });
    expect(
      await evaluateSelection({ ...f, batch: { ...batch, state } }),
    ).toBeUndefined();
    expect(toJSON).not.toHaveBeenCalled();
    expect(f.evaluate).not.toHaveBeenCalled();
  });

  it("rejects a host result that arrives after cancellation without calling legacy", async () => {
    const f = fixture("typesafe/agent", undefined);
    const controller = new AbortController();
    let complete!: (value: unknown) => void;
    f.evaluate.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = evaluateSelection({ ...f, signal: controller.signal });
    controller.abort();
    complete({ status: "ok", result });
    await expect(pending).rejects.toThrow();
    expect(f.evaluate).toHaveBeenCalledOnce();
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("never admits an already aborted operation or starts fallback after cancellation", async () => {
    const f = fixture("typesafe/agent", undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluateSelection({ ...f, signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
  });
});
