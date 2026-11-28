import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  registerRelationSource,
  relationSourcesPath,
} from "../skills/relation-sources.js";
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
    trigger: "relation-health-check",
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

it("auto-registers unregistered seeds and discovered skills inside knownRoots while rejecting unknown roots", async () => {
  const knownRoot = path.join(root, "workspace-skills");
  const unknownRoot = path.join(root, "unknown-skills");
  const makeSkill = async (dir: string, name: string) => {
    const location = path.join(dir, name, "SKILL.md");
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(
      location,
      `---\nname: ${name}\ndescription: Workflow ${name}.\n---\n${name} provides pipeline data.\n`,
    );
    return { name, location, description: `Workflow ${name}.` };
  };
  const seed = await makeSkill(knownRoot, "seed-skill");
  const discovered = await makeSkill(knownRoot, "discovered-skill");
  const rogue = await makeSkill(unknownRoot, "rogue-skill");
  const visible = [seed, discovered, rogue];

  // No sources.json exists initially; knownRoots lets Review auto-register seeds and extras.
  const context = await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: [seed.name],
    getVisibleSkills: async () => visible,
    knownRoots: [{ path: knownRoot, source: "workspace" }],
  });
  expect(context).toBeDefined();
  expect(context!.skills).toHaveLength(1);
  expect(context!.skills[0].identity.id).toMatch(
    /^local:[a-f0-9-]{36}:seed-skill$/,
  );

  const admitted = await context!.admitSkill(discovered.name);
  expect(admitted.status).toBe("eligible");
  expect(await context!.admitSkill(rogue.name)).toEqual({
    status: "ineligible",
    reason: "unregistered",
  });

  // Auto-registered endpoints can publish verified relations to graph.jsonl.
  const receipt = await applyPreparedRelationReview(
    context!,
    [finding(context!)],
    "auto-reg-event",
    "main",
  );
  expect(receipt.changed).toBe(1);
  expect((await readRelationGraph(root))!.relations).toHaveLength(1);
});

it("reloads the registry after concurrent zero-write syncs so simultaneous Reviews both succeed", async () => {
  const knownRoot = path.join(root, "concurrent-skills");
  const makeSkill = async (name: string) => {
    const location = path.join(knownRoot, name, "SKILL.md");
    await fs.mkdir(path.dirname(location), { recursive: true });
    await fs.writeFile(
      location,
      `---\nname: ${name}\ndescription: Workflow ${name}.\n---\n${name} body.\n`,
    );
    return { name, location, description: `Workflow ${name}.` };
  };
  const sharedSeed = await makeSkill("shared-seed");
  const sharedExtra = await makeSkill("shared-extra");
  const visible = [sharedSeed, sharedExtra];
  const knownRoots = [{ path: knownRoot, source: "workspace" as const }];

  const [ctxA, ctxB] = await Promise.all([
    prepareRelationReviewContext({
      dataRoot: root,
      seedNames: [sharedSeed.name],
      getVisibleSkills: async () => visible,
      knownRoots,
    }),
    prepareRelationReviewContext({
      dataRoot: root,
      seedNames: [sharedSeed.name],
      getVisibleSkills: async () => visible,
      knownRoots,
    }),
  ]);
  expect(ctxA).toBeDefined();
  expect(ctxB).toBeDefined();
  expect(ctxA!.seedIds).toEqual(ctxB!.seedIds);

  const [admitA, admitB] = await Promise.all([
    ctxA!.admitSkill(sharedExtra.name),
    ctxB!.admitSkill(sharedExtra.name),
  ]);
  expect(admitA.status).toBe("eligible");
  expect(admitB.status).toBe("eligible");
  if (admitA.status === "eligible" && admitB.status === "eligible") {
    expect(admitA.skill.identity.id).toBe(admitB.skill.identity.id);
  }
});

