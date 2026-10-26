import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRelationSource } from "../skills/relation-sources.js";
import {
  appendImportedRelations,
  readRelationGraph,
  relationGraphPath,
} from "../skills/relation-graph.js";
import {
  prepareRelationReviewContext,
  validateRelationReviewFindings,
  applyPreparedRelationReview,
} from "./relations.js";
import type { SkillRelationReviewFinding } from "./types.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-relations-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(count = 3) {
  const source = path.join(root, "source");
  const skills = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const name = `skill-${index}`;
      const location = path.join(source, name, "SKILL.md");
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(
        location,
        `---\nname: ${name}\ndescription: Compose a pipeline.\n---\n${name} provides pipeline data.\n`,
      );
      return { name, location, description: "Compose a pipeline." };
    }),
  );
  await registerRelationSource(root, {
    id: "github:example/catalog",
    root: source,
    skills: Object.fromEntries(
      skills.map(({ name }) => [
        name,
        { name, source_path: `${name}/SKILL.md` },
      ]),
    ),
  });
  let visible = skills;
  const getVisibleSkills = async () => visible;
  const search = vi
    .fn()
    .mockResolvedValue(skills.slice(1).map(({ name }) => ({ name })));
  const context = await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: [skills[0].name],
    getVisibleSkills,
    search,
  });
  return {
    skills,
    context: context!,
    search,
    getVisibleSkills,
    setVisible: (next: typeof skills) => {
      visible = next;
    },
  };
}
function finding(
  context: Awaited<ReturnType<typeof prepareRelationReviewContext>>,
): SkillRelationReviewFinding {
  const [a, b] = context!.skills;
  return {
    trigger: "capability-fit",
    targetKind: "skill-relation",
    operation: "create",
    fromSkillId: a.identity.id,
    toSkillId: b.identity.id,
    relationType: "composes_with",
    reason: "Their documented outputs and inputs compose.",
    dedupeKey: "compose-pipeline",
    summary: "Document composition",
    evidence: ["Both skills document pipeline data."],
    correctionGoal: "Record documented composition",
    suggestedChange: "Create the relation",
    relationEvidence: [a, b].map((skill) => ({
      skillId: skill.identity.id,
      filePath: "SKILL.md",
      startLine: 5,
      endLine: 5,
      quote: `${skill.name} provides pipeline data.`,
    })),
  };
}
it("starts from recommended skills without a load and bounds extras to eight", async () => {
  const { context, search } = await fixture(15);
  expect(context.seedIds).toEqual([context.skills[0].identity.id]);
  expect(context.skills).toHaveLength(9);
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 8 }));
});
it("validates exact original excerpts and rejects unstaged or nonseed-only changes", async () => {
  const { context } = await fixture();
  const proposed = finding(context);
  expect(
    validateRelationReviewFindings(context, [proposed])[0].evidence[0]
      .fileDigest,
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    validateRelationReviewFindings(context, [
      {
        ...proposed,
        relationEvidence: proposed.relationEvidence.map((e) => ({
          ...e,
          quote: "fabricated",
        })),
      },
    ]),
  ).toThrow();
  expect(() =>
    validateRelationReviewFindings(context, [
      {
        ...proposed,
        fromSkillId: context.skills[1].identity.id,
        toSkillId: context.skills[2].identity.id,
      },
    ]),
  ).toThrow();
});
it("publishes proposed relations and preserves concrete evidence in JSONL", async () => {
  const { context } = await fixture();
  expect(
    await applyPreparedRelationReview(
      context,
      [finding(context)],
      "event-1",
      "main",
    ),
  ).toEqual({ changed: 1, batchId: expect.any(String) });
  expect((await readRelationGraph(root))!.relations[0].rel).toBe(
    "composes_with",
  );
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toContain(
    "provides pipeline data",
  );
});
it("rejects current file changes and winning-root changes without publishing", async () => {
  const { skills, context, setVisible } = await fixture();
  setVisible(skills.slice(1));
  await expect(
    applyPreparedRelationReview(context, [finding(context)], "event-1", "main"),
  ).rejects.toThrow();
  setVisible(skills);
  await fs.appendFile(skills[0].location, "changed\n");
  await expect(
    applyPreparedRelationReview(context, [finding(context)], "event-2", "main"),
  ).rejects.toThrow();
  await expect(fs.stat(relationGraphPath(root))).rejects.toThrow();
});
it("skips discovery with no visible registered seeds and checks cancellation", async () => {
  const { search, getVisibleSkills } = await fixture();
  search.mockClear();
  expect(
    await prepareRelationReviewContext({
      dataRoot: root,
      seedNames: ["hidden"],
      getVisibleSkills,
      search,
    }),
  ).toBeUndefined();
  expect(search).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareRelationReviewContext({
      dataRoot: root,
      seedNames: ["skill-0"],
      getVisibleSkills,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});
it("caps extra discovery attempts even when early candidates are unreadable", async () => {
  const { skills, getVisibleSkills, search } = await fixture(15);
  for (const skill of skills.slice(1, 9))
    await fs.writeFile(skill.location, "x".repeat(256 * 1024 + 1));
  const context = await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
    search,
  });
  expect(context?.skills).toHaveLength(1);
});

it("cancels a pending discovery search without accepting its late results", async () => {
  const { getVisibleSkills } = await fixture();
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (hits: { name: string }[]) => void;
  const pending = prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
    signal: controller.signal,
    search: async () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await ready;
  controller.abort();
  await expect(pending).rejects.toThrow();
  finish([{ name: "skill-1" }]);
});

it("rejects an absent target that was created and removed during review", async () => {
  const { context } = await fixture();
  const [from, to] = context.skills;
  await appendImportedRelations(root, [
    {
      from: from.identity,
      to: to.identity,
      type: "related",
      reason: "Intervening declaration",
    },
  ]);
  await fs.appendFile(
    relationGraphPath(root),
    JSON.stringify({
      op: "unrelate",
      from: from.identity.id,
      rel: "related",
      to: to.identity.id,
    }) + "\n",
  );
  await expect(
    applyPreparedRelationReview(context, [finding(context)], "event-1", "main"),
  ).rejects.toThrow("stale-review-revision");
  expect((await readRelationGraph(root))?.relations).toHaveLength(0);
});

it("updates then deletes an imported relation using fresh content evidence each time", async () => {
  const { context, getVisibleSkills, search } = await fixture();
  const [from, to] = context.skills;
  await appendImportedRelations(root, [
    {
      from: from.identity,
      to: to.identity,
      type: "related",
      reason: "Original broad relation",
      sourceGraphDigest: "f".repeat(64),
    },
  ]);
  const updatedContext = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: [from.name],
    getVisibleSkills,
    search,
  }))!;
  await applyPreparedRelationReview(
    updatedContext,
    [{ ...finding(updatedContext), operation: "update" }],
    "update-event",
    "main",
  );
  const updated = (await readRelationGraph(root))!.relations[0];
  expect(updated.rel).toBe("composes_with");
  expect(updated.properties.source).toBeUndefined();
  expect(updated.properties.sourceGraphDigest).toBe("f".repeat(64));
  const deletedContext = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: [from.name],
    getVisibleSkills,
    search,
  }))!;
  await applyPreparedRelationReview(
    deletedContext,
    [{ ...finding(deletedContext), operation: "delete" }],
    "delete-event",
    "main",
  );
  expect((await readRelationGraph(root))!.relations).toHaveLength(0);
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toContain(
    "Original broad relation",
  );
});
