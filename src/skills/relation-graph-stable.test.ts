import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../file-utils.js";
import {
  appendImportedRelations,
  readSkillIdentity,
  relationGraphPath,
  resolveRelationGraph,
  publishRelationSnapshot,
  destinationGraphDigest,
  registryDigest,
} from "./relation-graph.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "stable-relations-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const source = path.join(root, "source");
  const skills = await Promise.all(
    ["a", "b", "c"].map(async (name) => {
      const location = path.join(source, name, "SKILL.md");
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(location, `---\nname: ${name}\n---\n${name} body\n`);
      return { name, location };
    }),
  );
  const registry = {
    version: 1 as const,
    sources: [
      {
        id: "github:example/skills",
        root: source,
        skills: Object.fromEntries(
          skills.map(({ name }) => [
            name,
            { name, source_path: `${name}/SKILL.md` },
          ]),
        ),
      },
    ],
  };
  writeJsonAtomic(path.join(root, "skill-relations/sources.json"), registry);
  const identities = await Promise.all(
    skills.map((skill) => readSkillIdentity(skill, registry)),
  );
  return { skills, registry, identities };
}

it("keeps a stable ID when content changes and binds only the winning source", async () => {
  const { skills, registry, identities } = await fixture();
  const before = identities[0]!;
  expect(before.id).toBe("github:example/skills:a");
  await fs.appendFile(skills[0].location, "changed\n");
  const after = (await readSkillIdentity(skills[0], registry))!;
  expect(after.id).toBe(before.id);
  expect(after.fingerprint).not.toBe(before.fingerprint);
  const other = path.join(root, "other", "SKILL.md");
  await fs.mkdir(path.dirname(other));
  await fs.copyFile(skills[0].location, other);
  expect(
    await readSkillIdentity({ name: "a", location: other }, registry),
  ).toBeUndefined();
});

it("pins each edge to its endpoint revisions so refreshing a node does not revive another edge", async () => {
  const { skills, registry, identities } = await fixture();
  await appendImportedRelations(root, [
    {
      from: identities[0]!,
      to: identities[1]!,
      type: "related",
      reason: "a-b",
    },
    {
      from: identities[0]!,
      to: identities[2]!,
      type: "related",
      reason: "a-c",
    },
  ]);
  expect((await resolveRelationGraph(root, skills)).get("a")).toHaveLength(2);
  await fs.appendFile(skills[0].location, "new revision\n");
  expect((await resolveRelationGraph(root, skills)).size).toBe(0);
  const from = (await readSkillIdentity(skills[0], registry))!;
  await appendImportedRelations(root, [
    { from, to: identities[1]!, type: "related", reason: "a-b refreshed" },
  ]);
  expect((await resolveRelationGraph(root, skills)).get("a")).toEqual([
    expect.objectContaining({ name: "b", reason: "a-b refreshed" }),
  ]);
  const raw = await fs.readFile(relationGraphPath(root), "utf8");
  expect(raw).not.toContain("verification_status");
  expect(raw).toContain('"fromFingerprint"');
});

it("rejects stale stable imports at the locked publication boundary", async () => {
  const { skills, identities } = await fixture();
  await fs.appendFile(skills[0].location, "changed after preflight\n");
  await expect(
    appendImportedRelations(root, [
      {
        from: identities[0]!,
        to: identities[1]!,
        type: "related",
        reason: "a-b",
      },
    ]),
  ).rejects.toThrow("stale-source");
  await expect(fs.stat(relationGraphPath(root))).rejects.toThrow();
});

it("retains stable edges after an explicit root relocation without old absolute paths", async () => {
  const { skills, identities, registry } = await fixture();
  await appendImportedRelations(root, [
    {
      from: identities[0]!,
      to: identities[1]!,
      type: "related",
      reason: "a-b",
    },
  ]);
  const moved = path.join(root, "moved");
  await fs.rename(registry.sources[0].root, moved);
  registry.sources[0].root = moved;
  writeJsonAtomic(path.join(root, "skill-relations/sources.json"), registry);
  const relocated = skills.map((skill) => ({
    ...skill,
    location: path.join(moved, skill.name, "SKILL.md"),
  }));
  expect((await resolveRelationGraph(root, relocated)).get("a")).toHaveLength(
    1,
  );
  const raw = await fs.readFile(relationGraphPath(root), "utf8");
  expect(raw).not.toContain(root);
});

