import { logger } from "../api.js";

export class ReviewQueue {
  private pending = Promise.resolve();

  // Evolution reviews may copy validated edits back into the shared runtime
  // intent catalog, so callers must enqueue them here instead of running them
  // concurrently. The chained promise keeps review writes serialized while
  // preserving fail-open logging for individual review failures.
  enqueue(task: () => Promise<void>): void {
    this.pending = this.pending
      .then(task)
      .catch((error) =>
        logger.warn("background evolution review failed", { error }),
      );
  }

  onIdle(): Promise<void> {
    return this.pending;
  }
}

export const defaultReviewQueue = new ReviewQueue();
