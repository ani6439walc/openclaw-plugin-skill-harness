import type { SkillReadResult } from "../skills/types.js";
import {
  formatRelationReviewContext,
  stageRelationReviewSkill,
  type RelationReviewContext,
} from "./relations.js";

export const REVIEW_TOOL_BINDING_KEY = "skill-harness.review";
const MAX_REVIEW_SEARCHES = 4;
const MAX_READ_BYTES = 256 * 1024;

interface ReviewToolBinding {
  version: 1;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  assertActive(): void;
  readSkill(
    name: string,
    filePath: string | undefined,
    fallback: () => Promise<SkillReadResult>,
  ): Promise<unknown>;
  search<T>(search: () => Promise<T>): Promise<T>;
}

/** Public host tool bindings carry authority out of band, never in model arguments. */
export function getReviewToolBinding(context: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolBindings?: Readonly<Record<string, unknown>>;
}): ReviewToolBinding | undefined {
  if (
    !context.toolBindings ||
    !Object.hasOwn(context.toolBindings, REVIEW_TOOL_BINDING_KEY)
  )
    return;
  const value = context.toolBindings[REVIEW_TOOL_BINDING_KEY];
  if (!value || typeof value !== "object")
    throw new Error("invalid-review-tool-binding");
  const binding = value as Partial<ReviewToolBinding>;
  if (
    binding.version !== 1 ||
    typeof binding.readSkill !== "function" ||
    typeof binding.search !== "function" ||
    typeof binding.assertActive !== "function"
  )
    throw new Error("invalid-review-tool-binding");
  if (
    binding.agentId !== context.agentId ||
    binding.sessionId !== context.sessionId ||
    binding.sessionKey !== context.sessionKey
  )
    throw new Error("review-tool-owner");
  binding.assertActive();
  return binding as ReviewToolBinding;
}

export function createReviewToolBinding(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  relationContext?: RelationReviewContext;
  workspaceDir?: string;
  signal?: AbortSignal;
}) {
  let active = true;
  let searches = 0;
  let evidenceFailed = false;
  const pending = new Set<Promise<unknown>>();
  const assertActive = () => {
    params.signal?.throwIfAborted();
    if (!active) throw new Error("review-tool-closed");
  };
  async function track<T>(work: () => Promise<T>): Promise<T> {
    assertActive();
    const task = Promise.resolve().then(async () => {
      assertActive();
      const result = await work();
      assertActive();
      return result;
    });
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  }
  const binding: ReviewToolBinding = {
    version: 1,
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    assertActive,
    async readSkill(name, filePath, fallback) {
      return track(async () => {
        let reason = filePath ? "support-file" : "relation-review-unavailable";
        if (!filePath && params.relationContext) {
          const admitted = await params.relationContext.admitSkill(name);
          assertActive();
          if (admitted.status === "eligible") {
            const { skill } = admitted;
            if (params.workspaceDir) {
              try {
                await stageRelationReviewSkill(
                  skill,
                  params.workspaceDir,
                  params.signal,
                );
              } catch (error) {
                evidenceFailed = true;
                throw error;
              }
            }
            assertActive();
            return {
              success: true,
              name: skill.name,
              content: skill.content,
              review_inspection: true,
              relation_review: {
                eligible: true,
                skill_id: skill.identity.id,
                file_path: skill.workspacePath,
                lines: skill.content
                  .split(/\r?\n/)
                  .map((text, index) => ({ line: index + 1, text })),
                manifest: JSON.parse(
                  formatRelationReviewContext(params.relationContext),
                ) as unknown,
              },
            };
          }
          reason = admitted.reason;
        }
        const result = await fallback();
        assertActive();
        if (
          result.success &&
          Buffer.byteLength(result.content) > MAX_READ_BYTES
        ) {
          return {
            success: false,
            error: "review-read-budget",
            review_inspection: true,
            relation_review: { eligible: false, reason },
          };
        }
        return {
          ...result,
          review_inspection: true,
          relation_review: { eligible: false, reason },
        };
      });
    },
    async search(search) {
      return track(async () => {
        if (searches >= MAX_REVIEW_SEARCHES)
          throw new Error("review-search-budget");
        searches += 1;
        return search();
      });
    },
  };
  return {
    binding,
    get evidenceFailed() {
      return evidenceFailed;
    },
    get searchCount() {
      return searches;
    },
    async close() {
      active = false;
      await Promise.allSettled([...pending]);
    },
  };
}
