import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  logger,
  LOG_PREFIX,
  resetApiLogger,
  setApiLogger,
  type ExternalApiLogger,
} from "./api.js";

const { fallback } = vi.hoisted(() => ({
  fallback: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => fallback,
}));

afterEach(() => {
  resetApiLogger();
  vi.clearAllMocks();
});

describe("single-string plugin logger", () => {
  it.each(["trace", "debug", "info", "warn"] as const)(
    "forwards exactly one prefixed string to host %s",
    (level) => {
      const host = vi.fn<(message: string) => void>();
      setApiLogger({ [level]: host });
      logger[level]("safe diagnostic");
      expect(host).toHaveBeenCalledExactlyOnceWith(
        `${LOG_PREFIX} safe diagnostic`,
      );
      expectTypeOf<Parameters<(typeof logger)[typeof level]>>().toEqualTypeOf<
        [message: string]
      >();
    },
  );

  it.each(["trace", "debug", "info", "warn"] as const)(
    "uses a single string for the %s fallback too",
    (level) => {
      setApiLogger({});
      logger[level]("safe diagnostic");
      expect(fallback[level]).toHaveBeenCalledExactlyOnceWith(
        `${LOG_PREFIX} safe diagnostic`,
      );
    },
  );

  it("does not forward unexpected JavaScript metadata or duplicate the prefix", () => {
    const host = vi.fn<(message: string) => void>();
    setApiLogger({ warn: host });
    Reflect.apply(logger.warn, logger, [
      `${LOG_PREFIX} safe diagnostic`,
      { token: "PRIVATE-TOKEN", error: new Error("PRIVATE-RESPONSE") },
    ]);
    expect(host).toHaveBeenCalledExactlyOnceWith(
      `${LOG_PREFIX} safe diagnostic`,
    );
    expect(JSON.stringify(host.mock.calls)).not.toContain("PRIVATE");
    expectTypeOf<NonNullable<ExternalApiLogger["warn"]>>().toEqualTypeOf<
      (message: string) => void
    >();
  });
});
