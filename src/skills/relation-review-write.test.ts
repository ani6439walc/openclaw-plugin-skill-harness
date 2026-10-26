import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendImportedRelations,
  applyRelationReviewChanges,
  readRelationGraph,
  readSkillIdentity,
  relationGraphPath,
  replayRelationGraph,
  resolveRelationGraph,
} from "./relation-graph.js";
import type {
  GraphRelation,
  RelationReviewChange,
  RelationReviewEvidence,
  SkillIdentity,
} from "./relation-graph.js";
import { registerRelationSource } from "./relation-sources.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "relation-review-write-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const source = path.join(root, "source");
  const skills = await Promise.all(
    ["a", "b", "c", "d"].map(async (name) => {
      const location = path.join(source, name, "SKILL.md");
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(location, `---\nname: ${name}\n---\n${name} body\n`);
      return { name, location };
    }),
  );
  const registered = await registerRelationSource(root, {
    id: "github:example/skills",
    root: source,
    skills: Object.fromEntries(
      skills.map(({ name }) => [
        name,
        { name, source_path: `${name}/SKILL.md` },
      ]),
    ),
  });
  const registry = { version: 1 as const, sources: [registered] };
  const identities = (await Promise.all(
    skills.map((skill) => readSkillIdentity(skill, registry)),
  )) as SkillIdentity[];
  await appendImportedRelations(root, [
    {
      from: identities[0],
      to: identities[1],
      type: "related",
      reason: "author reason",
      sourceGraphDigest: "f".repeat(64),
    },
  ]);
  const expected = (await readRelationGraph(root))!.relations[0];
  return { skills, identities, expected };
}

function evidence(
  identities: readonly SkillIdentity[],
): RelationReviewEvidence[] {
  return identities.map((identity) => ({
    skillId: identity.id,
    filePath: "SKILL.md",
    startLine: 4,
    endLine: 4,
    quote: `${identity.name} body`,
    fileDigest: "a".repeat(64),
  }));
}
function change(
  from: SkillIdentity,
  to: SkillIdentity,
  expected: GraphRelation | null,
): RelationReviewChange {
  return {
    operation: expected ? "update" : "create",
    from,
    to,
    expected,
    type: "composes_with",
    reason: "Reviewed reason",
    rationale: "Both skill bodies describe composition.",
    evidence: evidence([from, to]),
  };
}
const options = (overrides = {}) => ({
  batchId: "batch-1",
  eventId: "event-1",
  agentId: "main",
  assertCurrent: async () => {},
  ...overrides,
});

it("atomically appends mixed CRUD with complete review provenance and preserves raw history", async () => {
  const {
    skills,
    identities: [a, b, c, d],
    expected,
  } = await fixture();
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  expect(
    await applyRelationReviewChanges(
      root,
      [change(a, b, expected), change(c, d, null)],
      options(),
    ),
  ).toEqual({ changed: 2, batchId: "batch-1" });
  const after = await fs.readFile(relationGraphPath(root), "utf8");
  expect(after.startsWith(before)).toBe(true);
  const appended = after
    .slice(before.length)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(appended.map((record) => record.op)).toEqual([
    "unrelate",
    "relate",
    "create",
    "create",
    "relate",
  ]);
  for (const record of appended.filter((record) =>
    ["relate", "unrelate"].includes(record.op),
  )) {
    expect(record.review).toMatchObject({
      batchId: "batch-1",
      eventId: "event-1",
      agentId: "main",
      operation: record.from === a.id ? "update" : "create",
      rationale: expect.any(String),
      evidence: expect.any(Array),
      timestamp: expect.any(String),
      previousRelation: record.from === a.id ? expected : null,
    });
  }
  const graph = replayRelationGraph(after);
  expect(graph.relations).toHaveLength(2);
  expect(graph.relations[0].properties).toMatchObject({
    sourceGraphDigest: "f".repeat(64),
    reason: "Reviewed reason",
  });
  expect(
    graph.relations.every((edge) => !Object.hasOwn(edge.properties, "source")),
  ).toBe(true);
  expect(
    (await resolveRelationGraph(root, skills)).get("a")?.[0],
  ).toMatchObject({ source: "review" });
  expect(after).not.toContain("verification_status");
});

it.each(["update", "delete"] as const)(
  "protects Review %s from ordinary imports, including tombstones after replay",
  async (operation) => {
    const {
      identities: [a, b],
      expected,
    } = await fixture();
    const reviewed = { ...change(a, b, expected), operation };
    if (operation === "delete") {
      delete reviewed.type;
      delete reviewed.reason;
    }
    await applyRelationReviewChanges(root, [reviewed], options());
    const before = await fs.readFile(relationGraphPath(root), "utf8");
    const imported = await appendImportedRelations(root, [
      { from: a, to: b, type: "related", reason: "author reason" },
    ]);
    expect(imported.conflicts).toEqual(["a -> b"]);
    expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
    expect((await readRelationGraph(root))!.relations).toHaveLength(
      operation === "delete" ? 0 : 1,
    );
  },
);

