import { describe, expect, it } from "vitest";
import { safeErrorClassification } from "./error-diagnostics.js";

describe("safeErrorClassification", () => {
  it.each([
    ["EACCES", "permission-denied"],
    ["ELOOP", "symlink-cycle"],
    ["ETIMEDOUT", "request-timeout"],
    ["SQLITE_BUSY", "database-busy"],
    ["EMBEDDING_INCOMPLETE", "embedding-incomplete"],
    ["BUILD_LOCK_BUSY", "build-lock-busy"],
  ])("retains only the recognized %s code", (code, reason) => {
    expect(
      safeErrorClassification(Object.assign(new Error("secret"), { code })),
    ).toEqual({ reason, code });
  });

  it.each([
    undefined,
    "private query",
    new Error("private query"),
    {
      code: "private-api-key",
      message: "provider response",
      path: "/private/path",
    },
  ])("does not expose unknown error evidence", (error) => {
    expect(safeErrorClassification(error)).toEqual({
      reason: "operation-failed",
    });
  });
});
