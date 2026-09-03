import { describe, expect, it } from "vitest";
import { weightedReciprocalRankFusion } from "./rrf.js";

describe("weightedReciprocalRankFusion", () => {
  it("sums weighted reciprocal ranks across lists", () => {
    const fused = weightedReciprocalRankFusion({
      lists: [
        [{ id: "a" }, { id: "b" }],
        [{ id: "b" }, { id: "a" }],
      ],
      weights: [1, 1],
      k: 60,
    });

    expect(fused.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("lets a higher-weight list dominate ranking", () => {
    const fused = weightedReciprocalRankFusion({
      lists: [
        [{ id: "meta-hit" }, { id: "body-hit" }],
        [{ id: "body-hit" }, { id: "meta-hit" }],
      ],
      weights: [2, 0.5],
      k: 60,
    });

    expect(fused[0]?.id).toBe("meta-hit");
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
  });

  it("uses a stable id tie-break when scores match", () => {
    const fused = weightedReciprocalRankFusion({
      lists: [[{ id: "zeta" }], [{ id: "alpha" }]],
      weights: [1, 1],
      k: 60,
    });

    expect(fused.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 10);
  });

  it("defaults missing weights to 1 and skips empty lists", () => {
    const fused = weightedReciprocalRankFusion({
      lists: [[], [{ id: "only" }], [{ id: "only" }, { id: "second" }]],
      k: 10,
    });

    expect(fused).toEqual([
      { id: "only", score: 1 / 11 + 1 / 11 },
      { id: "second", score: 1 / 12 },
    ]);
  });
});