it("permits unrelated concurrent changes while rejecting target revision conflicts", async () => {
  const {
    identities: [a, b, c, d],
    expected,
  } = await fixture();
  await appendImportedRelations(root, [
    { from: c, to: d, type: "related", reason: "unrelated" },
  ]);
  await applyRelationReviewChanges(root, [change(a, b, expected)], options());
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(
    applyRelationReviewChanges(
      root,
      [change(a, b, expected)],
      options({ batchId: "batch-2", eventId: "event-2" }),
    ),
  ).rejects.toThrow("stale-relation");
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
  expect((await readRelationGraph(root))!.relations).toHaveLength(2);
});

it.each(["eventId", "batchId"])(
  "rejects repeated %s without a second publication",
  async (key) => {
    const {
      identities: [a, b, c, d],
      expected,
    } = await fixture();
    await applyRelationReviewChanges(root, [change(a, b, expected)], options());
    const before = await fs.readFile(relationGraphPath(root), "utf8");
    await expect(
      applyRelationReviewChanges(
        root,
        [change(c, d, null)],
        options({
          batchId: "batch-2",
          eventId: "event-2",
          [key]: key === "eventId" ? "event-1" : "batch-1",
        }),
      ),
    ).rejects.toThrow("duplicate-review");
    expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
  },
);

it("checks source revisions after assertCurrent and leaves a failed batch byte-identical", async () => {
  const {
    skills,
    identities: [a, b],
    expected,
  } = await fixture();
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(
    applyRelationReviewChanges(
      root,
      [change(a, b, expected)],
      options({
        assertCurrent: async () => {
          await fs.appendFile(skills[0].location, "changed\n");
        },
      }),
    ),
  ).rejects.toThrow("stale-source");
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
});

it("runs assertCurrent while holding the graph lock and publishes nothing on callback failure", async () => {
  const {
    identities: [a, b],
    expected,
  } = await fixture();
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(
    applyRelationReviewChanges(
      root,
      [change(a, b, expected)],
      options({
        assertCurrent: async () => {
          expect(
            (await fs.stat(`${relationGraphPath(root)}.lock`)).isDirectory(),
          ).toBe(true);
          throw new Error("evidence-changed");
        },
      }),
    ),
  ).rejects.toThrow("evidence-changed");
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
});

it.each([
  [
    "missing endpoint evidence",
    (value: RelationReviewChange) => {
      value.evidence = value.evidence.slice(0, 1);
    },
  ],
  [
    "foreign evidence",
    (value: RelationReviewChange) => {
      value.evidence = [
        ...value.evidence,
        { ...value.evidence[0], skillId: "foreign" },
      ];
    },
  ],
  [
    "unknown evidence fields",
    (value: RelationReviewChange) => {
      value.evidence = [
        { ...value.evidence[0], confidence: 1 } as RelationReviewEvidence,
        value.evidence[1],
      ];
    },
  ],
  [
    "invalid line",
    (value: RelationReviewChange) => {
      value.evidence = [
        { ...value.evidence[0], startLine: NaN },
        value.evidence[1],
      ];
    },
  ],
  [
    "path traversal",
    (value: RelationReviewChange) => {
      value.evidence = [
        { ...value.evidence[0], filePath: "../secret" },
        value.evidence[1],
      ];
    },
  ],
  [
    "empty reason",
    (value: RelationReviewChange) => {
      value.reason = " ";
    },
  ],
  [
    "self edge",
    (value: RelationReviewChange) => {
      value.to = value.from;
    },
  ],
  [
    "update absence",
    (value: RelationReviewChange) => {
      value.expected = null;
    },
  ],
  [
    "create with expected",
    (value: RelationReviewChange) => {
      value.operation = "create";
    },
  ],
] as const)(
  "rejects %s before publishing any operation",
  async (_label, mutate) => {
    const {
      identities: [a, b],
      expected,
    } = await fixture();
    const before = await fs.readFile(relationGraphPath(root), "utf8");
    const value = change(a, b, expected);
    mutate(value);
    await expect(
      applyRelationReviewChanges(root, [value], options()),
    ).rejects.toThrow();
    expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
  },
);

it("rejects an entire batch if its later change has a stale expected edge", async () => {
  const {
    identities: [a, b, c, d],
    expected,
  } = await fixture();
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  await expect(
    applyRelationReviewChanges(
      root,
      [
        change(c, d, null),
        change(a, b, {
          ...expected,
          properties: { ...expected.properties, reason: "stale" },
        }),
      ],
      options(),
    ),
  ).rejects.toThrow("stale-relation");
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
});

