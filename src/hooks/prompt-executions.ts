import type { TurnAssociation } from "./turn-associations.js";

interface PromptExecution<T> {
  turnKey: string;
  controller: AbortController;
  result: Promise<T>;
}

/** One dynamic result per current tracked turn, owned by this hook generation. */
export class PromptExecutions<T> {
  private readonly sessions = new Map<string, PromptExecution<T>>();
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly onAbort = () => this.stop();

  constructor(private readonly parentSignal?: AbortSignal) {
    if (parentSignal?.aborted) this.stop();
    else parentSignal?.addEventListener("abort", this.onAbort, { once: true });
  }

  assertActive(): void {
    if (this.stopped)
      throw new Error("Skill Harness prompt generation stopped");
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
  }

  private stop(): void {
    this.stopped = true;
    this.parentSignal?.removeEventListener("abort", this.onAbort);
    for (const entry of this.sessions.values()) entry.controller.abort();
    this.sessions.clear();
  }

  async dispose(): Promise<void> {
    this.stop();
    // Settling operations can finish registering nested work before they exit.
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
}
