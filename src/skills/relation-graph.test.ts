import matter from "gray-matter";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  appendImportedRelations,
  readSkillIdentity,
  resolveRelationGraph,
  replayRelationGraph,
  readRelationGraph,
  relationGraphPath,
  relationSchema,
} from "./relation-graph.js";
import type { ImportedRelation } from "./relation-graph.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relations-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function skill(
  name: string,
  metadata = "",
): Promise<{ name: string; location: string }> {
  const location = path.join(root, name, "SKILL.md");
  await fs.mkdir(path.dirname(location), { recursive: true });
  await fs.writeFile(
    location,
    `---\nname: ${name}\ndescription: ${name} skill\n${metadata}---\n# ${name}\nDo the work.\n`,
  );
  return { name, location };
}
async function fixture() {
  const a = await skill("a", "metadata:\n  related-skills:\n    b: helpful\n"),
    b = await skill("b");
  const from = (await readSkillIdentity(a))!,
    to = (await readSkillIdentity(b))!;
  const edge: ImportedRelation = {
    from,
    to,
    type: "composes_with",
    reason: "helpful",
  };
  return { a, b, edge };
}
it("imports idempotently, updates with history and backup, and never clears absent imports", async () => {
  const { edge } = await fixture();
  expect(await appendImportedRelations(root, [edge])).toMatchObject({
    added: 1,
    updated: 0,
  });
  const original = await fs.readFile(relationGraphPath(root), "utf8");
  expect(await appendImportedRelations(root, [edge])).toMatchObject({
    unchanged: 1,
  });
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(original);
  const changed = await appendImportedRelations(root, [
    { ...edge, type: "related", reason: "revised" },
  ]);
  expect(changed.updated).toBe(1);
  expect(await fs.readFile(changed.backupPath!, "utf8")).toBe(original);
  const raw = await fs.readFile(relationGraphPath(root), "utf8");
  expect(raw.startsWith(original)).toBe(true);
  expect(replayRelationGraph(raw).relations).toHaveLength(1);
  await appendImportedRelations(root, []);
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(raw);
});
it("serializes concurrent imports without duplicate edges", async () => {
  const { edge } = await fixture();
  const results = await Promise.all([
    appendImportedRelations(root, [edge]),
    appendImportedRelations(root, [edge]),
  ]);
  expect(results.reduce((n, r) => n + r.added, 0)).toBe(1);
  expect((await readRelationGraph(root))?.relations).toHaveLength(1);
});
it("preserves foreign ownership and validates scores before publishing", async () => {
  const { edge } = await fixture();
  await appendImportedRelations(root, [edge]);
  const file = relationGraphPath(root);
  const raw = (await fs.readFile(file, "utf8")).replaceAll(
    '"author-import"',
    '"manual"',
  );
  await fs.writeFile(file, raw);
  expect((await appendImportedRelations(root, [edge])).conflicts).toHaveLength(
    1,
  );
  expect(await fs.readFile(file, "utf8")).toBe(raw);
  await expect(
    appendImportedRelations(root, [
      {
        ...edge,
        scores: {
          depends_on: NaN,
          composes_with: 0,
          similar_to: 0,
          conflicts_with: 0,
          specializes: 0,
        },
      },
    ]),
  ).rejects.toThrow("Invalid imported");
  expect(await fs.readFile(file, "utf8")).toBe(raw);
});
it("keeps identity after metadata removal and disables changed, hidden or replaced winners", async () => {
  const { a, b, edge } = await fixture();
  await appendImportedRelations(root, [edge]);
  expect((await resolveRelationGraph(root, [a, b])).get("a")).toEqual([
    {
      name: "b",
      reason: "helpful",
      direction: "current-to-related",
      relation_type: "composes_with",
      verification_status: "unverified",
      source: "author-import",
    },
  ]);
  expect(
    (await resolveRelationGraph(root, [a, b])).get("b")?.[0].direction,
  ).toBe("related-to-current");
  await skill("a");
  expect(await readSkillIdentity(a)).toEqual(edge.from);
  expect((await resolveRelationGraph(root, [a, b])).size).toBe(2);
  expect((await resolveRelationGraph(root, [a])).size).toBe(0);
  const other = path.join(root, "other", "SKILL.md");
  await fs.mkdir(path.dirname(other));
  await fs.copyFile(a.location, other);
  expect(
    (await resolveRelationGraph(root, [{ name: "a", location: other }, b]))
      .size,
  ).toBe(0);
  await fs.appendFile(a.location, "changed\n");
  expect((await resolveRelationGraph(root, [a, b])).size).toBe(0);
});
it("supports skill-root symlinks but rejects escaped main files", async () => {
  const { a } = await fixture();
  const alias = path.join(root, "alias");
  await fs.symlink(path.dirname(a.location), alias);
  expect(
    await readSkillIdentity({
      name: "a",
      location: path.join(alias, "SKILL.md"),
    }),
  ).toEqual(await readSkillIdentity(a));
  const escape = path.join(root, "escape");
  await fs.mkdir(escape);
  await fs.symlink(a.location, path.join(escape, "SKILL.md"));
  expect(
    await readSkillIdentity({
      name: "a",
      location: path.join(escape, "SKILL.md"),
    }),
  ).toBeUndefined();
});
it("refreshes after corruption or a missing graph without using stale cached edges", async () => {
  const { a, b, edge } = await fixture();
  expect(await readRelationGraph(root)).toBeUndefined();
  await appendImportedRelations(root, [edge]);
  const file = relationGraphPath(root),
    raw = await fs.readFile(file, "utf8");
  expect((await resolveRelationGraph(root, [a, b])).size).toBe(2);
  await fs.appendFile(file, '{"op":');
  expect((await resolveRelationGraph(root, [a, b])).size).toBe(0);
  await fs.writeFile(file, raw);
  expect((await resolveRelationGraph(root, [a, b])).size).toBe(2);
  await fs.appendFile(file, '{"op":"mystery"}\n');
  expect(await readRelationGraph(root)).toBeUndefined();
  await fs.unlink(file);
  expect(await readRelationGraph(root)).toBeUndefined();
});
it("replays ontology shallow updates, duplicate edges, deletion and unrelate exactly", () => {
  const ops = [
    {
      op: "create",
      entity: {
        id: "a",
        type: "Skill",
        properties: { nested: { a: 1, b: 2 }, keep: 1 },
      },
    },
    {
      op: "update",
      id: "a",
      properties: { nested: { a: 3 } },
      timestamp: "now",
    },
    { op: "relate", from: "a", rel: "related", to: "b" },
    { op: "relate", from: "a", rel: "related", to: "b" },
    { op: "delete", id: "a" },
  ];
  const encode = (value: unknown[]) =>
    value.map((v) => JSON.stringify(v)).join("\n");
  expect(
    replayRelationGraph(encode(ops.slice(0, 2))).entities.get("a"),
  ).toMatchObject({
    properties: { nested: { a: 3 }, keep: 1 },
    updated: "now",
  });
  expect(replayRelationGraph(encode(ops))).toMatchObject({
    entities: new Map(),
    relations: [
      { from: "a", rel: "related", to: "b", properties: {} },
      { from: "a", rel: "related", to: "b", properties: {} },
    ],
  });
  expect(
    replayRelationGraph(
      encode([...ops, { op: "unrelate", from: "a", rel: "related", to: "b" }]),
    ).relations,
  ).toEqual([]);
});
it("round trips with pinned upstream ontology 1.0.4 including CLI query and validation", async () => {
  const upstream = fileURLToPath(
    new URL("./fixtures/ontology-1.0.4/ontology.py", import.meta.url),
  );
  expect(
    createHash("sha256")
      .update(await fs.readFile(upstream))
      .digest("hex"),
  ).toBe("25e10809ab4f809f2fd3b475989a882e6fcdd9127655ec40fccf44d10f0c0491");
  const { edge } = await fixture();
  await appendImportedRelations(root, [edge]);
  const file = relationGraphPath(root),
    schema = path.join(path.dirname(file), "schema.yaml");
  const script = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('ontology',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\np=sys.argv[2]\n# Parse YAML with the project's existing parser; no Python dependency.\nm.load_schema=lambda _: json.loads(sys.argv[4])\ne,r=m.load_graph(p)\nassert len(e)==2 and len(r)==1 and r[0]['properties']['reason']=='helpful'\nassert m.validate_graph(p,sys.argv[3])==[]\na,b=list(e)\nm.update_entity(a,{'extra':True},p)\nm.create_relation(a,'related',b,{},p)\nm.create_relation(a,'related',b,{},p)\nm.append_op(p,{'op':'unrelate','from':a,'rel':'related','to':b})\nm.delete_entity(b,p)\ne,r=m.load_graph(p)\nprint(json.dumps({'entities':e,'relations':r}))`;
  const output = JSON.parse(
    execFileSync(
      "python3",
      [
        "-S",
        "-B",
        "-c",
        script,
        upstream,
        file,
        schema,
        JSON.stringify(
          matter(`---\n${await fs.readFile(schema, "utf8")}---\n`).data,
        ),
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  );
  const replay = replayRelationGraph(await fs.readFile(file, "utf8"));
  expect(Object.fromEntries(replay.entities)).toEqual(output.entities);
  expect(replay.relations).toEqual(output.relations);
  const args = ["--graph", file];
  for (const command of [
    ["list", "--type", "Skill"],
    ["query", "--type", "Skill", "--where", JSON.stringify({ name: "a" })],
    ["related", "--id", edge.from.id],
  ]) {
    expect(() =>
      JSON.parse(
        execFileSync("python3", ["-B", upstream, ...command, ...args], {
          cwd: root,
          encoding: "utf8",
        }),
      ),
    ).not.toThrow();
  }
  expect(relationSchema).not.toContain("acyclic");
});

it("never exposes dangling endpoints, unsupported versions or invalid score records", async () => {
  const { a, b, edge } = await fixture();
  await appendImportedRelations(root, [edge]);
  const file = relationGraphPath(root),
    original = await fs.readFile(file, "utf8");
  const operations: Record<string, unknown>[] = [
    { op: "delete", id: edge.to.id },
    { op: "update", id: edge.from.id, properties: { formatVersion: 2 } },
  ];
  for (const operation of operations) {
    await fs.writeFile(file, original + JSON.stringify(operation) + "\n");
    expect((await resolveRelationGraph(root, [a, b])).size).toBe(0);
  }
  for (const changes of [
    { formatVersion: 2 },
    {
      scores: {
        depends_on: 2,
        composes_with: 0,
        similar_to: 0,
        conflicts_with: 0,
        specializes: 0,
      },
    },
  ]) {
    const rows = original
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const relation = rows.find((row) => row.op === "relate");
    Object.assign(relation.properties, changes);
    await fs.writeFile(
      file,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    expect((await resolveRelationGraph(root, [a, b])).size).toBe(0);
  }
});

it("keeps old version edges inactive when a new version is imported", async () => {
  const { a, b, edge } = await fixture();
  await appendImportedRelations(root, [edge]);
  await fs.appendFile(a.location, "new version\n");
  const from = (await readSkillIdentity(a))!;
  expect(from.id).not.toBe(edge.from.id);
  await appendImportedRelations(root, [
    { ...edge, from, reason: "new reason" },
  ]);
  expect((await readRelationGraph(root))?.relations).toHaveLength(2);
  expect((await resolveRelationGraph(root, [a, b])).get("a")).toMatchObject([
    { reason: "new reason" },
  ]);
});

it("does not lose distinct concurrent imports and preserves history on failed publication", async () => {
  const { edge } = await fixture();
  const c = await skill("c"),
    to = (await readSkillIdentity(c))!;
  await Promise.all([
    appendImportedRelations(root, [edge]),
    appendImportedRelations(root, [{ ...edge, to }]),
  ]);
  expect((await readRelationGraph(root))?.relations).toHaveLength(2);
  const file = relationGraphPath(root),
    before = await fs.readFile(file, "utf8");
  const originalRename = fs.rename.bind(fs);
  const mock = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === file) throw new Error("publication failed");
    await originalRename(from, to);
  });
  try {
    await expect(
      appendImportedRelations(root, [{ ...edge, reason: "changed" }]),
    ).rejects.toThrow("publication failed");
  } finally {
    mock.mockRestore();
  }
  expect(await fs.readFile(file, "utf8")).toBe(before);
  expect(
    (await fs.readdir(path.dirname(file))).some(
      (name) => name.includes(".tmp-") || name.endsWith(".lock"),
    ),
  ).toBe(false);
});
