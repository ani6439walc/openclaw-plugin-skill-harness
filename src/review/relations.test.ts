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
  stageRelationReviewEvidence,
  stageRelationReviewSkill,
} from "./relations.js";
import type { SkillRelationReviewFinding } from "./types.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-relations-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(count = 3, admit = true) {
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
  const context = await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: [skills[0].name],
    getVisibleSkills,
  });
  if (admit) {
    for (const skill of skills.slice(1)) await context!.admitSkill(skill.name);
  }
  return {
    skills,
    context: context!,
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
  const { context } = await fixture(15);
  expect(context.seedIds).toEqual([context.skills[0].identity.id]);
  expect(context.skills).toHaveLength(9);
  expect(context.preparation.discoveryAttempts).toBe(8);
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
  const { getVisibleSkills } = await fixture();
  expect(
    await prepareRelationReviewContext({
      dataRoot: root,
      seedNames: ["hidden"],
      getVisibleSkills,
    }),
  ).toBeUndefined();
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
  const { skills, getVisibleSkills } = await fixture(15, false);
  for (const skill of skills.slice(1, 9))
    await fs.writeFile(skill.location, "x".repeat(256 * 1024 + 1));
  const context = await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  });
  for (const skill of skills.slice(1)) await context!.admitSkill(skill.name);
  expect(context?.skills).toHaveLength(1);
  expect(context?.preparation.discoveryAttempts).toBe(8);
  expect(context?.preparation.skippedCaptureCount).toBe(8);
});

it("cancels a pending admission without accepting its late result", async () => {
  const { skills } = await fixture(3, false);
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (value: typeof skills) => void;
  let block = false;
  const context = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills: async () => {
      if (!block) return skills;
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    signal: controller.signal,
  }))!;
  block = true;
  const pending = context.admitSkill("skill-1");
  await ready;
  controller.abort();
  finish(skills);
  await expect(pending).rejects.toThrow();
  expect(context.skills).toHaveLength(1);
});

it("starts with seeds only and admits stable snapshots on demand", async () => {
  const { context, skills } = await fixture(3, false);
  expect(context.skills).toHaveLength(1);
  const admission = await context.admitSkill("skill-1");
  expect(admission.status).toBe("eligible");
  await fs.appendFile(skills[1].location, "later change\n");
  expect(await context.admitSkill("SKILL-1")).toEqual(admission);
  expect(context.skills).toHaveLength(2);
  expect(context.preparation.discoveryAttempts).toBe(1);
});

it("rotates existing neighbors while reserving discovery capacity", async () => {
  const { skills, getVisibleSkills } = await fixture(13, false);
  const all = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: skills.map(({ name }) => name),
    getVisibleSkills,
  }))!;
  await appendImportedRelations(
    root,
    all.skills.slice(1).map((to) => ({
      from: all.skills[0].identity,
      to: to.identity,
      type: "related" as const,
      reason: "Documented shared pipeline",
    })),
  );
  const first = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  }))!;
  expect(first.skills).toHaveLength(5);
  expect(first.preparation.existingNeighborAttempts).toBe(4);
  expect(first.inspectionCursor).toEqual({
    key: expect.stringMatching(/^[a-f0-9]{64}$/),
    nextOffset: 4,
  });
  const second = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
    getNeighborOffset: (key) =>
      key === first.inspectionCursor!.key
        ? first.inspectionCursor!.nextOffset
        : 0,
  }))!;
  expect(
    second.skills
      .slice(1)
      .some((entry) => first.skills.some((old) => old.name === entry.name)),
  ).toBe(false);
  for (const skill of skills.slice(1)) await first.admitSkill(skill.name);
  expect(first.skills).toHaveLength(9);
  expect(first.preparation.discoveryAttempts).toBe(4);
});

it("rechecks current visibility before new admission", async () => {
  const { context, skills, setVisible } = await fixture(3, false);
  setVisible([skills[0]]);
  expect(await context.admitSkill("skill-1")).toMatchObject({
    status: "ineligible",
  });
  expect(context.skills).toHaveLength(1);
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
  const { context, getVisibleSkills } = await fixture();
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

it("serializes concurrent admissions without exceeding the extra-skill budget", async () => {
  const { context, skills } = await fixture(15, false);
  const results = await Promise.all(
    skills
      .slice(1)
      .flatMap(({ name }) => [
        context.admitSkill(name),
        context.admitSkill(name),
      ]),
  );
  expect(context.skills).toHaveLength(9);
  expect(context.preparation.discoveryAttempts).toBe(8);
  expect(context.preparation.capturedExtras).toBe(8);
  expect(results.filter((entry) => entry.status === "eligible")).toHaveLength(
    16,
  );
});

it("uses the current graph for new endpoints without refreshing already captured pair revisions", async () => {
  const { context: identities, getVisibleSkills } = await fixture(4);
  const context = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  }))!;
  await context.admitSkill("skill-1");
  const [from, first, second] = identities.skills;
  await appendImportedRelations(root, [
    {
      from: from.identity,
      to: first.identity,
      type: "related",
      reason: "Concurrent first pair",
    },
    {
      from: from.identity,
      to: second.identity,
      type: "related",
      reason: "Current second pair",
    },
  ]);
  await context.admitSkill("skill-2");
  expect(context.relations).toHaveLength(1);
  expect(context.relations[0].to).toBe(second.identity.id);
  expect(
    context.relationRevisions.has(
      JSON.stringify([from.identity.id, first.identity.id]),
    ),
  ).toBe(false);
  expect(
    context.relationRevisions.has(
      JSON.stringify([from.identity.id, second.identity.id]),
    ),
  ).toBe(true);
  await expect(
    applyPreparedRelationReview(
      context,
      [finding(context)],
      "stale-old-pair",
      "main",
    ),
  ).rejects.toThrow("stale-review-revision");
  const proposed = finding(context);
  proposed.operation = "update";
  proposed.toSkillId = second.identity.id;
  proposed.relationEvidence[1] = {
    skillId: second.identity.id,
    filePath: "SKILL.md",
    startLine: 5,
    endLine: 5,
    quote: `${second.name} provides pipeline data.`,
  };
  expect(
    await applyPreparedRelationReview(
      context,
      [proposed],
      "fresh-new-pair",
      "main",
    ),
  ).toMatchObject({ changed: 1 });
});

