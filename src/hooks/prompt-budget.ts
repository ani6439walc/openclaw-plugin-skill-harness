import type { ResolvedRoutingConfig } from "../types.js";

const PROMPT_OVERHEAD_MS = 1_500;
// The public schema permits up to 60 seconds for each parallel search and Jev.
export const MAX_PROMPT_HOOK_TIMEOUT_MS = 60_000 + 60_000 + PROMPT_OVERHEAD_MS;

export function promptRoutingBudgetMs(routing: ResolvedRoutingConfig): number {
  return (
    Math.max(
      routing.skills.maxInjectedSkills > 0
        ? routing.skills.search.timeoutMs
        : 0,
      routing.experiences.maxInjectedExperiences > 0
        ? routing.experiences.search.timeoutMs
        : 0,
    ) +
    routing.timeoutMs +
    PROMPT_OVERHEAD_MS
  );
}

/** Bound publication and propagate cancellation to accepted asynchronous work. */
export async function withPromptDeadline<T>(
  timeoutMs: number,
  assertParentActive: () => void,
  operation: (assertActive: () => void, signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  let active = true;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const assertActive = () => {
    try {
      assertParentActive();
      if (!active || controller.signal.aborted || Date.now() >= deadline) {
        throw new Error("Skill Harness prompt operation expired");
      }
    } catch (error) {
      controller.abort();
      throw error;
    }
  };
  try {
    if (parentSignal?.aborted) controller.abort();
    assertActive();
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        active = false;
        controller.abort();
        reject(new Error("Skill Harness prompt operation cancelled"));
      };
      parentSignal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        active = false;
        controller.abort();
        reject(
          new Error(`Skill Harness prompt timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });
    return await Promise.race([
      operation(assertActive, controller.signal).then((result) => {
        assertActive();
        return result;
      }),
      cancellation,
    ]);
  } finally {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) parentSignal?.removeEventListener("abort", onAbort);
  }
}