it("rejects duplicate endpoint pairs and batches larger than eight", async () => {
  const {
    identities: [a, b],
    expected,
  } = await fixture();
  for (const count of [2, 9]) {
    await expect(
      applyRelationReviewChanges(
        root,
        Array.from({ length: count }, () => change(a, b, expected)),
        options(),
      ),
    ).rejects.toThrow();
  }
});

it("accepts the full eight-change bound without duplicating shared endpoint nodes", async () => {
  const { identities, expected } = await fixture();
  const changes = identities
    .flatMap((from) =>
      identities
        .filter((to) => from.id !== to.id)
        .map((to) =>
          change(
            from,
            to,
            from.id === expected.from && to.id === expected.to
              ? expected
              : null,
          ),
        ),
    )
    .slice(0, 8);
  expect(await applyRelationReviewChanges(root, changes, options())).toEqual({
    changed: 8,
    batchId: "batch-1",
  });
  const graph = (await readRelationGraph(root))!;
  expect(graph.entities.size).toBe(4);
  expect(graph.relations).toHaveLength(8);
});

it("does not publish a canceled review", async () => {
  const {
    identities: [a, b],
    expected,
  } = await fixture();
  const before = await fs.readFile(relationGraphPath(root), "utf8");
  const controller = new AbortController();
  await expect(
    applyRelationReviewChanges(
      root,
      [change(a, b, expected)],
      options({
        signal: controller.signal,
        assertCurrent: async () => {
          controller.abort();
        },
      }),
    ),
  ).rejects.toThrow();
  expect(await fs.readFile(relationGraphPath(root), "utf8")).toBe(before);
});

it("reads legacy author-import properties while omitting source from every new edge", async () => {
  const {
    skills,
    identities: [a, b],
    expected,
  } = await fixture();
  expect(expected.properties.source).toBeUndefined();
  const raw = await fs.readFile(relationGraphPath(root), "utf8");
  const legacy =
    raw
      .trimEnd()
      .split("\n")
      .map((line) => {
        const record = JSON.parse(line);
        if (record.op === "relate") record.properties.source = "author-import";
        return JSON.stringify(record);
      })
      .join("\n") + "\n";
  await fs.writeFile(relationGraphPath(root), legacy);
  expect(
    (await resolveRelationGraph(root, skills)).get("a")?.[0],
  ).toMatchObject({ source: "author-import" });
  const previous = (await readRelationGraph(root))!.relations[0];
  await applyRelationReviewChanges(root, [change(a, b, previous)], options());
  const after = await fs.readFile(relationGraphPath(root), "utf8");
  expect(after.startsWith(legacy)).toBe(true);
  const relation = (await readRelationGraph(root))!.relations[0];
  expect(relation.properties.source).toBeUndefined();
});

it("never refreshes an unrelated edge when updating a shared node", async () => {
  const {
    skills,
    identities: [a, b, c],
    expected,
  } = await fixture();
  await appendImportedRelations(root, [
    { from: a, to: c, type: "related", reason: "untouched" },
  ]);
  const beforeOther = (await readRelationGraph(root))!.relations[1];
  await fs.appendFile(skills[0].location, "Current revision\n");
  const registry = {
    version: 1 as const,
    sources: [
      {
        id: "github:example/skills",
        root: path.join(root, "source"),
        skills: Object.fromEntries(
          skills.map(({ name }) => [
            name,
            { name, source_path: `${name}/SKILL.md` },
          ]),
        ),
      },
    ],
  };
  const current = (await readSkillIdentity(skills[0], registry))!;
  await applyRelationReviewChanges(
    root,
    [change(current, b, expected)],
    options(),
  );
  expect(
    (await readRelationGraph(root))!.relations.find((edge) => edge.to === c.id),
  ).toEqual(beforeOther);
  expect((await resolveRelationGraph(root, skills)).get("a")).toEqual([
    expect.objectContaining({ name: "b", reason: "Reviewed reason" }),
  ]);
});

