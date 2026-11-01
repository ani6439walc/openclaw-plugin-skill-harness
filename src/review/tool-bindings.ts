import { randomUUID } from "node:crypto";
import type { SkillReadResult } from "../skills/types.js";
import {
  formatRelationReviewContext,
  stageRelationReviewSkill,
  type RelationReviewContext,
} from "./relations.js";

export const REVIEW_TOOL_BINDING_KEY = "skill-harness.review";
const MAX_REVIEW_SEARCHES = 4;
const MAX_READ_BYTES = 256 * 1024;

interface ReviewToolCapability {
  assertActive(): void;
  readSkill(
    name: string,
    filePath: string | undefined,
    fallback: () => Promise<SkillReadResult>,
  ): Promise<unknown>;
  search<T>(search: () => Promise<T>): Promise<T>;
}

interface ReviewToolContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolBindings?: Readonly<Record<string, unknown>>;
}

interface ReviewToolRunParams {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  relationContext?: RelationReviewContext;
  workspaceDir?: string;
  signal?: AbortSignal;
}

interface ReviewToolDescriptor {
  version: 1;
  token: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
}

interface ReviewToolRunHandle {
  binding: Readonly<ReviewToolDescriptor>;
  readonly searchCount: number;
  readonly evidenceFailed: boolean;
  close(): Promise<void>;
}

export interface ReviewToolRegistry {
  register(params: ReviewToolRunParams): ReviewToolRunHandle;
  resolve(context: ReviewToolContext): ReviewToolCapability | undefined;
  close(): Promise<void>;
}

/** The host clones tool bindings. Only opaque descriptors cross that boundary. */
export function getReviewToolBinding(
  context: ReviewToolContext,
  registry?: ReviewToolRegistry,
): ReviewToolCapability | undefined {
  if (
    !context.toolBindings ||
    !Object.hasOwn(context.toolBindings, REVIEW_TOOL_BINDING_KEY)
  )
    return;
  if (!registry) throw new Error("review-tool-closed");
  return registry.resolve(context);
}

/** Owned by one plugin registration, never shared through a module-global map. */
export function createReviewToolRegistry(): ReviewToolRegistry {
  const entries = new Map<
    string,
    {
      descriptor: ReviewToolDescriptor;
      capability: ReviewToolCapability;
      close(): Promise<void>;
    }
  >();
  const draining = new Set<Promise<void>>();
  let closed = false;
  return {
    register(params) {
      if (closed) throw new Error("review-registry-closed");
      params.signal?.throwIfAborted();
      const run = createReviewToolCapability(params);
      const descriptor: ReviewToolDescriptor = Object.freeze({
        version: 1,
        token: randomUUID(),
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      let closing: Promise<void> | undefined;
      const close = () => {
        if (closing) return closing;
        entries.delete(descriptor.token);
        params.signal?.removeEventListener("abort", onAbort);
        closing = run.close();
        draining.add(closing);
        void closing.finally(() => draining.delete(closing!));
        return closing;
      };
      const onAbort = () => {
        void close();
      };
      entries.set(descriptor.token, {
        descriptor,
        capability: run.binding,
        close,
      });
      params.signal?.addEventListener("abort", onAbort, { once: true });
      return {
        binding: descriptor,
        get searchCount() {
          return run.searchCount;
        },
        get evidenceFailed() {
          return run.evidenceFailed;
        },
        close,
      };
    },
    resolve(context) {
      if (
        !context.toolBindings ||
        !Object.hasOwn(context.toolBindings, REVIEW_TOOL_BINDING_KEY)
      )
        return;
      const raw = context.toolBindings[REVIEW_TOOL_BINDING_KEY];
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("invalid-review-tool-binding");
      const descriptor = raw as Partial<ReviewToolDescriptor>;
      if (
        descriptor.version !== 1 ||
        typeof descriptor.token !== "string" ||
        typeof descriptor.agentId !== "string" ||
        typeof descriptor.sessionId !== "string" ||
        typeof descriptor.sessionKey !== "string" ||
        Object.keys(raw).some(
          (key) =>
            ![
              "version",
              "token",
              "agentId",
              "sessionId",
              "sessionKey",
            ].includes(key),
        )
      )
        throw new Error("invalid-review-tool-binding");
      const entry = entries.get(descriptor.token);
      if (!entry) throw new Error("review-tool-closed");
      if (
        descriptor.agentId !== context.agentId ||
        descriptor.sessionId !== context.sessionId ||
        descriptor.sessionKey !== context.sessionKey ||
        entry.descriptor.agentId !== descriptor.agentId ||
        entry.descriptor.sessionId !== descriptor.sessionId ||
        entry.descriptor.sessionKey !== descriptor.sessionKey
      )
        throw new Error("review-tool-owner");
      entry.capability.assertActive();
      return entry.capability;
    },
    async close() {
      closed = true;
      for (const entry of [...entries.values()]) void entry.close();
      await Promise.allSettled([...draining]);
    },
  };
}

function createReviewToolCapability(params: ReviewToolRunParams) {
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
  const binding: ReviewToolCapability = {
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
