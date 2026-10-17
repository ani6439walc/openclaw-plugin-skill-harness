import { logger } from "../../api.js";
import type { ResolvedSkillHarnessPluginConfig } from "../types.js";
import type { ReviewSnapshot } from "./types.js";
import type { ReviewTrigger } from "./triggers.js";
import type { PluginHookAgentContext } from "../hooks/types.js";
import type { BackgroundRunner } from "../subagent-runtime.js";

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
  signal?: AbortSignal;
  runInBackgroundContext?: BackgroundRunner;
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
  private readonly activeWork = new Set<Promise<void>>();
  private readonly stopOnAbort = () => {
    void this.dispose();
  };
  private readonly idleResolvers: Array<() => void> = [];

  constructor(private readonly deps: IntentReviewSchedulerDeps = {}) {
    this.idleDelayMs = deps.idleDelayMs ?? INTENT_REVIEW_DEFAULT_IDLE_MS;
    this.retryIdleMs = deps.retryIdleMs ?? INTENT_REVIEW_DEFAULT_RETRY_IDLE_MS;
    this.maxPending = deps.maxPending ?? INTENT_REVIEW_DEFAULT_MAX_PENDING;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.runner = deps.runReview;
    this.onDiscardCallback = deps.onDiscard;
    if (deps.signal?.aborted) {
      void this.dispose();
    } else {
      deps.signal?.addEventListener("abort", this.stopOnAbort, { once: true });
    }
  }

  setRunner(runner: ReviewRunner): void {
    this.runner = runner;
  }

  setOnDiscard(onDiscard: (candidate: ReviewCandidate) => void): void {
    this.onDiscardCallback = onDiscard;
  }

  schedule(candidate: ReviewCandidate): boolean {
    if (this.disposed || this.deps.signal?.aborted) {
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
      return this.arm(key, existing, this.idleDelayMs);
    }

    if (this.pendingBySession.size >= this.maxPending) {
      const oldestEntry = this.pendingBySession.entries().next().value;
      if (oldestEntry) {
        const [oldestKey, oldestPending] = oldestEntry;
        if (oldestPending.timer) {
          this.clearTimer(oldestPending.timer);
          oldestPending.timer = undefined;
        }
        this.pendingBySession.delete(oldestKey);
        this.notifyDiscard(oldestPending.candidate);
      }
    }

    const pending: PendingReview = { candidate, generation: 0 };
    this.pendingBySession.set(key, pending);
    return this.arm(key, pending, this.idleDelayMs);
  }

  private arm(key: string, pending: PendingReview, delayMs: number): boolean {
    if (pending.timer) {
      this.clearTimer(pending.timer);
      pending.timer = undefined;
    }

    const generation = ++pending.generation;
    const runInBackgroundContext =
      this.deps.runInBackgroundContext ?? ((run) => run());
    const discard = (error: unknown) => {
      logger.warn("background review callback failed", { error });
      if (
        this.pendingBySession.get(key) === pending &&
        pending.generation === generation
      ) {
        pending.timer = undefined;
        this.pendingBySession.delete(key);
        this.notifyDiscard(pending.candidate);
      }
      this.checkIdle();
    };
    const timerCallback = () => {
      if (this.disposed) return;
      try {
        // Return the whole asynchronous callback to its instance admission owner.
        const work = runInBackgroundContext(() =>
          this.runPending(key, pending, generation),
        );
        const settled = work.catch(discard).finally(() => {
          this.activeWork.delete(settled);
          this.checkIdle();
        });
        this.activeWork.add(settled);
        return settled;
      } catch (error) {
        discard(error);
      }
    };

    try {
      const timer = runInBackgroundContext(() =>
        this.setTimer(timerCallback, delayMs),
      );
      pending.timer = timer;
      if ("unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
      return true;
    } catch (error) {
      discard(error);
      return false;
    }
  }

  private async runPending(
    key: string,
    pending: PendingReview,
    generation: number,
  ): Promise<void> {
    if (
      this.disposed ||
      this.pendingBySession.get(key) !== pending ||
      pending.generation !== generation
    )
      return;
    pending.timer = undefined;

    const active = await this.deps.isSystemActive?.(pending.candidate);
    if (
      this.disposed ||
      this.pendingBySession.get(key) !== pending ||
      pending.generation !== generation
    )
      return;
    if (active || this.reviewInFlight) {
      this.arm(key, pending, this.retryIdleMs);
      return;
    }

    this.reviewInFlight = true;
    this.pendingBySession.delete(key);
    try {
      await this.runner?.(pending.candidate, this.abortController.signal);
    } finally {
      this.reviewInFlight = false;
      this.checkIdle();
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
    if (
      !this.reviewInFlight &&
      this.pendingBySession.size === 0 &&
      this.activeWork.size === 0
    ) {
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
    if (
      !this.reviewInFlight &&
      this.pendingBySession.size === 0 &&
      this.activeWork.size === 0
    ) {
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
        pending.timer = undefined;
      }
      this.notifyDiscard(pending.candidate);
    }
    this.pendingBySession.clear();
    this.checkIdle();
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.deps.signal?.removeEventListener("abort", this.stopOnAbort);
      this.abortController.abort();
      this.clear();
    }
    await Promise.all(this.activeWork);
  }
}

export function createIntentReviewScheduler(
  deps?: IntentReviewSchedulerDeps,
): IntentReviewScheduler {
  return new IntentReviewScheduler(deps);
}