it("publishes complete snapshots including isolated nodes and rejects a changed destination", async () => {
  const { identities, registry } = await fixture();
  const nodes = identities.map((identity) => identity!);
  const relations = [
    { from: nodes[0], to: nodes[1], type: "related" as const, reason: "a-b" },
  ];
  const options = {
    expectedGraphDigest: null,
    expectedSourcesDigest: registryDigest(registry),
    assertSourceCurrent: async () => {},
  };
  const published = await publishRelationSnapshot(
    root,
    nodes,
    relations,
    options,
  );
  expect(published).toMatchObject({ nodes: 3, relations: 1 });
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(
    publishRelationSnapshot(root, nodes, [], options),
  ).rejects.toThrow("stale-destination");
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
  const digest = await destinationGraphDigest(root);
  const next = await publishRelationSnapshot(root, nodes, [], {
    ...options,
    expectedGraphDigest: digest,
  });
  expect(
    await fs.readFile(path.join(next.backupPath!, "graph.jsonl"), "utf8"),
  ).toBe(before);
  expect(
    await fs.readFile(path.join(next.backupPath!, "sources.json"), "utf8"),
  ).toContain("github:example/skills");
});

it("checks the registry and source inside the snapshot publication lock", async () => {
  const { identities, registry } = await fixture();
  const nodes = identities.map((identity) => identity!);
  const options = {
    expectedGraphDigest: null,
    expectedSourcesDigest: registryDigest(registry),
    assertSourceCurrent: async () => {
      throw new Error("source-changed");
    },
  };
  await expect(
    publishRelationSnapshot(root, nodes, [], options),
  ).rejects.toThrow("source-changed");
  await expect(fs.stat(relationGraphPath(root))).rejects.toThrow();
  registry.sources[0].label = "changed registry";
  writeJsonAtomic(path.join(root, "skill-relations/sources.json"), registry);
  await expect(
    publishRelationSnapshot(root, nodes, [], options),
  ).rejects.toThrow("stale-registry");
  await expect(fs.stat(relationGraphPath(root))).rejects.toThrow();
});

it("requires explicit snapshot migration instead of mixing legacy and stable writers", async () => {
  const { skills, identities } = await fixture();
  const legacy = await Promise.all(
    skills.map((skill) => readSkillIdentity(skill)),
  );
  const oldEdge = {
    from: legacy[0]!,
    to: legacy[1]!,
    type: "related" as const,
    reason: "old",
  };
  const newEdge = {
    from: identities[0]!,
    to: identities[1]!,
    type: "related" as const,
    reason: "new",
  };
  await appendImportedRelations(root, [oldEdge]);
  const oldBytes = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(appendImportedRelations(root, [newEdge])).rejects.toThrow(
    "stable-writer-on-legacy-graph",
  );
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(oldBytes);
  await fs.unlink(relationGraphPath(root));
  await appendImportedRelations(root, [newEdge]);
  const newBytes = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(appendImportedRelations(root, [oldEdge])).rejects.toThrow(
    "legacy-writer-on-stable-graph",
  );
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(newBytes);
});

it("rejects a symlinked managed graph directory without changing its target permissions", async () => {
  const { identities, registry } = await fixture();
  const aliasRoot = path.join(root, "alias-data");
  const target = path.join(root, "external-directory");
  await fs.mkdir(aliasRoot);
  await fs.mkdir(target, { mode: 0o755 });
  await fs.chmod(target, 0o755);
  await fs.symlink(target, path.join(aliasRoot, "skill-relations"));
  await expect(
    publishRelationSnapshot(
      aliasRoot,
      identities.map((identity) => identity!),
      [],
      {
        expectedGraphDigest: null,
        expectedSourcesDigest: registryDigest(registry),
        assertSourceCurrent: async () => {},
      },
    ),
  ).rejects.toThrow("invalid-graph-directory");
  expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  expect(await fs.readdir(target)).toEqual([]);
});
