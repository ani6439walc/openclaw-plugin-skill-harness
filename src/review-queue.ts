import { logger } from "../api.js";

export class ReviewQueue {
  private pending = Promise.resolve();

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
