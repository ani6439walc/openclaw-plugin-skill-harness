import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOntologyImport,
  preflightOntologyImport,
  runOntologyImportCli,
} from "./relation-ontology.js";
import {
  readRelationGraph,
  relationGraphPath,
  resolveRelationGraph,
  applyRelationReviewChanges,
} from "./relation-graph.js";
import {
  registerRelationSource,
  relationSourcesPath,
} from "./relation-sources.js";

const roots: string[] = [];
const sourceId = "github:example/catalog";
const schema = `version: 2
identity:
  format: "<provider>:<repository>:<skill>"
sources:
  ${sourceId}:
    skills: skills/*/SKILL.md
types:
  Skill:
    required: [name, source_path]
    properties:
      name: string
      source_path: string
relations:
  related: &skill_relation
    from_types: [Skill]
    to_types: [Skill]
    required: [reason]
    properties:
      reason: string
  depends_on: *skill_relation
  composes_with: *skill_relation
  similar_to: *skill_relation
  conflicts_with: *skill_relation
  specializes: *skill_relation
`;
const encode = (records: unknown[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
function node(key: string, changes: Record<string, unknown> = {}) {
  return {
    op: "create",
    entity: {
      id: `${sourceId}:${key}`,
      type: "Skill",
      properties: {
        name: key,
        source_path: `skills/${key}/SKILL.md`,
      },
      ...changes,
    },
  };
}
function relation(changes: Record<string, unknown> = {}) {
  return {
    op: "relate",
    from: `${sourceId}:a`,
    rel: "composes_with",
    to: `${sourceId}:b`,
    properties: { reason: "Original author reason <&>" },
    ...changes,
  };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-import-"));
  roots.push(root);
  const catalog = path.join(root, "catalog");
  const dataRoot = path.join(root, "stage");
  const graphFile = path.join(catalog, "ontology/graph.jsonl");
  const schemaFile = path.join(catalog, "ontology/schema.yaml");
  const skills = Object.fromEntries(
    ["a", "b", "isolated"].map((key) => [
      key,
      { name: key, source_path: `skills/${key}/SKILL.md` },
    ]),
  );
  for (const [key, binding] of Object.entries(skills)) {
    const file = path.join(catalog, binding.source_path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `---\nname: ${key}\n---\n${key} body\n`);
  }
  await fs.mkdir(path.dirname(graphFile), { recursive: true });
  await fs.writeFile(schemaFile, schema);
  const records = [node("a"), node("b"), node("isolated"), relation()];
  await fs.writeFile(graphFile, encode(records));
  await registerRelationSource(dataRoot, {
    id: sourceId,
    root: catalog,
    skills,
  });
  return {
    root,
    catalog,
    dataRoot,
    graphFile,
    schemaFile,
    sourceId,
    skills,
    records,
  };
}
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ontology relation import", () => {
  it.each(["update", "delete"] as const)(
    "refuses ordinary snapshot reimport after Review %s, including deleted-edge history",
    async (operation) => {
      const input = await fixture();
      const plan = await preflightOntologyImport(input);
      await applyOntologyImport(input.dataRoot, plan);
      const expected = (await readRelationGraph(input.dataRoot))!.relations[0];
      const [from, to] = [
        plan.identities.find((identity) => identity.id === expected.from)!,
        plan.identities.find((identity) => identity.id === expected.to)!,
      ];
      await applyRelationReviewChanges(
        input.dataRoot,
        [
          {
            operation,
            from,
            to,
            expected,
            ...(operation === "update"
              ? { type: "related" as const, reason: "Review revision" }
              : {}),
            rationale: "Current endpoint bodies require correction.",
            evidence: [from, to].map((identity) => ({
              skillId: identity.id,
              filePath: "SKILL.md",
              startLine: 4,
              endLine: 4,
              quote: `${identity.name} body`,
              fileDigest: "a".repeat(64),
            })),
          },
        ],
        {
          batchId: "batch",
          eventId: "event",
          agentId: "main",
          assertCurrent: async () => {},
        },
      );
      const before = await fs.readFile(relationGraphPath(input.dataRoot));
      await expect(preflightOntologyImport(input)).rejects.toThrow(
        "reviewed-destination-history",
      );
      await expect(applyOntologyImport(input.dataRoot, plan)).rejects.toThrow();
      expect(await fs.readFile(relationGraphPath(input.dataRoot))).toEqual(
        before,
      );
    },
  );
  it("replays create/update/delete/relate/unrelate before validating the active catalog", async () => {
    const input = await fixture();
    await fs.writeFile(
      input.graphFile,
      encode([
        ...input.records.slice(0, 3),
        node("retired"),
        {
          op: "update",
          id: `${sourceId}:a`,
          properties: { description: "Historical extra property" },
        },
        relation({
          rel: "related",
          properties: { reason: "Superseded reason" },
        }),
        {
          op: "unrelate",
          from: `${sourceId}:a`,
          rel: "related",
          to: `${sourceId}:b`,
        },
        { op: "delete", id: `${sourceId}:retired` },
        relation(),
      ]),
    );
    const plan = await preflightOntologyImport(input);
    expect(plan.identities).toHaveLength(3);
    expect(plan.relations).toHaveLength(1);
    expect(plan.relations[0].reason).toBe("Original author reason <&>");
  });

  it("preflights without writes and retains every skill, including isolated nodes", async () => {
    const input = await fixture();
    const registryBefore = await fs.readFile(
      relationSourcesPath(input.dataRoot),
    );
    const sourceBefore = await fs.readFile(input.graphFile);
    const before = await fs.readdir(
      path.dirname(relationGraphPath(input.dataRoot)),
    );
    const plan = await preflightOntologyImport(input);
    expect(plan.version).toBe(2);
    expect(plan.identities.map((identity) => identity.id)).toEqual([
      `${sourceId}:a`,
      `${sourceId}:b`,
      `${sourceId}:isolated`,
    ]);
    expect(plan.relations).toHaveLength(1);
    expect(plan.relations[0]).toMatchObject({
      reason: "Original author reason <&>",
      type: "composes_with",
      sourceGraphDigest: plan.sourceDigest,
    });
    expect(plan.relations[0]).not.toHaveProperty("scores");
    expect(plan.expectedGraphDigest).toBeNull();
    expect(
      await fs.readdir(path.dirname(relationGraphPath(input.dataRoot))),
    ).toEqual(before);
    expect(await fs.readFile(relationSourcesPath(input.dataRoot))).toEqual(
      registryBefore,
    );
    expect(await fs.readFile(input.graphFile)).toEqual(sourceBefore);
  });

  it("publishes a validated v2 snapshot without model scores or verification status", async () => {
    const input = await fixture();
    const plan = await preflightOntologyImport(input);
    expect(await applyOntologyImport(input.dataRoot, plan)).toMatchObject({
      nodes: 3,
      relations: 1,
    });
    const graph = await readRelationGraph(input.dataRoot);
    expect(graph?.entities.size).toBe(3);
    expect(graph?.relations[0].properties).toMatchObject({
      formatVersion: 2,
      reason: "Original author reason <&>",
      fromFingerprint: plan.identities[0].fingerprint,
      toFingerprint: plan.identities[1].fingerprint,
    });
    const raw = await fs.readFile(relationGraphPath(input.dataRoot), "utf8");
    expect(raw).not.toContain("verification_status");
    expect(raw).not.toContain('"scores"');
    expect(
      await resolveRelationGraph(
        input.dataRoot,
        plan.identities.map((identity) => ({
          name: identity.name,
          location: path.join(identity.source, "SKILL.md"),
        })),
      ),
    ).toHaveProperty("size", 2);
  });

  it("rebuilds after explicit removal of an upstream binding while preserving source identity and retained author relations", async () => {
    const input = await fixture();
    const retained = relation({
      rel: "related",
      to: `${sourceId}:isolated`,
      properties: { reason: "Retained author relationship" },
    });
    await fs.writeFile(input.graphFile, encode([...input.records, retained]));
    expect(
      await applyOntologyImport(
        input.dataRoot,
        await preflightOntologyImport(input),
      ),
    ).toMatchObject({ nodes: 3, relations: 2 });
    const before = await fs.readFile(relationGraphPath(input.dataRoot));

    await fs.writeFile(
      input.graphFile,
      encode([node("a"), node("isolated"), retained]),
    );
    await fs.rm(path.join(input.catalog, "skills/b"), { recursive: true });
    await expect(preflightOntologyImport(input)).rejects.toThrow();
    expect(await fs.readFile(relationGraphPath(input.dataRoot))).toEqual(
      before,
    );

    const updated = await registerRelationSource(input.dataRoot, {
      id: sourceId,
      root: input.catalog,
      skills: { a: input.skills.a, isolated: input.skills.isolated },
      removeKeys: ["b"],
    });
    expect(updated.id).toBe(sourceId);
    expect(Object.keys(updated.skills).sort()).toEqual(["a", "isolated"]);
    const plan = await preflightOntologyImport(input);
    expect(plan.identities.map((entry) => entry.id)).toEqual([
      `${sourceId}:a`,
      `${sourceId}:isolated`,
    ]);
    expect(await applyOntologyImport(input.dataRoot, plan)).toMatchObject({
      nodes: 2,
      relations: 1,
    });
    const graph = await readRelationGraph(input.dataRoot);
    expect(graph?.entities.has(`${sourceId}:b`)).toBe(false);
    expect(graph?.relations).toMatchObject([
      {
        from: `${sourceId}:a`,
        rel: "related",
        to: `${sourceId}:isolated`,
        properties: { reason: "Retained author relationship" },
      },
    ]);
  });

  it("includes explicitly registered additional local sources as isolated nodes and preserves same-name origins", async () => {
    const input = await fixture();
    const localRoot = path.join(input.root, "workshop");
    await fs.mkdir(path.join(localRoot, "a"), { recursive: true });
    await fs.writeFile(
      path.join(localRoot, "a/SKILL.md"),
      "---\nname: a\n---\nLocal procedure\n",
    );
    const local = await registerRelationSource(input.dataRoot, {
      root: localRoot,
      skills: { a: { name: "a", source_path: "a/SKILL.md" } },
    });
    const scoped = { ...input, additionalSourceIds: [local.id] };
    const plan = await preflightOntologyImport(scoped);
    expect(plan.additionalSourceIds).toEqual([local.id]);
    expect(plan.identities.map((entry) => entry.id)).toContain(`${local.id}:a`);
    expect(plan.identities.filter((entry) => entry.name === "a")).toHaveLength(
      2,
    );
    expect(plan.relations).toHaveLength(1);
    expect(await applyOntologyImport(input.dataRoot, plan)).toMatchObject({
      nodes: 4,
      relations: 1,
    });
    expect((await preflightOntologyImport(scoped)).identities).toHaveLength(4);
    const file = relationGraphPath(input.dataRoot);
    await fs.appendFile(
      file,
      encode([
        {
          op: "relate",
          from: `${local.id}:a`,
          rel: "related",
          to: `${sourceId}:a`,
          properties: {
            reason: "Local evidence must survive",
            source: "author-import",
            formatVersion: 2,
          },
        },
      ]),
    );
    const before = await fs.readFile(file);
    await expect(preflightOntologyImport(scoped)).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("backs up the complete previous publication and can restore the original hints", async () => {
    const input = await fixture();
    await applyOntologyImport(
      input.dataRoot,
      await preflightOntologyImport(input),
    );
    const graph = relationGraphPath(input.dataRoot);
    const schemaFile = path.join(path.dirname(graph), "schema.yaml");
    const sourceFile = relationSourcesPath(input.dataRoot);
    const original = await Promise.all(
      [graph, schemaFile, sourceFile].map((file) => fs.readFile(file)),
    );
    await fs.writeFile(
      input.graphFile,
      encode([
        ...input.records.slice(0, 3),
        relation({
          properties: {
            reason: "Revised source reason",
            scores: { invalid: 99 },
            verification_status: "verified",
          },
        }),
      ]),
    );
    const fresh = await preflightOntologyImport(input);
    const result = await applyOntologyImport(input.dataRoot, fresh);
    expect(result.backupPath).toBeDefined();
    const backups = ["graph.jsonl", "schema.yaml", "sources.json"].map((name) =>
      path.join(result.backupPath!, name),
    );
    expect(await Promise.all(backups.map((file) => fs.readFile(file)))).toEqual(
      original,
    );
    expect(
      (await readRelationGraph(input.dataRoot))?.relations[0].properties.reason,
    ).toBe("Revised source reason");
    for (const [index, file] of [graph, schemaFile, sourceFile].entries())
      await fs.copyFile(backups[index], file);
    expect(
      (await readRelationGraph(input.dataRoot))?.relations[0].properties.reason,
    ).toBe("Original author reason <&>");
    expect(
      await Promise.all(
        [graph, schemaFile, sourceFile].map((file) => fs.readFile(file)),
      ),
    ).toEqual(original);
  });

  it("supports linked skill directories while rejecting an escaped main file", async () => {
    const input = await fixture();
    const original = path.join(input.catalog, "skills/a");
    const target = path.join(input.root, "linked-a");
    await fs.rename(original, target);
    await fs.symlink(target, original);
    const plan = await preflightOntologyImport(input);
    expect(plan.identities[0]).toMatchObject({
      id: `${sourceId}:a`,
      source: target,
    });
    await fs.unlink(path.join(target, "SKILL.md"));
    await fs.symlink(
      path.join(input.catalog, "skills/b/SKILL.md"),
      path.join(target, "SKILL.md"),
    );
    await expect(preflightOntologyImport(input)).rejects.toThrow();
  });

  it("CLI saves private plans and prints aggregate-only preflight/apply output", async () => {
    const input = await fixture();
    const planFile = path.join(input.root, "private-plan.json");
    const args = [
      "--data-root",
      input.dataRoot,
      "--graph",
      input.graphFile,
      "--schema",
      input.schemaFile,
      "--source-id",
      input.sourceId,
    ];
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runOntologyImportCli(["preflight", ...args, "--output", planFile]);
      expect((await fs.stat(planFile)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(output.mock.calls[0][0])).toEqual({
        nodes: 3,
        relations: 1,
        sourceDigest: expect.any(String),
        sourcesDigest: expect.any(String),
        expectedGraphDigest: null,
      });
      await runOntologyImportCli(["apply", ...args, "--plan", planFile]);
      expect(JSON.parse(output.mock.calls[1][0])).toEqual({
        nodes: 3,
        relations: 1,
        graphDigest: expect.any(String),
        backupCreated: false,
      });
      expect(output.mock.calls.flat().join("\n")).not.toContain(input.root);
      expect(output.mock.calls.flat().join("\n")).not.toContain(
        "Original author reason",
      );
    } finally {
      output.mockRestore();
    }
  });

  it("does not overwrite authoritative inputs with a CLI preflight plan", async () => {
    const input = await fixture();
    const before = await fs.readFile(input.graphFile);
    await expect(
      runOntologyImportCli([
        "preflight",
        "--data-root",
        input.dataRoot,
        "--graph",
        input.graphFile,
        "--schema",
        input.schemaFile,
        "--source-id",
        input.sourceId,
        "--output",
        input.graphFile,
      ]),
    ).rejects.toThrow();
    expect(await fs.readFile(input.graphFile)).toEqual(before);
  });

  it("rejects CLI plan output through a parent symlink into any registered source root", async () => {
    const input = await fixture();
    const alias = path.join(input.root, "catalog-alias");
    await fs.symlink(input.catalog, alias);
    const output = path.join(alias, "new-private/plan.json");
    const before = await fs.readFile(input.graphFile);
    await expect(
      runOntologyImportCli([
        "preflight",
        "--data-root",
        input.dataRoot,
        "--graph",
        input.graphFile,
        "--schema",
        input.schemaFile,
        "--source-id",
        input.sourceId,
        "--output",
        output,
      ]),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(input.catalog, "new-private")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(input.graphFile)).toEqual(before);
  });

  it("protects the managed runtime schema from CLI plan output", async () => {
    const input = await fixture();
    const runtimeSchema = path.join(
      path.dirname(relationGraphPath(input.dataRoot)),
      "schema.yaml",
    );
    await fs.writeFile(runtimeSchema, "Prior runtime schema\n");
    await expect(
      runOntologyImportCli([
        "preflight",
        "--data-root",
        input.dataRoot,
        "--graph",
        input.graphFile,
        "--schema",
        input.schemaFile,
        "--source-id",
        input.sourceId,
        "--output",
        runtimeSchema,
      ]),
    ).rejects.toThrow();
    expect(await fs.readFile(runtimeSchema, "utf8")).toBe(
      "Prior runtime schema\n",
    );
  });

  it.each(["graph", "schema", "skill"] as const)(
    "rejects a changed source %s after preflight without touching destination bytes",
    async (kind) => {
      const input = await fixture();
      await applyOntologyImport(
        input.dataRoot,
        await preflightOntologyImport(input),
      );
      const plan = await preflightOntologyImport(input);
      const file =
        kind === "graph"
          ? input.graphFile
          : kind === "schema"
            ? input.schemaFile
            : path.join(input.catalog, "skills/a/SKILL.md");
      await fs.appendFile(file, "\n");
      const before = await fs.readFile(relationGraphPath(input.dataRoot));
      await expect(applyOntologyImport(input.dataRoot, plan)).rejects.toThrow();
      expect(await fs.readFile(relationGraphPath(input.dataRoot))).toEqual(
        before,
      );
    },
  );

  it("rejects registry rebinding and destination changes after preflight", async () => {
    const input = await fixture();
    const plan = await preflightOntologyImport(input);
    const moved = path.join(input.root, "moved");
    await fs.cp(input.catalog, moved, { recursive: true });
    await registerRelationSource(input.dataRoot, {
      id: sourceId,
      root: moved,
      skills: input.skills,
      rebind: true,
    });
    await expect(applyOntologyImport(input.dataRoot, plan)).rejects.toThrow();
    await expect(
      fs.stat(relationGraphPath(input.dataRoot)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = await preflightOntologyImport({
      ...input,
      graphFile: path.join(moved, "ontology/graph.jsonl"),
      schemaFile: path.join(moved, "ontology/schema.yaml"),
    });
    await fs.writeFile(relationGraphPath(input.dataRoot), "\n");
    await expect(applyOntologyImport(input.dataRoot, fresh)).rejects.toThrow();
    expect(await fs.readFile(relationGraphPath(input.dataRoot), "utf8")).toBe(
      "\n",
    );
  });

  it.each(["reason", "fingerprint", "identity"] as const)(
    "rejects a serialized plan with a modified %s",
    async (field) => {
      const input = await fixture();
      const plan = structuredClone(await preflightOntologyImport(input));
      if (field === "reason")
        plan.relations[0].reason = "Not the author reason";
      if (field === "fingerprint")
        plan.identities[0].fingerprint = "0".repeat(64);
      if (field === "identity") plan.identities[0].id = `${sourceId}:other`;
      await expect(applyOntologyImport(input.dataRoot, plan)).rejects.toThrow();
      await expect(
        fs.stat(relationGraphPath(input.dataRoot)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    ["duplicate-create", [node("a")]],
    ["unknown-type", [node("other", { type: "Person" })]],
    ["dangling", [relation({ to: `${sourceId}:missing` })]],
    ["self", [relation({ to: `${sourceId}:a` })]],
    ["duplicate-pair", [relation({ rel: "similar_to" })]],
    ["unknown-label", [relation({ rel: "requires" })]],
    [
      "blank-reason",
      [
        relation({
          from: `${sourceId}:b`,
          to: `${sourceId}:a`,
          properties: { reason: " " },
        }),
      ],
    ],
    ["noncanonical-id", [node("A")]],
    [
      "unsafe-path",
      [
        node("other", {
          properties: { name: "other", source_path: "../outside/SKILL.md" },
        }),
      ],
    ],
  ])("rejects invalid graph invariant: %s", async (_, extra) => {
    const input = await fixture();
    await fs.writeFile(input.graphFile, encode([...input.records, ...extra]));
    await expect(preflightOntologyImport(input)).rejects.toThrow();
  });

  it("rejects missing bindings, incomplete source catalogs and incompatible schema", async () => {
    const input = await fixture();
    await fs.writeFile(
      input.graphFile,
      encode(
        input.records.filter(
          (record) =>
            !(
              "entity" in record && record.entity.properties.name === "isolated"
            ),
        ),
      ),
    );
    await expect(preflightOntologyImport(input)).rejects.toThrow();
    await fs.writeFile(input.graphFile, encode(input.records));
    await fs.writeFile(
      input.schemaFile,
      schema.replace("version: 2", "version: 1"),
    );
    await expect(preflightOntologyImport(input)).rejects.toThrow();
    await fs.writeFile(input.schemaFile, schema);
    await fs.unlink(relationSourcesPath(input.dataRoot));
    await expect(preflightOntologyImport(input)).rejects.toThrow();
  });

  it("does not replace unrelated source nodes or foreign-owned destination relations", async () => {
    const input = await fixture();
    await fs.writeFile(
      relationGraphPath(input.dataRoot),
      encode([
        {
          op: "create",
          entity: {
            id: "github:other/catalog:a",
            type: "Skill",
            properties: {
              name: "a",
              source_id: "github:other/catalog",
              skill_key: "a",
              source_path: "skills/a/SKILL.md",
              formatVersion: 2,
            },
          },
        },
      ]),
    );
    const unrelated = await fs.readFile(relationGraphPath(input.dataRoot));
    await expect(preflightOntologyImport(input)).rejects.toThrow();
    expect(await fs.readFile(relationGraphPath(input.dataRoot))).toEqual(
      unrelated,
    );
    await fs.unlink(relationGraphPath(input.dataRoot));
    await applyOntologyImport(
      input.dataRoot,
      await preflightOntologyImport(input),
    );
    const foreign = encode(
      (await fs.readFile(relationGraphPath(input.dataRoot), "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => {
          const record = JSON.parse(line);
          if (record.op === "relate") record.properties.source = "manual";
          return record;
        }),
    );
    await fs.writeFile(relationGraphPath(input.dataRoot), foreign);
    await expect(preflightOntologyImport(input)).rejects.toThrow();
    expect(await fs.readFile(relationGraphPath(input.dataRoot), "utf8")).toBe(
      foreign,
    );
  });
});
