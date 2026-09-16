import { logger } from "../../api.js";
import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import type { ReviewSnapshot, SkillPlacementReviewCandidate } from "./types.js";
import type { ReviewTrigger } from "./triggers.js";
import type { PluginHookAgentContext } from "../hooks/types.js";
import {
  isGatewayDraining,
  runDetachedFromWorkScope,
} from "../subagent-runtime.js";

export const INTENT_REVIEW_DEFAULT_IDLE_MS = 30_000;
export const INTENT_REVIEW_DEFAULT_RETRY_IDLE_MS = 30_000;
export const INTENT_REVIEW_DEFAULT_MAX_PENDING = 32;

export interface ReviewCandidate {
  agentId: string;
  sessionKey?: string;
  ctx: PluginHookAgentContext;
  resolvedConfig: ResolvedSkillHarnessPluginConfig;
  modelRef: { provider: string; model: string };
  snapshot: ReviewSnapshot;
  triggers: readonly ReviewTrigger[];
  skillPlacementCandidate?: SkillPlacementReviewCandidate;
}

export type ReviewRunner = (
  candidate: ReviewCandidate,
  abortSignal: AbortSignal,
) => Promise<void>;

export interface ReviewSchedulerLike {
  schedule(candidate: ReviewCandidate): boolean;
  setRunner(runner: ReviewRunner): void;
  setOnDiscard(onDiscard: (candidate: ReviewCandidate) => void): void;
}

export interface IntentReviewSchedulerDeps {
  idleDelayMs?: number;
  retryIdleMs?: number;
  maxPending?: number;
  isSystemActive?: (candidate: ReviewCandidate) => boolean | Promise<boolean>;
  isDraining?: () => boolean;
  runReview?: ReviewRunner;
  onDiscard?: (candidate: ReviewCandidate) => void;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => NodeJS.Timeout | ReturnType<typeof setTimeout>;
  clearTimer?: (timer: NodeJS.Timeout | ReturnType<typeof setTimeout>) => void;
}

interface PendingReview {
  candidate: ReviewCandidate;
  generation: number;
  timer?: NodeJS.Timeout | ReturnType<typeof setTimeout>;
}

export class IntentReviewScheduler {
  private readonly pendingBySession = new Map<string, PendingReview>();
  private readonly idleDelayMs: number;
  private readonly retryIdleMs: number;
  private readonly maxPending: number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => NodeJS.Timeout | ReturnType<typeof setTimeout>;
  private readonly clearTimer: (
    timer: NodeJS.Timeout | ReturnType<typeof setTimeout>,
  ) => void;

  private runner?: ReviewRunner;
  private onDiscardCallback?: (candidate: ReviewCandidate) => void;
  private reviewInFlight = false;
  private disposed = false;
  private readonly abortController = new AbortController();
  private readonly idleResolvers: Array<() => void> = [];

  constructor(private readonly deps: IntentReviewSchedulerDeps = {}) {
    this.idleDelayMs = deps.idleDelayMs ?? INTENT_REVIEW_DEFAULT_IDLE_MS;
    this.retryIdleMs = deps.retryIdleMs ?? INTENT_REVIEW_DEFAULT_RETRY_IDLE_MS;
    this.maxPending = deps.maxPending ?? INTENT_REVIEW_DEFAULT_MAX_PENDING;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.runner = deps.runReview;
    this.onDiscardCallback = deps.onDiscard;
  }

  setRunner(runner: ReviewRunner): void {
    this.runner = runner;
  }

  setOnDiscard(onDiscard: (candidate: ReviewCandidate) => void): void {
    this.onDiscardCallback = onDiscard;
  }

  schedule(candidate: ReviewCandidate): boolean {
    if (this.disposed) {
      return false;
    }

    if (this.deps.isDraining?.() ?? isGatewayDraining()) {
      return false;
    }

    const sessionKey =
      candidate.sessionKey ??
      candidate.ctx.sessionKey ??
      candidate.snapshot.sessionKey ??
      "";
    const key = JSON.stringify([candidate.agentId, sessionKey]);

    const existing = this.pendingBySession.get(key);
    if (existing) {
      if (existing.timer) {
        this.clearTimer(existing.timer);
        existing.timer = undefined;
      }
      if (existing.candidate !== candidate) {
        this.notifyDiscard(existing.candidate);
      }
      existing.candidate = candidate;
      this.pendingBySession.delete(key);
      this.pendingBySession.set(key, existing);
      this.arm(key, existing, this.idleDelayMs);
      return true;
    }

    if (this.pendingBySession.size >= this.maxPending) {
      const oldestEntry = this.pendingBySession.entries().next().value;
      if (oldestEntry) {
        const [oldestKey, oldestPending] = oldestEntry;
        if (oldestPending.timer) {
          this.clearTimer(oldestPending.timer);
        }
        this.pendingBySession.delete(oldestKey);
        this.notifyDiscard(oldestPending.candidate);
      }
    }

    const pending: PendingReview = { candidate, generation: 0 };
    this.pendingBySession.set(key, pending);
    this.arm(key, pending, this.idleDelayMs);
    return true;
  }

