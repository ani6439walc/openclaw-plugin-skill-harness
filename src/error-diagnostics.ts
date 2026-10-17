/** Fixed classifications only: never expose arbitrary error fields or messages. */
export function safeErrorClassification(error: unknown): {
  reason: string;
  code?: string;
} {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return { reason: "permission-denied", code };
    case "ENOENT":
      return { reason: "file-missing", code };
    case "ELOOP":
      return { reason: "symlink-cycle", code };
    case "ENOTDIR":
    case "EISDIR":
      return { reason: "invalid-file-type", code };
    case "SQLITE_BUSY":
    case "SQLITE_LOCKED":
      return { reason: "database-busy", code };
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return { reason: "request-timeout", code };
    case "BUILD_LOCK_BUSY":
      return { reason: "build-lock-busy", code };
    case "EMBEDDING_INCOMPLETE":
      return { reason: "embedding-incomplete", code };
    case "IDENTITY_MISMATCH":
      return { reason: "embedding-identity-mismatch", code };
    case "LEASE_BUSY":
      return { reason: "embedding-lease-busy", code };
    default:
      return { reason: "operation-failed" };
  }
}
