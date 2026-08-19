import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getOrCache } from "./singleton.js";

describe("getOrCache", () => {
  it("normalizes keys, creates once, and runs retrieval hooks", () => {
    const cache = new Map<string, { key: string }>();
    const create = vi.fn((key: string) => ({ key }));
    const onRetrieve = vi.fn();

    const first = getOrCache(cache, ".", create, onRetrieve);
    const second = getOrCache(cache, path.resolve("."), create, onRetrieve);

    expect(first).toBe(second);
    expect(first.key).toBe(path.resolve("."));
    expect(create).toHaveBeenCalledTimes(1);
    expect(onRetrieve).toHaveBeenCalledTimes(2);
    expect(onRetrieve).toHaveBeenNthCalledWith(1, first);
    expect(onRetrieve).toHaveBeenNthCalledWith(2, first);
  });
});
