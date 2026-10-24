import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { resolveConfig } from "../config.js";
import { runJevUnifiedRouting } from "./jev-client.js";

describe("unified host selection", () => {
  function fixture() {
    const evaluate = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        model: "host",
        answers: { skill_review: { type: "boolean", probabilityTrue: 0.9 } },
      },
    });
    const systemOne = vi.fn();
    return {
      evaluate,
      systemOne,
      params: {
        api: {
          config: { agents: { defaults: { decisionModel: "typesafe/host" } } },
          runtime: { decisions: { evaluate } },
        } as unknown as OpenClawPluginApi,
        config: resolveConfig({}),
        agentId: "main",
        latest: "Review my change",
        candidateSkills: [
          {
            name: "review",
            location: "/review",
            description: "Review changes",
          },
        ],
        client: { systemOne } as unknown as TypeSafeClient,
      },
    };
  }

  it("uses one host batch and the common selection policy without plugin credentials", async () => {
    const f = fixture();
    expect(await runJevUnifiedRouting(f.params)).toMatchObject({
      skills: ["review"],
      confidence: 0.9,
    });
    expect(f.evaluate).toHaveBeenCalledOnce();
    expect(f.systemOne).not.toHaveBeenCalled();
  });

  it("does not call either model for an empty pool", async () => {
    const f = fixture();
    expect(
      await runJevUnifiedRouting({ ...f.params, candidateSkills: [] }),
    ).toMatchObject({ skills: [], experiences: [], confidence: 0 });
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.systemOne).not.toHaveBeenCalled();
  });

  it("rejects the complete host batch for missing, unexpected or invalid answers", async () => {
    for (const answers of [
      {},
      { skill_review: { type: "boolean", probabilityTrue: NaN } },
      {
        skill_review: { type: "boolean", probabilityTrue: 0.9 },
        invented: { type: "boolean", probabilityTrue: 1 },
      },
    ]) {
      const f = fixture();
      f.evaluate.mockResolvedValue({
        status: "ok",
        result: { model: "host", answers },
      });
      expect(await runJevUnifiedRouting(f.params)).toBeUndefined();
      expect(f.evaluate).toHaveBeenCalledOnce();
      expect(f.systemOne).not.toHaveBeenCalled();
    }
  });
});