  private arm(key: string, pending: PendingReview, delayMs: number): void {
    if (pending.timer) {
      this.clearTimer(pending.timer);
      pending.timer = undefined;
    }

    const generation = ++pending.generation;
    const timerCallback = () => {
      try {
        if (this.disposed) {
          return;
        }
        if (
          this.pendingBySession.get(key) !== pending ||
          pending.generation !== generation
        ) {
          return;
        }
        pending.timer = undefined;

        if (this.deps.isDraining?.() ?? isGatewayDraining()) {
          this.pendingBySession.delete(key);
          this.notifyDiscard(pending.candidate);
          this.checkIdle();
          return;
        }

        void Promise.resolve()
          .then(() =>
            this.deps.isSystemActive
              ? this.deps.isSystemActive(pending.candidate)
              : false,
          )
          .then(async (active) => {
            if (this.disposed) {
              return;
            }
            if (
              this.pendingBySession.get(key) !== pending ||
              pending.generation !== generation
            ) {
              return;
            }

            if (active || this.reviewInFlight) {
              this.arm(key, pending, this.retryIdleMs);
              return;
            }

            this.reviewInFlight = true;
            this.pendingBySession.delete(key);

            try {
              if (this.runner) {
                await runDetachedFromWorkScope(() =>
                  this.runner!(pending.candidate, this.abortController.signal),
                );
              }
            } catch (error) {
              logger.warn("background intent review execution failed", {
                error,
              });
            } finally {
              this.reviewInFlight = false;
              this.checkIdle();
            }
          })
          .catch((error: unknown) => {
            logger.warn("background intent review liveness check failed", {
              error,
            });
            if (
              this.pendingBySession.get(key) === pending &&
              pending.generation === generation
            ) {
              this.pendingBySession.delete(key);
              this.notifyDiscard(pending.candidate);
            }
            this.checkIdle();
          });
      } catch (error) {
        logger.warn("unexpected error in background review timer callback", {
          error,
        });
        if (
          this.pendingBySession.get(key) === pending &&
          pending.generation === generation
        ) {
          this.pendingBySession.delete(key);
          this.notifyDiscard(pending.candidate);
        }
        this.checkIdle();
      }
    };

    const timer = runDetachedFromWorkScope(() =>
      this.setTimer(timerCallback, delayMs),
    );
    pending.timer = timer;
    if ("unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  private notifyDiscard(candidate: ReviewCandidate): void {
    try {
      const callback = this.onDiscardCallback ?? this.deps.onDiscard;
      callback?.(candidate);
    } catch (error) {
      logger.warn("failed to execute review discard callback", { error });
    }
  }

  private checkIdle(): void {
    if (!this.reviewInFlight && this.pendingBySession.size === 0) {
      const resolvers = [...this.idleResolvers];
      this.idleResolvers.length = 0;
      for (const resolve of resolvers) {
        try {
          resolve();
        } catch {
          // ignore resolver failures
        }
      }
    }
  }

  getPendingCount(): number {
    return this.pendingBySession.size;
  }

  isReviewInFlight(): boolean {
    return this.reviewInFlight;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  waitForIdle(): Promise<void> {
    if (!this.reviewInFlight && this.pendingBySession.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  clear(): void {
    for (const pending of this.pendingBySession.values()) {
      if (pending.timer) {
        this.clearTimer(pending.timer);
      }
      this.notifyDiscard(pending.candidate);
    }
    this.pendingBySession.clear();
    this.checkIdle();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.abortController.abort();
    this.clear();
  }
}

export function createIntentReviewScheduler(
  deps?: IntentReviewSchedulerDeps,
): IntentReviewScheduler {
  return new IntentReviewScheduler(deps);
}
