import { logger } from "../../api.js";

let pendingReview = Promise.resolve();

// Review writes can update shared runtime state, so they must run serially.
// Individual failures remain fail-open and cannot poison the queue tail.
export function enqueueReview(task: () => Promise<void>): void {
  pendingReview = pendingReview
    .then(task)
    .catch((error) => logger.warn("background review failed", { error }));
}

export function waitForReviewQueueIdle(): Promise<void> {
  return pendingReview;
}
