import { logger } from "../../api.js";

let pendingReview = Promise.resolve();

// Review reviews may copy validated edits back into the shared runtime
// intent catalog, so callers must enqueue them here instead of running them
// concurrently. The chained promise keeps review writes serialized while
// preserving fail-open logging for individual review failures.
export function enqueueReview(task: () => Promise<void>): void {
  pendingReview = pendingReview
    .then(task)
    .catch((error) => logger.warn("background review failed", { error }));
}

export function waitForReviewQueueIdle(): Promise<void> {
  return pendingReview;
}
