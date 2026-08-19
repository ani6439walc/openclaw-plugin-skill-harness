import { describe, expect, it, vi } from "vitest";
import { createCurationQueue } from "./queue.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((value) => {
    resolve = value;
  });
  return { promise, resolve };
}

describe("createCurationQueue", () => {
  it("deduplicates pending keys and runs distinct tasks serially", async () => {
    const queue = createCurationQueue();
    const releaseFirst = deferred();
    const secondFinished = deferred();
    const order: string[] = [];

    expect(
      queue.enqueue("session:1:0:turn-3", async () => {
        order.push("first:start");
        await releaseFirst.promise;
        order.push("first:end");
      }),
    ).toBe(true);
    expect(queue.enqueue("session:1:0:turn-3", async () => {})).toBe(false);
    expect(
      queue.enqueue("session:1:1:turn-6", async () => {
        order.push("second");
        secondFinished.resolve();
      }),
    ).toBe(true);

    expect(queue.has("session:1:0:turn-3")).toBe(true);
    expect(queue.has("session:1:1:turn-6")).toBe(true);
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await secondFinished.promise;
    await vi.waitFor(() => {
      expect(queue.has("session:1:1:turn-6")).toBe(false);
    });

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.has("session:1:0:turn-3")).toBe(false);
    expect(queue.has("session:1:1:turn-6")).toBe(false);
  });

  it("releases failed keys without poisoning the queue tail", async () => {
    const queue = createCurationQueue();
    const afterFailure = deferred();
    const order: string[] = [];

    expect(
      queue.enqueue("failed", async () => {
        order.push("failed");
        throw new Error("curator failed");
      }),
    ).toBe(true);
    expect(
      queue.enqueue("after", async () => {
        order.push("after");
        afterFailure.resolve();
      }),
    ).toBe(true);

    await afterFailure.promise;
    await Promise.resolve();

    expect(order).toEqual(["failed", "after"]);
    expect(queue.has("failed")).toBe(false);
    expect(queue.enqueue("failed", async () => {})).toBe(true);
  });

  it("keeps pending keys and tails isolated per queue instance", async () => {
    const firstQueue = createCurationQueue();
    const secondQueue = createCurationQueue();
    const firstRelease = deferred();
    const secondFinished = deferred();

    expect(
      firstQueue.enqueue("shared", async () => {
        await firstRelease.promise;
      }),
    ).toBe(true);
    expect(
      secondQueue.enqueue("shared", async () => {
        secondFinished.resolve();
      }),
    ).toBe(true);

    await secondFinished.promise;
    await vi.waitFor(() => {
      expect(secondQueue.has("shared")).toBe(false);
    });
    expect(firstQueue.has("shared")).toBe(true);
    expect(secondQueue.has("shared")).toBe(false);

    firstRelease.resolve();
  });
});
