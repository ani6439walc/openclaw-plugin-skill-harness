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

/** A timed-out operation may still settle, but must not publish its result. */
export async function withPromptDeadline<T>(
  timeoutMs: number,
  assertParentActive: () => void,
  operation: (assertActive: () => void) => Promise<T>,
): Promise<T> {
  let active = true;
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertActive = () => {
    assertParentActive();
    if (!active || Date.now() >= deadline) {
      throw new Error("Skill Harness prompt operation expired");
    }
  };
  try {
    assertActive();
    return await Promise.race([
      operation(assertActive).then((result) => {
        assertActive();
        return result;
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(
            new Error(`Skill Harness prompt timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  }
}
