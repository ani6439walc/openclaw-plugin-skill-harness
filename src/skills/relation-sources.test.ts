import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureKnownRelationSources,
  readRelationSources,
  registerRelationSource,
  relationSourcesPath,
  resolveRelationSource,
  stableSkillId,
  validateRelationSources,
} from "./relation-sources.js";
import type { RelationSourceRegistry } from "./relation-sources.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relation-sources-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function skill(directory: string, name: string) {
  const location = path.join(directory, "SKILL.md");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(location, `---\nname: ${name}\n---\n${name}\n`);
  return { name, location };
}
const bindings = (name: string) => ({
  [name]: { name, source_path: `${name}/SKILL.md` },
});

it("builds portable IDs and rejects ambiguous or credential-bearing identifiers", () => {
  expect(stableSkillId("github:Owner/Repo", "sample")).toBe(
    "github:owner/repo:sample",
  );
  expect(stableSkillId("git:git.example.test/team/repo", "sample")).toBe(
    "git:git.example.test/team/repo:sample",
  );
  for (const source of [
    "https://user:password@example.test/repo",
    "github:owner/repo:branch",
    "git:user@example.test/team/repo",
    "local:missing-uuid",
  ]) {
    expect(() => stableSkillId(source, "sample")).toThrow();
  }
  for (const key of ["", "a:b", "a/b", "..", " Sample ", "SAMPLE"]) {
    expect(() => stableSkillId("github:owner/repo", key)).toThrow();
  }
});

it("does not allocate local identities or create files while reading missing state", async () => {
  expect(readRelationSources(root)).toBeUndefined();
  expect(await fs.readdir(root)).toEqual([]);
});

it("registers a local collection once and preserves keys through content edits", async () => {
  const collection = path.join(root, "collection");
  const current = await skill(path.join(collection, "sample"), "sample");
  const first = await registerRelationSource(root, {
    root: collection,
    label: "Workshop",
    skills: bindings("sample"),
  });
  expect(first.id).toMatch(/^local:[a-f0-9-]{36}$/);
  await fs.appendFile(current.location, "A revision\n");
  const second = await registerRelationSource(root, {
    root: collection,
    skills: bindings("sample"),
  });
  expect(second.id).toBe(first.id);
  expect(second.label).toBe("Workshop");
  expect((await fs.stat(relationSourcesPath(root))).mode & 0o777).toBe(0o600);
  expect(
    (await fs.stat(path.dirname(relationSourcesPath(root)))).mode & 0o777,
  ).toBe(0o700);
  const registry = readRelationSources(root)!;
  expect(await resolveRelationSource(current, registry)).toEqual({
    id: `${first.id}:sample`,
    source_id: first.id,
    skill_key: "sample",
    source_path: "sample/SKILL.md",
  });
});

it("treats prototype-named skill keys as ordinary own properties", async () => {
  const collection = path.join(root, "collection");
  await skill(path.join(collection, "sample"), "sample");
  await registerRelationSource(root, {
    root: collection,
    skills: bindings("sample"),
  });
  const current = await skill(
    path.join(collection, "constructor"),
    "constructor",
  );
  const source = await registerRelationSource(root, {
    root: collection,
    skills: bindings("constructor"),
  });
  const registry = readRelationSources(root)!;
  expect(Object.hasOwn(registry.sources[0].skills, "constructor")).toBe(true);
  expect((await resolveRelationSource(current, registry))?.id).toBe(
    `${source.id}:constructor`,
  );
});

it("serializes concurrent registration without losing local source identities or skills", async () => {
  const collection = path.join(root, "collection");
  await skill(path.join(collection, "a"), "a");
  await skill(path.join(collection, "b"), "b");
  const results = await Promise.all(
    ["a", "b"].map((name) =>
      registerRelationSource(root, {
        root: collection,
        skills: bindings(name),
      }),
    ),
  );
  expect(results[0].id).toBe(results[1].id);
  expect(
    Object.keys(readRelationSources(root)!.sources[0].skills).sort(),
  ).toEqual(["a", "b"]);
});

it("requires explicit rebind and rename while retaining the immutable skill key", async () => {
  const originalRoot = path.join(root, "original");
  await skill(path.join(originalRoot, "old"), "old");
  const source = await registerRelationSource(root, {
    id: "github:owner/repo",
    root: originalRoot,
    skills: bindings("old"),
  });
  const movedRoot = path.join(root, "moved");
  await fs.rename(originalRoot, movedRoot);
  const rebind = { id: source.id, root: movedRoot, skills: bindings("old") };
  await expect(registerRelationSource(root, rebind)).rejects.toThrow();
  await registerRelationSource(root, { ...rebind, rebind: true });
  const renamed = await skill(path.join(movedRoot, "renamed"), "renamed");
  const rename = {
    id: source.id,
    root: movedRoot,
    skills: { old: { name: "renamed", source_path: "renamed/SKILL.md" } },
  };
  await expect(registerRelationSource(root, rename)).rejects.toThrow();
  await registerRelationSource(root, { ...rename, rename: true });
  expect(
    await resolveRelationSource(renamed, readRelationSources(root)!),
  ).toEqual({
    id: "github:owner/repo:old",
    source_id: source.id,
    skill_key: "old",
    source_path: "renamed/SKILL.md",
  });
});

