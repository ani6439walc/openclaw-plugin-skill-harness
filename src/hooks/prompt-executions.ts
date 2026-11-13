import type { TurnAssociation } from "./turn-associations.js";

interface PromptExecution<T> {
  turnKey: string;
  controller: AbortController;
  result: Promise<T>;
}

export interface PromptRequestOwner<T> {
  readonly agentId: string;
  readonly sessionId: string;
  readonly admissionId?: string;
  readonly runId?: string;
  readonly legacyInput?: string;
  readonly controller: AbortController;
  state: "current" | "finalized" | "superseded";
  callers: number;
  association?: TurnAssociation;
  resolvedSessionKey?: string;
  lookup?: Promise<string | undefined>;
  preparation?: Promise<TurnAssociation | undefined>;
  result?: Promise<T>;
}

/** One dynamic result per current tracked turn, owned by this hook generation. */
export class PromptExecutions<T> {
  private readonly sessions = new Map<string, PromptExecution<T>>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly requests = new Map<string, PromptRequestOwner<T>>();
  private readonly admissions = new Map<
    string,
    Map<string, PromptRequestOwner<T>>
  >();
  private nativeCount = 0;
  private stopped = false;
  private readonly onAbort = () => this.stop();

  constructor(
    private readonly parentSignal?: AbortSignal,
    private readonly maxNativeAdmissions = 16_384,
  ) {
    if (parentSignal?.aborted) this.stop();
    else parentSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  assertActive(): void {
    if (this.stopped)
      throw new Error("Skill Harness prompt generation stopped");
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Claim request order synchronously, before any identity lookup can yield. */
  claimRequest(params: {
    agentId: string;
    sessionId: string;
    admissionId?: string;
    runId?: string;
    legacyInput?: string;
  }): PromptRequestOwner<T> | undefined {
    this.assertActive();
    const scope = JSON.stringify([params.agentId, params.sessionId]);
    const current = this.requests.get(scope);
    const native = params.admissionId !== undefined;
    const known = native
      ? this.admissions.get(scope)?.get(params.admissionId!)
      : undefined;
    // Return stale handles for correlation fencing, but never make them current.
    if (known) return known;
    if (
      !native &&
      current?.admissionId === undefined &&
      current?.state === "current" &&
      current.runId === params.runId &&
      (params.runId !== undefined || current.legacyInput === params.legacyInput)
    ) {
      current.callers++;
      return current;
    }
    if (current) this.supersede(current);
    this.requests.delete(scope);
    // Keep tombstones instead of forgetting an ID and accidentally routing it again.
    if (native && this.nativeCount >= this.maxNativeAdmissions) return;
    const request: PromptRequestOwner<T> = {
      ...params,
      controller: new AbortController(),
      state: "current",
      callers: 1,
    };
    this.requests.set(scope, request);
    if (native) {
      const entries =
        this.admissions.get(scope) ?? new Map<string, PromptRequestOwner<T>>();
      entries.set(params.admissionId!, request);
      this.admissions.set(scope, entries);
      this.nativeCount++;
    }
    return request;
  }

  releaseRequest(request: PromptRequestOwner<T>): void {
    if (request.admissionId !== undefined) return;
    request.callers--;
    const scope = JSON.stringify([request.agentId, request.sessionId]);
    if (
      !request.callers &&
      !request.association &&
      this.requests.get(scope) === request
    )
      this.requests.delete(scope);
  }

  assertRequestCurrent(
    request: PromptRequestOwner<T>,
    allowFinalized = false,
  ): void {
    this.assertActive();
    const current = this.requests.get(
      JSON.stringify([request.agentId, request.sessionId]),
    );
    if (
      current !== request ||
      request.state === "superseded" ||
      (request.controller.signal.aborted &&
        !(allowFinalized && request.state === "finalized"))
    )
      throw new Error("Skill Harness prompt request superseded");
  }

  lookupRequest(
    request: PromptRequestOwner<T>,
    operation: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    this.assertRequestCurrent(request);
    if (request.admissionId !== undefined && request.lookup)
      return request.lookup;
    const work = this.track(
      Promise.resolve().then(async () => {
        this.assertRequestCurrent(request);
        const key = await operation();
        this.assertRequestCurrent(request);
        request.resolvedSessionKey = key;
        return key;
      }),
    );
    if (request.admissionId !== undefined) request.lookup = work;
    return work;
  }

  prepareRequest(
    request: PromptRequestOwner<T>,
    operation: () => Promise<TurnAssociation | undefined>,
  ): Promise<TurnAssociation | undefined> {
    this.assertRequestCurrent(request);
    if (request.preparation) return request.preparation;
    const work = this.track(
      Promise.resolve().then(async () => {
        this.assertRequestCurrent(request);
        const association = await operation();
        this.assertRequestCurrent(request);
        return association;
      }),
    );
    request.preparation = work;
    void work.then(
      (association) => {
        if (association && request.state === "current")
          request.association = association;
        // A tracker lock refusal is retryable; no routing result exists yet.
        else if (request.state === "current" && request.preparation === work)
          request.preparation = undefined;
      },
      () => {},
    );
    return work;
  }

  runRequest(
    request: PromptRequestOwner<T>,
    association: TurnAssociation,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertRequestCurrent(request);
    if (request.result) return request.result;
    request.association = association;
    const work = this.track(
      Promise.resolve().then(async () => {
        this.assertRequestCurrent(request);
        const result = await operation(request.controller.signal);
        this.assertRequestCurrent(request);
        return result;
      }),
    );
    request.result = work;
    return work;
  }

  private supersede(request: PromptRequestOwner<T>): void {
    request.state = "superseded";
    request.controller.abort();
    if (request.association) this.removeTurn(request.association);
    request.lookup = undefined;
    request.preparation = undefined;
    request.result = undefined;
  }

  finalizeAssociation(association: TurnAssociation): void {
    for (const [scope, request] of this.requests) {
      if (
        request.association?.sessionId !== association.sessionId ||
        request.association.turnKey !== association.turnKey
      )
        continue;
      if (request.admissionId !== undefined) request.state = "finalized";
      else {
        request.state = "superseded";
        this.requests.delete(scope);
      }
      request.controller.abort();
      request.lookup = undefined;
      request.preparation = undefined;
      request.result = undefined;
    }
    this.removeTurn(association);
  }

  track<U>(work: Promise<U>): Promise<U> {
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }

  observe(association: TurnAssociation): void {
    this.assertActive();
    const current = this.sessions.get(association.sessionId);
    if (current && current.turnKey !== association.turnKey) {
      current.controller.abort();
      this.sessions.delete(association.sessionId);
    }
  }

  run(
    association: TurnAssociation,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.observe(association);
    const current = this.sessions.get(association.sessionId);
    if (current?.turnKey === association.turnKey) return current.result;
    const controller = new AbortController();
    const result = this.track(
      Promise.resolve().then(() => {
        this.assertActive();
        if (controller.signal.aborted)
          throw new Error("Skill Harness prompt turn superseded");
        return operation(controller.signal);
      }),
    );
    // Keep rejected results as terminal outcomes; a prompt rebuild never retries.
    this.sessions.set(association.sessionId, {
      turnKey: association.turnKey,
      controller,
      result,
    });
    return result;
  }

  removeTurn(association: TurnAssociation): void {
    const current = this.sessions.get(association.sessionId);
    if (current?.turnKey !== association.turnKey) return;
    current.controller.abort();
    this.sessions.delete(association.sessionId);
  }

  removeSession(sessionId: string): void {
    this.sessions.get(sessionId)?.controller.abort();
    this.sessions.delete(sessionId);
    for (const [scope, request] of this.requests) {
      if (request.sessionId !== sessionId) continue;
      this.supersede(request);
      this.requests.delete(scope);
    }
    for (const [scope, entries] of this.admissions) {
      if (entries.values().next().value?.sessionId !== sessionId) continue;
      this.nativeCount -= entries.size;
      this.admissions.delete(scope);
    }
  }

  private stop(): void {
    this.stopped = true;
    this.parentSignal?.removeEventListener("abort", this.onAbort);
    for (const entry of this.sessions.values()) entry.controller.abort();
    this.sessions.clear();
    for (const request of this.requests.values()) this.supersede(request);
    this.requests.clear();
    this.admissions.clear();
    this.nativeCount = 0;
  }

  async dispose(): Promise<void> {
    this.stop();
    // Settling operations can finish registering nested work before they exit.
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
}
