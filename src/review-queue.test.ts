import { describe, expect, it } from "vitest";
import { ReviewQueue } from "./review-queue.js";

describe("ReviewQueue", () => {
  it("runs background tasks sequentially and continues after failure", async () => {
    const queue = new ReviewQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      await Promise.resolve();
      order.push(1);
    });
    queue.enqueue(async () => {
      order.push(2);
      throw new Error("failed");
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    await queue.onIdle();
    expect(order).toEqual([1, 2, 3]);
  });
});
