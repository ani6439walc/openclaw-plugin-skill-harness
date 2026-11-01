import { expect, it, vi } from "vitest";
import {
  createReviewToolBinding,
  getReviewToolBinding,
  REVIEW_TOOL_BINDING_KEY,
} from "./tool-bindings.js";
import type { RelationReviewContext } from "./relations.js";

it("restricts the binding to its owning agent and embedded session", async () => {
  const run = createReviewToolBinding({
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
  expect(getReviewToolBinding(context)).toBe(run.binding);
  expect(() =>
    getReviewToolBinding({ ...context, sessionId: "other" }),
  ).toThrow("review-tool-owner");
  expect(() => getReviewToolBinding({ ...context, agentId: "other" })).toThrow(
    "review-tool-owner",
  );
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
  const run = createReviewToolBinding({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
    relationContext: context,
  });
  const fallback = vi.fn();
  const result = await run.binding.readSkill("writer", undefined, fallback);
  expect(result).toMatchObject({
    success: true,
    content: "one\ntwo\n",
    review_inspection: true,
    relation_review: { eligible: true, skill_id: "source:writer" },
  });
  expect(fallback).not.toHaveBeenCalled();
  await run.close();
  await expect(
    run.binding.readSkill("writer", undefined, fallback),
  ).rejects.toThrow("review-tool-closed");
});

it("drains accepted reads and rejects results after cancellation", async () => {
  const controller = new AbortController();
  let resolve!: (value: { success: false; error: string }) => void;
  const pending = new Promise<{ success: false; error: string }>((done) => {
    resolve = done;
  });
  const run = createReviewToolBinding({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
    signal: controller.signal,
  });
  const read = run.binding.readSkill("writer", undefined, () => pending);
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
  const run = createReviewToolBinding({
    agentId: "main",
    sessionId: "review-1",
    sessionKey: "review-key",
  });
  const search = vi.fn(async () => "result");
  for (let i = 0; i < 4; i++) await run.binding.search(search);
  await expect(run.binding.search(search)).rejects.toThrow(
    "review-search-budget",
  );
  expect(search).toHaveBeenCalledTimes(4);
  expect(run.searchCount).toBe(4);
  await run.close();
  await expect(run.binding.search(search)).rejects.toThrow(
    "review-tool-closed",
  );
});