it("validates retained bindings when explicitly rebinding a collection", async () => {
  const originalRoot = path.join(root, "original");
  await skill(path.join(originalRoot, "sample"), "sample");
  const source = await registerRelationSource(root, {
    id: "github:owner/repo",
    root: originalRoot,
    skills: bindings("sample"),
  });
  const empty = path.join(root, "empty");
  await fs.mkdir(empty);
  const before = await fs.readFile(relationSourcesPath(root), "utf8");
  await expect(
    registerRelationSource(root, {
      id: source.id,
      root: empty,
      skills: {},
      rebind: true,
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(relationSourcesPath(root), "utf8")).toBe(before);
});

it("removes only explicitly named deleted skills while preserving the source identity", async () => {
  const collection = path.join(root, "collection");
  await skill(path.join(collection, "a"), "a");
  await skill(path.join(collection, "b"), "b");
  const source = await registerRelationSource(root, {
    root: collection,
    skills: { ...bindings("a"), ...bindings("b") },
  });
  await fs.rm(path.join(collection, "b"), { recursive: true });
  const omitted = await registerRelationSource(root, {
    id: source.id,
    root: collection,
    skills: bindings("a"),
  });
  expect(Object.keys(omitted.skills).sort()).toEqual(["a", "b"]);
  const removed = await registerRelationSource(root, {
    id: source.id,
    root: collection,
    skills: bindings("a"),
    removeKeys: ["b"],
  });
  expect(removed.id).toBe(source.id);
  expect(removed.skills).toEqual(bindings("a"));
  expect(readRelationSources(root)!.sources[0]).toEqual(removed);
});

it("rejects invalid, duplicate, unknown and simultaneously supplied removal keys", async () => {
  const collection = path.join(root, "collection");
  await skill(path.join(collection, "a"), "a");
  const source = await registerRelationSource(root, {
    root: collection,
    skills: bindings("a"),
  });
  const file = relationSourcesPath(root);
  const before = await fs.readFile(file, "utf8");
  for (const removeKeys of [[".."], ["a", "a"], ["unknown"], ["constructor"]]) {
    await expect(
      registerRelationSource(root, {
        id: source.id,
        root: collection,
        skills: {},
        removeKeys,
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(before);
  }
  await expect(
    registerRelationSource(root, {
      id: source.id,
      root: collection,
      skills: bindings("a"),
      removeKeys: ["a"],
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe(before);
});

it("does not infer origin from names, content, or the containing installation category", async () => {
  const collection = path.join(root, "upstream");
  const original = await skill(path.join(collection, "sample"), "sample");
  await registerRelationSource(root, {
    id: "github:owner/repo",
    root: collection,
    skills: bindings("sample"),
  });
  const copy = await skill(path.join(root, "workshop", "sample"), "sample");
  const registry = readRelationSources(root)!;
  expect(await resolveRelationSource(original, registry)).toBeDefined();
  expect(await resolveRelationSource(copy, registry)).toBeUndefined();
  expect(
    await resolveRelationSource({ ...original, name: "other-name" }, registry),
  ).toBeUndefined();
});

it("permits whole skill-directory symlinks and rejects escaping or broken main files", async () => {
  const external = await skill(path.join(root, "external"), "sample");
  const collection = path.join(root, "collection");
  await fs.mkdir(collection);
  await fs.symlink(
    path.dirname(external.location),
    path.join(collection, "sample"),
  );
  await registerRelationSource(root, {
    id: "github:owner/repo",
    root: collection,
    skills: bindings("sample"),
  });
  const registry = readRelationSources(root)!;
  expect(await resolveRelationSource(external, registry)).toBeDefined();
  const escaped = path.join(root, "escaped");
  await fs.mkdir(escaped);
  await fs.symlink(external.location, path.join(escaped, "SKILL.md"));
  expect(
    await resolveRelationSource(
      { name: "sample", location: path.join(escaped, "SKILL.md") },
      registry,
    ),
  ).toBeUndefined();
  await fs.unlink(path.join(collection, "sample"));
  expect(await resolveRelationSource(external, registry)).toBeUndefined();
});

it("rejects unsafe paths, noncanonical keys and ambiguous registry bindings", () => {
  const valid: RelationSourceRegistry = {
    version: 1,
    sources: [{ id: "github:owner/repo", root, skills: bindings("sample") }],
  };
  expect(validateRelationSources(valid)).toEqual(valid);
  for (const source_path of [
    "../sample/SKILL.md",
    "/sample/SKILL.md",
    "sample/../SKILL.md",
    "sample\\SKILL.md",
    "sample/README.md",
    "sample//SKILL.md",
  ]) {
    expect(() =>
      validateRelationSources({
        ...valid,
        sources: [
          {
            ...valid.sources[0],
            skills: { sample: { name: "sample", source_path } },
          },
        ],
      }),
    ).toThrow();
  }
  for (const sources of [
    [valid.sources[0], valid.sources[0]],
    [{ ...valid.sources[0], root: "relative" }],
    [{ ...valid.sources[0], skills: { SAMPLE: bindings("sample").sample } }],
    [
      {
        ...valid.sources[0],
        skills: { ...bindings("sample"), other: bindings("sample").sample },
      },
    ],
  ]) {
    expect(() => validateRelationSources({ version: 1, sources })).toThrow();
  }
});

it("rejects physically ambiguous source aliases instead of selecting one", async () => {
  const current = await skill(
    path.join(root, "collection", "sample"),
    "sample",
  );
  const alias = path.join(root, "alias");
  await fs.symlink(path.join(root, "collection"), alias);
  const registry: RelationSourceRegistry = {
    version: 1,
    sources: [
      {
        id: "github:owner/one",
        root: path.join(root, "collection"),
        skills: bindings("sample"),
      },
      { id: "github:owner/two", root: alias, skills: bindings("sample") },
    ],
  };
  expect(await resolveRelationSource(current, registry)).toBeUndefined();
});

it("preserves corrupt managed state and refuses registry symlinks", async () => {
  const collection = path.join(root, "collection");
  await skill(path.join(collection, "sample"), "sample");
  const file = relationSourcesPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "corrupt registry");
  expect(readRelationSources(root)).toBeUndefined();
  await expect(
    registerRelationSource(root, {
      root: collection,
      skills: bindings("sample"),
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("corrupt registry");
  await fs.unlink(file);
  const external = path.join(root, "external.json");
  const raw = JSON.stringify({ version: 1, sources: [] });
  await fs.writeFile(external, raw);
  await fs.symlink(external, file);
  expect(readRelationSources(root)).toBeUndefined();
  await expect(
    registerRelationSource(root, {
      root: collection,
      skills: bindings("sample"),
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(external, "utf8")).toBe(raw);
});

it("auto-registers new skills under known roots while preserving existing sources and symlinked bindings", async () => {
  const workshopRoot = path.join(root, "workshop");
  const personalRoot = path.join(root, "personal");
  const sharedRoot = path.join(root, "shared");
  const externalRepo = path.join(root, "omni-repo");
  const outsideRoot = path.join(root, "outside");

  const existingWorkshop = await skill(
    path.join(workshopRoot, "existing-ws"),
    "existing-ws",
  );
  const newWorkshop = await skill(path.join(workshopRoot, "new-ws"), "new-ws");
  const missingFrontmatter = path.join(workshopRoot, "no-name", "SKILL.md");
  await fs.mkdir(path.dirname(missingFrontmatter), { recursive: true });
  await fs.writeFile(
    missingFrontmatter,
    "Plain markdown without frontmatter\n",
  );

  const orcaSkill = await skill(path.join(personalRoot, "orca"), "orca");
  const localPersonal = await skill(
    path.join(personalRoot, "local-tool"),
    "local-tool",
  );

  const omniSkill = await skill(
    path.join(externalRepo, "skills", "k8s"),
    "k8s",
  );
  const anthologyTarget = await skill(
    path.join(root, "anthology", "ponytail"),
    "ponytail",
  );
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.symlink(
    path.join(externalRepo, "skills"),
    path.join(sharedRoot, "omni-skills"),
  );
  await fs.symlink(
    path.dirname(anthologyTarget.location),
    path.join(sharedRoot, "ponytail"),
  );
  const outsideSkill = await skill(path.join(outsideRoot, "rogue"), "rogue");

  const workshopSource = await registerRelationSource(root, {
    root: workshopRoot,
    label: "main workshop",
    skills: bindings("existing-ws"),
  });
  await registerRelationSource(root, {
    id: "github:stablyai/orca",
    root: personalRoot,
    label: "skills CLI recorded origin",
    skills: bindings("orca"),
  });
  await registerRelationSource(root, {
    id: "github:wei840222/omni-skills",
    root: externalRepo,
    label: "omni-skills",
    skills: { k8s: { name: "k8s", source_path: "skills/k8s/SKILL.md" } },
  });

  const roots = [
    { path: workshopRoot, source: "workshop" as const },
    { path: personalRoot, source: "personal-agent" as const },
    { path: sharedRoot, source: "shared" as const },
  ];
  const visible = [
    existingWorkshop,
    newWorkshop,
    { name: "no-name", location: missingFrontmatter },
    orcaSkill,
    localPersonal,
    {
      name: "k8s",
      location: path.join(sharedRoot, "omni-skills", "k8s", "SKILL.md"),
    },
    {
      name: "ponytail",
      location: path.join(sharedRoot, "ponytail", "SKILL.md"),
    },
    outsideSkill,
  ];

  const first = await ensureKnownRelationSources({
    dataRoot: root,
    skills: visible,
    roots,
  });
  expect(first).toEqual({
    registeredCount: 3,
    createdSourceIds: [
      expect.stringMatching(/^local:[a-f0-9-]{36}$/),
      expect.stringMatching(/^local:[a-f0-9-]{36}$/),
    ],
  });

  const registry = readRelationSources(root)!;
  expect((await resolveRelationSource(newWorkshop, registry))?.id).toBe(
    `${workshopSource.id}:new-ws`,
  );
  expect((await resolveRelationSource(existingWorkshop, registry))?.id).toBe(
    `${workshopSource.id}:existing-ws`,
  );
  expect((await resolveRelationSource(orcaSkill, registry))?.id).toBe(
    "github:stablyai/orca:orca",
  );
  expect(
    (await resolveRelationSource(localPersonal, registry))?.source_id,
  ).toMatch(/^local:[a-f0-9-]{36}$/);
  expect(
    (
      await resolveRelationSource(
        {
          name: "k8s",
          location: path.join(sharedRoot, "omni-skills", "k8s", "SKILL.md"),
        },
        registry,
      )
    )?.id,
  ).toBe("github:wei840222/omni-skills:k8s");
  expect((await resolveRelationSource(omniSkill, registry))?.id).toBe(
    "github:wei840222/omni-skills:k8s",
  );
  expect(
    (
      await resolveRelationSource(
        {
          name: "ponytail",
          location: path.join(sharedRoot, "ponytail", "SKILL.md"),
        },
        registry,
      )
    )?.skill_key,
  ).toBe("ponytail");
  expect(await resolveRelationSource(outsideSkill, registry)).toBeUndefined();
  expect(
    await resolveRelationSource(
      { name: "no-name", location: missingFrontmatter },
      registry,
    ),
  ).toBeUndefined();

  // Repeating the same sync is a no-op with zero new registrations.
  const second = await ensureKnownRelationSources({
    dataRoot: root,
    skills: visible,
    roots,
  });
  expect(second).toEqual({ registeredCount: 0, createdSourceIds: [] });
});

it("serializes concurrent auto-registration and refuses corrupt or symlinked registries", async () => {
  const collection = path.join(root, "collection");
  const a = await skill(path.join(collection, "a"), "a");
  const b = await skill(path.join(collection, "b"), "b");
  const roots = [{ path: collection, source: "workspace" as const }];

  const [first, second] = await Promise.all([
    ensureKnownRelationSources({ dataRoot: root, skills: [a], roots }),
    ensureKnownRelationSources({ dataRoot: root, skills: [b], roots }),
  ]);
  expect((first?.registeredCount ?? 0) + (second?.registeredCount ?? 0)).toBe(
    2,
  );
  const registry = readRelationSources(root)!;
  expect(registry.sources).toHaveLength(1);
  expect(Object.keys(registry.sources[0].skills).sort()).toEqual(["a", "b"]);

  const file = relationSourcesPath(root);
  await fs.writeFile(file, "corrupt");
  const c = await skill(path.join(collection, "c"), "c");
  expect(
    await ensureKnownRelationSources({ dataRoot: root, skills: [c], roots }),
  ).toBeUndefined();
  expect(await fs.readFile(file, "utf8")).toBe("corrupt");

  // No skill-relations directory is created when every skill is outside known roots.
  const cleanDataRoot = path.join(root, "clean-data");
  await fs.mkdir(cleanDataRoot, { recursive: true });
  const rogue = await skill(path.join(root, "rogue-root", "rogue"), "rogue");
  expect(
    await ensureKnownRelationSources({
      dataRoot: cleanDataRoot,
      skills: [rogue],
      roots,
    }),
  ).toEqual({ registeredCount: 0, createdSourceIds: [] });
  expect(await fs.readdir(cleanDataRoot)).toEqual([]);
});
