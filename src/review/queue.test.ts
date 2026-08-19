import { describe, expect, it } from "vitest";
import { enqueueReview, waitForReviewQueueIdle } from "./queue.js";

describe("review queue", () => {
  it("runs background tasks sequentially and continues after failure", async () => {
    const order: number[] = [];

    enqueueReview(async () => {
      await Promise.resolve();
      order.push(1);
    });
    enqueueReview(async () => {
      order.push(2);
      throw new Error("failed");
    });
    enqueueReview(async () => {
      order.push(3);
    });

    await waitForReviewQueueIdle();
    expect(order).toEqual([1, 2, 3]);
  });
});
