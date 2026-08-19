import { describe, expect, it } from "vitest";
import {
  extractEmbeddedRunError,
  formatEmbeddedError,
} from "./subagent-runtime.js";

describe("formatEmbeddedError", () => {
  it("formats plain-object errors", () => {
    expect(formatEmbeddedError({ kind: "timeout", message: "expired" })).toBe(
      "timeout: expired",
    );
  });

  it("formats Error instances", () => {
    expect(formatEmbeddedError(new Error("timeout"))).toBe("timeout");
  });

  it.each([[], null, 42])("ignores unsupported error value %#", (error) => {
    expect(formatEmbeddedError(error)).toBeUndefined();
  });

  it("trims string errors", () => {
    expect(formatEmbeddedError("  timeout  ")).toBe("timeout");
  });
});

describe("extractEmbeddedRunError", () => {
  it("preserves an Error instance supplied through metadata", () => {
    expect(
      extractEmbeddedRunError({ meta: { error: new Error("timeout") } }),
    ).toBe("timeout");
  });
});