it("reports registry-unavailable up front for corrupt, symlinked, or missing-with-graph registries even with knownRoots and no visible seeds", async () => {
  const knownRoot = path.join(root, "known-skills");
  const location = path.join(knownRoot, "valid-skill", "SKILL.md");
  await fs.mkdir(path.dirname(location), { recursive: true });
  await fs.writeFile(
    location,
    "---\nname: valid-skill\ndescription: Valid.\n---\nBody.\n",
  );
  const visible = [{ name: "valid-skill", location, description: "Valid." }];
  const knownRoots = [{ path: knownRoot, source: "workspace" as const }];

  // 1. Corrupt sources.json with no visible seeds -> registry-unavailable (not no-eligible-seeds).
  const corruptRoot = path.join(root, "corrupt-data");
  const corruptSources = relationSourcesPath(corruptRoot);
  await fs.mkdir(path.dirname(corruptSources), { recursive: true });
  await fs.writeFile(corruptSources, "{broken");
  const onCorrupt = vi.fn();
  expect(
    await prepareRelationReviewContext({
      dataRoot: corruptRoot,
      seedNames: ["invisible-seed"],
      getVisibleSkills: async () => visible,
      knownRoots,
      onPreparation: onCorrupt,
    }),
  ).toBeUndefined();
  expect(onCorrupt).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: "registry-unavailable" }),
  );

  // 2. Symlinked sources.json with no visible seeds -> registry-unavailable.
  const symlinkRoot = path.join(root, "symlink-data");
  const symlinkSources = relationSourcesPath(symlinkRoot);
  const externalSources = path.join(root, "external.json");
  await fs.writeFile(
    externalSources,
    JSON.stringify({ version: 1, sources: [] }),
  );
  await fs.mkdir(path.dirname(symlinkSources), { recursive: true });
  await fs.symlink(externalSources, symlinkSources);
  const onSymlink = vi.fn();
  expect(
    await prepareRelationReviewContext({
      dataRoot: symlinkRoot,
      seedNames: ["invisible-seed"],
      getVisibleSkills: async () => visible,
      knownRoots,
      onPreparation: onSymlink,
    }),
  ).toBeUndefined();
  expect(onSymlink).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: "registry-unavailable" }),
  );

  // 3. Missing sources.json alongside existing stable-ID graph.jsonl -> registry-unavailable and no new UUID minted.
  const partialRoot = path.join(root, "partial-restore");
  const graphFile = relationGraphPath(partialRoot);
  await fs.mkdir(path.dirname(graphFile), { recursive: true });
  await fs.writeFile(
    graphFile,
    `${JSON.stringify({
      op: "create",
      entity: {
        id: "local:22222222-2222-4222-8222-222222222222:valid-skill",
        type: "Skill",
        properties: {
          name: "valid-skill",
          source_id: "local:22222222-2222-4222-8222-222222222222",
          skill_key: "valid-skill",
          source_path: "valid-skill/SKILL.md",
          formatVersion: 2,
        },
      },
    })}\n`,
  );
  const onPartial = vi.fn();
  expect(
    await prepareRelationReviewContext({
      dataRoot: partialRoot,
      seedNames: ["valid-skill"],
      getVisibleSkills: async () => visible,
      knownRoots,
      onPreparation: onPartial,
    }),
  ).toBeUndefined();
  expect(onPartial).toHaveBeenLastCalledWith(
    expect.objectContaining({ reason: "registry-unavailable" }),
  );
  await expect(fs.stat(relationSourcesPath(partialRoot))).rejects.toThrow();

  // 4. Peer publishes sources.json + stable-ID graph between initial miss and graph check -> Review still becomes ready.
  const raceRoot = path.join(root, "race-publish");
  const raceSources = relationSourcesPath(raceRoot);
  const raceGraph = relationGraphPath(raceRoot);
  const realKnownRoot = await fs.realpath(knownRoot);
  const raceSourceId = "local:44444444-4444-4444-8444-444444444444";
  await fs.mkdir(path.dirname(raceSources), { recursive: true });
  const realLstat = fs.lstat.bind(fs);
  let injectedMiss = false;
  const lstatSpy = vi
    .spyOn(fs, "lstat")
    .mockImplementation(async (targetPath, ...rest) => {
      if (!injectedMiss && String(targetPath) === raceSources) {
        injectedMiss = true;
        await fs.writeFile(
          raceSources,
          JSON.stringify(
            {
              version: 1,
              sources: [
                {
                  id: raceSourceId,
                  root: realKnownRoot,
                  skills: {
                    "valid-skill": {
                      name: "valid-skill",
                      source_path: "valid-skill/SKILL.md",
                    },
                  },
                },
              ],
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        await fs.writeFile(
          raceGraph,
          `${JSON.stringify({
            op: "create",
            entity: {
              id: `${raceSourceId}:valid-skill`,
              type: "Skill",
              properties: {
                name: "valid-skill",
                source_id: raceSourceId,
                skill_key: "valid-skill",
                source_path: "valid-skill/SKILL.md",
                formatVersion: 2,
              },
            },
          })}\n`,
        );
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return realLstat(targetPath, ...rest);
    });

  try {
    const onRace = vi.fn();
    const racedContext = await prepareRelationReviewContext({
      dataRoot: raceRoot,
      seedNames: ["valid-skill"],
      getVisibleSkills: async () => visible,
      knownRoots,
      onPreparation: onRace,
    });
    expect(racedContext).toBeDefined();
    expect(racedContext!.seedIds).toEqual([`${raceSourceId}:valid-skill`]);
    expect(onRace).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ready", capturedSeeds: 1 }),
    );
  } finally {
    lstatSpy.mockRestore();
  }
});

it("prioritizes unreviewed related and imported neighbors ahead of reviewed ones and reconciles cursor after apply", async () => {
  const { skills, getVisibleSkills } = await fixture(10, false);
  const all = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: skills.map(({ name }) => name),
    getVisibleSkills,
  }))!;
  const [seed, ...others] = all.skills;
  // Seed alphabetically early reviewed edges (skill-1, skill-2),
  // middle unreviewed typed edges (skill-3, skill-4),
  // and alphabetically late unreviewed related edges (skill-5..skill-9).
  await appendImportedRelations(root, [
    ...others.slice(0, 4).map((to) => ({
      from: seed.identity,
      to: to.identity,
      type: "composes_with" as const,
      reason: "Typed workflow composition",
    })),
    ...others.slice(4).map((to) => ({
      from: seed.identity,
      to: to.identity,
      type: "related" as const,
      reason: "Broad imported relation",
    })),
  ]);
  // Mark skill-1 and skill-2 as already reviewed via Review update.
  const preReview = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  }))!;
  await preReview.admitSkill("skill-1");
  await preReview.admitSkill("skill-2");
  const reviewSeed = preReview.skills[0]!;
  const reviewedTargets = preReview.skills.filter(
    (entry) => entry.name === "skill-1" || entry.name === "skill-2",
  );
  await applyPreparedRelationReview(
    preReview,
    reviewedTargets.map((target) => ({
      targetKind: "skill-relation" as const,
      trigger: "relation-health-check" as const,
      operation: "update" as const,
      fromSkillId: reviewSeed.identity.id,
      toSkillId: target.identity.id,
      relationType: "composes_with" as const,
      reason: "Reviewed workflow composition",
      dedupeKey: `review-${target.name}`,
      summary: `Confirm ${target.name}`,
      evidence: ["Read full skills"],
      correctionGoal: "Confirm reviewed composition",
      suggestedChange: "Update composition",
      relationEvidence: [reviewSeed, target].map((skill) => ({
        skillId: skill.identity.id,
        filePath: "SKILL.md",
        startLine: 4,
        endLine: 4,
        quote: skill.content.split(/\r?\n/)[3]!,
      })),
    })),
    "mark-reviewed",
    "main",
  );

  // Run 1 at offset 0 must pick the first 4 unreviewed related neighbors (skill-5..skill-8),
  // ahead of alphabetically earlier skill-1..skill-4.
  const run1 = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
  }))!;
  expect(run1.skills.slice(1).map((entry) => entry.name)).toEqual([
    "skill-5",
    "skill-6",
    "skill-7",
    "skill-8",
  ]);
  expect(run1.inspectionCursor?.nextOffset).toBe(4);

  // Upgrade skill-5 and skill-6, and delete skill-7 (leaving skill-8 as unreviewed related).
  const run1Seed = run1.skills[0]!;
  const byName = new Map(run1.skills.map((entry) => [entry.name, entry]));
  const evidenceFor = (targetName: string) =>
    [run1Seed, byName.get(targetName)!].map((skill) => ({
      skillId: skill.identity.id,
      filePath: "SKILL.md",
      startLine: 4,
      endLine: 4,
      quote: skill.content.split(/\r?\n/)[3]!,
    }));
  await applyPreparedRelationReview(
    run1,
    [
      {
        targetKind: "skill-relation",
        trigger: "relation-health-check",
        operation: "update",
        fromSkillId: run1Seed.identity.id,
        toSkillId: byName.get("skill-5")!.identity.id,
        relationType: "composes_with",
        reason: "Upgraded from related",
        dedupeKey: "upgrade-5",
        summary: "Upgrade skill-5",
        evidence: ["Read full skills"],
        correctionGoal: "Replace broad related with composes_with",
        suggestedChange: "Update skill-5",
        relationEvidence: evidenceFor("skill-5"),
      },
      {
        targetKind: "skill-relation",
        trigger: "relation-health-check",
        operation: "update",
        fromSkillId: run1Seed.identity.id,
        toSkillId: byName.get("skill-6")!.identity.id,
        relationType: "specializes",
        reason: "Upgraded from related",
        dedupeKey: "upgrade-6",
        summary: "Upgrade skill-6",
        evidence: ["Read full skills"],
        correctionGoal: "Replace broad related with specializes",
        suggestedChange: "Update skill-6",
        relationEvidence: evidenceFor("skill-6"),
      },
      {
        targetKind: "skill-relation",
        trigger: "relation-health-check",
        operation: "delete",
        fromSkillId: run1Seed.identity.id,
        toSkillId: byName.get("skill-7")!.identity.id,
        dedupeKey: "delete-7",
        summary: "Delete unrelated skill-7",
        evidence: ["Read full skills"],
        correctionGoal: "No documented workflow or structural link",
        suggestedChange: "Delete skill-7",
        relationEvidence: evidenceFor("skill-7"),
      },
    ],
    "run-1-changes",
    "main",
  );

  // Reconciled cursor must land directly on skill-9 (next uninspected neighbor)
  // without skipping skill-9/skill-3/skill-4 or re-inspecting skill-5/skill-6/skill-8.
  // Post-apply priority list is:
  //   [skill-8 (T0), skill-9 (T0), skill-3 (T1), skill-4 (T1), skill-1 (T2), skill-2 (T2), skill-5 (T2), skill-6 (T2)]
  expect(run1.inspectionCursor?.nextOffset).toBe(1);
  const run2 = (await prepareRelationReviewContext({
    dataRoot: root,
    seedNames: ["skill-0"],
    getVisibleSkills,
    getNeighborOffset: (key) =>
      key === run1.inspectionCursor!.key
        ? run1.inspectionCursor!.nextOffset
        : 0,
  }))!;
  expect(run2.skills.slice(1).map((entry) => entry.name)).toEqual([
    "skill-9",
    "skill-3",
    "skill-4",
    "skill-1",
  ]);
});