it("serializes competing review batches and accepts only the first matching target revision", async () => {
  const {
    identities: [a, b],
    expected,
  } = await fixture();
  const results = await Promise.allSettled([
    applyRelationReviewChanges(root, [change(a, b, expected)], options()),
    applyRelationReviewChanges(
      root,
      [change(a, b, expected)],
      options({ batchId: "batch-2", eventId: "event-2" }),
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect((await readRelationGraph(root))!.relations).toHaveLength(1);
});

it("preserves exact prior bytes when the JSONL prefix lacks a final newline", async () => {
  const {
    identities: [a, b],
    expected,
  } = await fixture();
  const file = relationGraphPath(root);
  const prefix = (await fs.readFile(file, "utf8")).trimEnd();
  await fs.writeFile(file, prefix);
  await applyRelationReviewChanges(root, [change(a, b, expected)], options());
  expect((await fs.readFile(file, "utf8")).startsWith(prefix + "\n")).toBe(
    true,
  );
});

it("rejects graph node ownership conflicts and current registry rebinding", async () => {
  const {
    identities: [a, b],
    expected,
  } = await fixture();
  const file = relationGraphPath(root);
  const original = await fs.readFile(file, "utf8");
  const foreign = original.replace('"skill_key":"a"', '"skill_key":"foreign"');
  await fs.writeFile(file, foreign);
  await expect(
    applyRelationReviewChanges(root, [change(a, b, expected)], options()),
  ).rejects.toThrow("ownership conflict");
  expect(await fs.readFile(file, "utf8")).toBe(foreign);
  await fs.writeFile(file, original);
  await expect(
    applyRelationReviewChanges(
      root,
      [change(a, b, expected)],
      options({
        assertCurrent: async () => {
          const registryFile = path.join(root, "skill-relations/sources.json");
          const registry = JSON.parse(await fs.readFile(registryFile, "utf8"));
          delete registry.sources[0].skills.a;
          await fs.writeFile(registryFile, JSON.stringify(registry));
        },
      }),
    ),
  ).rejects.toThrow("stale-source");
  expect(await fs.readFile(file, "utf8")).toBe(original);
});

it("tracks per-pair replay revisions across ABA, identical operations, and deletion tombstones", () => {
  const relate = {
    op: "relate",
    from: "source:a",
    rel: "related",
    to: "source:b",
    properties: { reason: "Original relation" },
  };
  const unrelate = {
    op: "unrelate",
    from: relate.from,
    rel: relate.rel,
    to: relate.to,
  };
  const pair = JSON.stringify([relate.from, relate.to]);
  const encode = (records: unknown[]) =>
    records.map((record) => JSON.stringify(record)).join("\n");
  const original = replayRelationGraph(encode([relate]));
  const revision = original.relationRevisions?.get(pair);
  expect(revision).toMatch(/^[a-f0-9]{64}$/);

  const unrelated = { ...relate, from: "source:c", to: "source:d" };
  const untouched = replayRelationGraph(encode([relate, unrelated]));
  expect(untouched.relationRevisions?.get(pair)).toBe(revision);
  expect(
    untouched.relationRevisions?.get(
      JSON.stringify([unrelated.from, unrelated.to]),
    ),
  ).toBeDefined();

  const repeated = replayRelationGraph(encode([relate, relate]));
  expect(repeated.relationRevisions?.get(pair)).not.toBe(revision);
  const restored = replayRelationGraph(encode([relate, unrelate, relate]));
  expect(restored.relations).toEqual(original.relations);
  expect(restored.relationRevisions?.get(pair)).not.toBe(revision);

  const deleted = replayRelationGraph(encode([relate, unrelate]));
  expect(deleted.relations).toEqual([]);
  expect(deleted.relationRevisions?.get(pair)).toMatch(/^[a-f0-9]{64}$/);
  expect(deleted.relationRevisions?.get(pair)).not.toBe(revision);
  const deletedAgain = replayRelationGraph(
    encode([relate, unrelate, unrelate]),
  );
  expect(deletedAgain.relations).toEqual([]);
  expect(deletedAgain.relationRevisions?.get(pair)).not.toBe(
    deleted.relationRevisions?.get(pair),
  );
});

it.each(["legacy", "mixed", "foreign-type"] as const)(
  "rejects Review writes to a %s destination without migrating its readable history",
  async (kind) => {
    const {
      identities: [a, b],
      expected,
    } = await fixture();
    const file = relationGraphPath(root);
    const original = await fs.readFile(file, "utf8");
    const legacy = {
      op: "create",
      entity: {
        id: "historical",
        type: kind === "foreign-type" ? "Other" : "Skill",
        properties: { formatVersion: kind === "foreign-type" ? 2 : 1 },
      },
    };
    const before = `${kind === "legacy" ? "" : original}${JSON.stringify(legacy)}\n`;
    await fs.writeFile(file, before);
    expect((await readRelationGraph(root))!.entities.get("historical")).toEqual(
      legacy.entity,
    );
    let checked = false;
    await expect(
      applyRelationReviewChanges(
        root,
        [change(a, b, kind === "legacy" ? null : expected)],
        options({
          assertCurrent: async () => {
            checked = true;
          },
        }),
      ),
    ).rejects.toThrow("stable-writer-on-legacy-graph");
    expect(checked).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  },
);
