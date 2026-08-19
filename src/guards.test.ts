import { describe, expect, it } from "vitest";
import { isRecord } from "./guards.js";

describe("isRecord", () => {
  it("accepts ordinary and null-prototype objects", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it.each([null, [], new Error("failure"), new Date(), "value", 1])(
    "rejects non-plain value %#",
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