it("rejects unregistered endpoints and reports distinct preparation skips", async () => {
  const onPreparation = vi.fn();
  await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: [],
    getVisibleSkills: async () => [],
    onPreparation,
  });
  expect(onPreparation).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: "no-seeds" }),
  );
  await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills: async () => [],
    onPreparation,
  });
  expect(onPreparation).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: "registry-unavailable" }),
  );
  const { context, skills, setVisible, getVisibleSkills } = await fixture(
    2,
    false,
  );
  await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["missing"],
    getVisibleSkills,
    onPreparation,
  });
  expect(onPreparation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      reason: "no-eligible-seeds",
      skippedCaptureCount: 1,
    }),
  );
  const unregistered = {
    name: "unregistered",
    description: "Unregistered skill",
    location: path.join(root, "unregistered", "SKILL.md"),
  };
  await fs.mkdir(path.dirname(unregistered.location));
  await fs.writeFile(
    unregistered.location,
    "---\nname: unregistered\ndescription: Unregistered skill\n---\nFull content\n",
  );
  setVisible([...skills, unregistered]);
  expect(await context.admitSkill(unregistered.name)).toEqual({
    status: "ineligible",
    reason: "unregistered",
  });
  expect(context.skills).toHaveLength(1);
});

it("enforces the total snapshot budget without truncating a newly admitted file", async () => {
  const { skills, getVisibleSkills } = await fixture(10, false);
  for (const skill of skills) {
    const content = await fs.readFile(skill.location, "utf8");
    await fs.writeFile(
      skill.location,
      content + "x".repeat(256 * 1024 - Buffer.byteLength(content)),
    );
  }
  const context = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  }))!;
  for (const skill of skills.slice(1, 8))
    expect((await context.admitSkill(skill.name)).status).toBe("eligible");
  expect(await context.admitSkill("skill-8")).toEqual({
    status: "ineligible",
    reason: "evidence-budget",
  });
  expect(context.skills).toHaveLength(8);
  expect(
    context.skills.reduce(
      (sum, skill) => sum + Buffer.byteLength(skill.content),
      0,
    ),
  ).toBe(2 * 1024 * 1024);
});

it("stages newly admitted snapshots idempotently without rewriting existing evidence", async () => {
  const { context } = await fixture(3, false);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await stageRelationReviewEvidence(context, workspace);
  const seedFile = path.join(workspace, context.skills[0].workspacePath);
  await fs.utimes(seedFile, 1, 1);
  const admitted = await context.admitSkill("skill-1");
  if (admitted.status !== "eligible") throw new Error("expected eligible");
  await stageRelationReviewSkill(admitted.skill, workspace);
  await stageRelationReviewEvidence(context, workspace);
  expect((await fs.stat(seedFile)).mtimeMs).toBe(1000);
  expect(
    await fs.readFile(
      path.join(workspace, admitted.skill.workspacePath),
      "utf8",
    ),
  ).toBe(admitted.skill.content);
  await fs.chmod(seedFile, 0o600);
  await fs.appendFile(seedFile, "tampered\n");
  await expect(stageRelationReviewEvidence(context, workspace)).rejects.toThrow(
    "stale-staged-evidence",
  );
});

it("rejects symlinked staging directories and evidence files", async () => {
  const { context } = await fixture(2, false);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, "relation-evidence"));
  await expect(
    stageRelationReviewEvidence(context, workspace),
  ).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
  await fs.unlink(path.join(workspace, "relation-evidence"));
  await stageRelationReviewEvidence(context, workspace);
  const file = path.join(workspace, context.skills[0].workspacePath);
  const outsideFile = path.join(outside, "SKILL.md");
  await fs.writeFile(outsideFile, context.skills[0].content);
  await fs.unlink(file);
  await fs.symlink(outsideFile, file);
  await expect(
    stageRelationReviewEvidence(context, workspace),
  ).rejects.toThrow();
  expect(await fs.readFile(outsideFile, "utf8")).toBe(
    context.skills[0].content,
  );
});

it("advances past failed existing-neighbor captures on the next inspection", async () => {
  const { skills, getVisibleSkills } = await fixture(11, false);
  const all = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: skills.map(({ name }) => name),
    getVisibleSkills,
  }))!;
  await appendImportedRelations(
    root,
    all.skills.slice(1).map((to) => ({
      from: all.skills[0].identity,
      to: to.identity,
      type: "related" as const,
      reason: "Shared documented workflow",
    })),
  );
  const firstNames = skills
    .slice(1)
    .map(({ name }) => name)
    .sort()
    .slice(0, 4);
  for (const skill of skills.filter(({ name }) => firstNames.includes(name)))
    await fs.writeFile(skill.location, "x".repeat(256 * 1024 + 1));
  const first = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  }))!;
  expect(first.skills).toHaveLength(1);
  expect(first.preparation.existingNeighborAttempts).toBe(4);
  expect(first.preparation.skippedCaptureCount).toBe(4);
  const second = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
    getNeighborOffset: () => first.inspectionCursor!.nextOffset,
  }))!;
  expect(second.skills).toHaveLength(5);
  expect(second.skills.some(({ name }) => firstNames.includes(name))).toBe(
    false,
  );
});
