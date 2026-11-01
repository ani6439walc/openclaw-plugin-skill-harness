import { expect, it, vi } from "vitest";
import {
  createReviewToolRegistry,
  getReviewToolBinding,
  REVIEW_TOOL_BINDING_KEY,
} from "./tool-bindings.js";
import type { RelationReviewContext } from "./relations.js";

function createTestRun(
  params: Parameters<
    ReturnType<typeof createReviewToolRegistry>["register"]
  >[0],
) {
  const registry = createReviewToolRegistry();
  const run = registry.register(params);
  const context = {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    toolBindings: structuredClone({ [REVIEW_TOOL_BINDING_KEY]: run.binding }),
  };
  return { run, registry, capability: registry.resolve(context)!, context };
}

it("crosses the host structured-clone boundary without executable values", async () => {
  const { run, registry, capability } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
  });
  expect(() => structuredClone(run.binding)).not.toThrow();
  await run.close();
});

it("restricts the binding to its owning agent and embedded session", async () => {
  const { run, registry, capability } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
  });
  const context = {
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
    toolBindings: { [REVIEW_TOOL_BINDING_KEY]: run.binding },
  };
  expect(getReviewToolBinding(context, registry)).toBe(capability);
  expect(() =>
    getReviewToolBinding({ ...context, sessionId: "other" }, registry),
  ).toThrow("review-tool-owner");
  expect(() =>
    getReviewToolBinding({ ...context, agentId: "other" }, registry),
  ).toThrow("review-tool-owner");
  await run.close();
});

it("serves exactly the admitted snapshot and marks inspection separately from adoption", async () => {
  const skill = {
    name: "writer",
    identity: { id: "source:writer" },
    content: "one\ntwo\n",
    workspacePath: "relation-evidence/writer/SKILL.md",
  };
  const context = {
    seedIds: ["source:seed"],
    skills: [skill],
    relations: [],
    admitSkill: vi.fn(async () => ({ status: "eligible", skill })),
  } as unknown as RelationReviewContext;
  const { run, registry, capability } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
    relationContext: context,
  });
  const fallback = vi.fn();
  const result = await capability.readSkill("writer", undefined, fallback);
  expect(result).toMatchObject({
    success: true,
    content: "one\ntwo\n",
    review_inspection: true,
    relation_review: { eligible: true, skill_id: "source:writer" },
  });
  expect(fallback).not.toHaveBeenCalled();
  await run.close();
  await expect(
    capability.readSkill("writer", undefined, fallback),
  ).rejects.toThrow("review-tool-closed");
});

it("drains accepted reads and rejects results after cancellation", async () => {
  const controller = new AbortController();
  let resolve!: (value: { success: false; error: string }) => void;
  const pending = new Promise<{ success: false; error: string }>((done) => {
    resolve = done;
  });
  const { run, registry, capability } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
    signal: controller.signal,
  });
  const read = capability.readSkill("writer", undefined, () => pending);
  const rejected = expect(read).rejects.toThrow();
  controller.abort();
  let closed = false;
  const closing = run.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  resolve({ success: false, error: "unavailable" });
  await rejected;
  await closing;
  expect(closed).toBe(true);
});

it("bounds autonomous searches and refuses retained callbacks after closing", async () => {
  const { run, registry, capability } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
  });
  const search = vi.fn(async () => "result");
  for (let i = 0; i < 4; i++) await capability.search(search);
  await expect(capability.search(search)).rejects.toThrow(
    "review-search-budget",
  );
  expect(search).toHaveBeenCalledTimes(4);
  expect(run.searchCount).toBe(4);
  await run.close();
  await expect(capability.search(search)).rejects.toThrow("review-tool-closed");
});

it("rejects unknown, expired, cross-instance and tampered descriptors without fallback", async () => {
  const { run, registry, context } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
  });
  const otherRegistry = createReviewToolRegistry();
  expect(() => otherRegistry.resolve(context)).toThrow("review-tool-closed");
  expect(() => getReviewToolBinding(context)).toThrow("review-tool-closed");
  expect(() =>
    registry.resolve({
      ...context,
      toolBindings: {
        [REVIEW_TOOL_BINDING_KEY]: { ...run.binding, token: "unknown" },
      },
    }),
  ).toThrow("review-tool-closed");
  expect(() =>
    registry.resolve({
      ...context,
      toolBindings: {
        [REVIEW_TOOL_BINDING_KEY]: { ...run.binding, extra: true },
      },
    }),
  ).toThrow("invalid-review-tool-binding");
  expect(() =>
    registry.resolve({ ...context, sessionKey: "other-key" }),
  ).toThrow("review-tool-owner");
  await run.close();
  expect(() => registry.resolve(context)).toThrow("review-tool-closed");
  expect(registry.resolve({})).toBeUndefined();
  await registry.close();
  expect(() =>
    registry.register({
      agentId: "main",
      sessionId: "review-2",
      sessionKey: "review-key",
    }),
  ).toThrow("review-registry-closed");
  await otherRegistry.close();
});

it("revokes aborted tokens immediately and registry disposal drains accepted work", async () => {
  const abort = new AbortController();
  const { run, registry, capability, context } = createTestRun({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
    signal: abort.signal,
  });
  let finish!: () => void;
  const entered = vi.fn();
  const read = capability.readSkill("a", undefined, async () => {
    entered();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { success: false, error: "unavailable" };
  });
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  abort.abort();
  expect(() => registry.resolve(context)).toThrow("review-tool-closed");
  let disposed = false;
  const disposal = registry.close().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  finish();
  await rejected;
  await disposal;
  await run.close();
  expect(disposed).toBe(true);
});

it("keeps simultaneous runs isolated when one token is revoked", async () => {
  const registry = createReviewToolRegistry();
  const first = registry.register({
    agentId: "main",
    sessionId: "one",
    sessionKey: "review-key",
  });
  const second = registry.register({
    agentId: "main",
    sessionId: "two",
    sessionKey: "review-key",
  });
  expect(first.binding.token).not.toBe(second.binding.token);
  const secondContext = {
    agentId: "main",
    sessionId: "two",
    sessionKey: "review-key",
    toolBindings: structuredClone({
      [REVIEW_TOOL_BINDING_KEY]: second.binding,
    }),
  };
  await first.close();
  await expect(
    registry.resolve(secondContext)!.search(async () => "result"),
  ).resolves.toBe("result");
  expect(first.searchCount).toBe(0);
  expect(second.searchCount).toBe(1);
  await registry.close();
  expect(() => registry.resolve(secondContext)).toThrow("review-tool-closed");
});
