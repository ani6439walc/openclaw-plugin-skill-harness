import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", { spy: true });
import {
  applyImportCheckpoint,
  CLASSIFICATION_VERSION,
  classifyRelations,
  createImportClassifier,
  parseAuthorRelations,
  preflightRelations,
  selectRelationType,
  runRelationImportCli,
} from "./relation-import.js";
import { scoredRelationTypes } from "./relation-graph.js";
import {
  registerRelationSource,
  readRelationSources,
} from "./relation-sources.js";
import type { ImportCandidate, ImportPlan } from "./relation-import.js";
import type { OpenClawConfig } from "../../api.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relations-import-"));
  roots.push(root);
  return root;
}
async function skill(root: string, name: string, related = "", body = "Body") {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Example ${name}\n${related ? `metadata:\n  related-skills: ${related}\n` : ""}---\n${body}\n`,
  );
}
function plan(count: number): ImportPlan {
  return {
    version: 1,
    source: "/tmp/source",
    skillCount: count + 1,
    issues: [],
    candidates: Array.from({ length: count }, (_, index): ImportCandidate => ({
      key: String(index),
      relation: {
        from: { id: "a", name: "a", source: "/a", fingerprint: "a" },
        to: {
          id: String(index),
          name: `b${index}`,
          source: `/b${index}`,
          fingerprint: "b",
        },
        type: "related",
        reason: "complementary",
      },
      evidence: {
        from: { name: "a", description: "a", body: "a" },
        to: { name: `b${index}`, description: "b", body: "b" },
        reason: "complementary",
      },
    })),
  };
}
function client(handler: (...args: unknown[]) => unknown) {
  return {
    model: "test/model",
    client: { systemOne: vi.fn(handler) } as unknown as Pick<
      TypeSafeClient,
      "systemOne"
    >,
  };
}
function response(input: unknown) {
  const keys = Object.keys((input as { questions: object }).questions);
  return {
    answers: Object.fromEntries(
      keys.map((key) => [
        key,
        { type: "noul", noul: key.endsWith("composes_with") ? 0.95 : 0.1 },
      ]),
    ),
  };
}
describe("relation import", () => {
  it("keeps CLI identities consistent across preflight, sample, classify and apply", async () => {
    const dir = await root();
    const dataRoot = await root();
    await skill(dir, "a", "{b: helpful}");
    await skill(dir, "b");
    await registerRelationSource(dataRoot, {
      id: "github:example/skills",
      root: dir,
      skills: {
        a: { name: "a", source_path: "a/SKILL.md" },
        b: { name: "b", source_path: "b/SKILL.md" },
      },
    });
    const config = path.join(dataRoot, "config.json");
    const checkpoint = path.join(dataRoot, "checkpoint.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                decisionModel: { model: "test-jev", apiKey: "fixture-only" },
              },
            },
          },
        },
      }),
    );
    const request = vi
      .spyOn(TypeSafeClient.prototype, "systemOne")
      .mockImplementation((async (input: unknown) =>
        response(input)) as TypeSafeClient["systemOne"]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const planOut = path.join(dataRoot, "plan.json");
      const common = ["--source", dir, "--data-root", dataRoot];
      await runRelationImportCli(["preflight", ...common, "--output", planOut]);
      const preflightSummary = JSON.parse(
        output.mock.calls[0]?.[0] as string,
      ) as { needsModel: number; estimatedRequests: number };
      expect(preflightSummary.needsModel).toBe(1);
      expect(preflightSummary.estimatedRequests).toBe(1);
      await runRelationImportCli([
        "sample",
        ...common,
        "--config",
        config,
        "--checkpoint",
        checkpoint,
      ]);
      await runRelationImportCli([
        "classify",
        ...common,
        "--config",
        config,
        "--checkpoint",
        checkpoint,
      ]);
      expect(request).toHaveBeenCalledTimes(1);
      if (process.platform !== "win32") {
        expect((await fs.stat(planOut)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(checkpoint)).mode & 0o777).toBe(0o600);
      }
      await runRelationImportCli([
        "apply",
        ...common,
        "--checkpoint",
        checkpoint,
      ]);
      const raw = await fs.readFile(
        path.join(dataRoot, "skill-relations/graph.jsonl"),
        "utf8",
      );
      expect(raw).toContain('"id":"github:example/skills:a"');
      expect(raw).toContain('"formatVersion":2');
    } finally {
      request.mockRestore();
      output.mockRestore();
    }
  });
  it("uses explicitly registered stable origins for manual checkpoint imports", async () => {
    const dir = await root();
    const dataRoot = await root();
    await skill(dir, "a", "{b: helpful}");
    await skill(dir, "b");
    await registerRelationSource(dataRoot, {
      id: "github:example/skills",
      root: dir,
      skills: {
        a: { name: "a", source_path: "a/SKILL.md" },
        b: { name: "b", source_path: "b/SKILL.md" },
      },
    });
    const registry = readRelationSources(dataRoot)!;
    const planned = await preflightRelations(dir, registry);
    expect(planned.candidates[0].relation.from.id).toBe(
      "github:example/skills:a",
    );
    const checkpoint = await classifyRelations(planned, client(response));
    await applyImportCheckpoint(dataRoot, planned, checkpoint);
    const raw = await fs.readFile(
      path.join(dataRoot, "skill-relations/graph.jsonl"),
      "utf8",
    );
    expect(raw).toContain('"formatVersion":2');
    expect(raw).not.toContain("verification_status");
  });
  it("requires the plugin decision endpoint before creating a manual classifier", () => {
    for (const plugin of [
      {},
      { jev: { model: "old/jev" } },
      { qmd: { jev: { model: "qmd/jev" } } },
    ]) {
      expect(() =>
        createImportClassifier({
          plugins: { entries: { "skill-harness": { config: plugin } } },
        } as unknown as OpenClawConfig),
      ).toThrow("missing-decision-model");
    }
  });
  it("uses only the plugin decisionModel with the host provider catalog", () => {
    const classifier = createImportClassifier({
      models: {
        providers: {
          custom: { baseUrl: "https://decision.test/v1", apiKey: "test-key" },
        },
      },
      plugins: {
        entries: {
          "skill-harness": {
            config: {
              decisionModel: { model: "custom/decision-jev" },
              qmd: { jev: { model: "qmd/other-jev" } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig);
    expect(classifier.model).toBe("decision-jev");
    expect(classifier.client).toBeDefined();
  });
  it("parses four author formats without inventing reasons", () => {
    for (const input of [{ b: "because" }, '{"b":"because"}'])
      expect(parseAuthorRelations(input)).toEqual([
        { name: "b", reason: "because" },
      ]);
    for (const input of [["b"], '["b"]'])
      expect(parseAuthorRelations(input)).toEqual([{ name: "b", reason: "" }]);
    expect(parseAuthorRelations(null)).toEqual([]);
    expect(() => parseAuthorRelations({ b: 3 })).toThrow();
    expect(() => parseAuthorRelations([{ b: "one" }, { b: "two" }])).toThrow();
  });
  it("resolves names/prefixes, reports missing/self targets and preserves source bytes", async () => {
    const dir = await root();
    await skill(
      dir,
      "a",
      `'${JSON.stringify({ "skills/b": "handoff", missing: "x", a: "self" })}'`,
      "😀".repeat(5000),
    );
    await skill(dir, "b");
    const before = await fs.readFile(path.join(dir, "a/SKILL.md"));
    const result = await preflightRelations(dir);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].relation.to.name).toBe("b");
    expect(Array.from(result.candidates[0].evidence.from.body)).toHaveLength(
      4000,
    );
    expect(result.issues.map((i) => i.code).sort()).toEqual([
      "missing-target",
      "self-relation",
    ]);
    expect(await fs.readFile(path.join(dir, "a/SKILL.md"))).toEqual(before);
  });
  it("uses calibrated per-predicate thresholds without promoting uncertain relations", () => {
    const base = {
      depends_on: 0.1,
      composes_with: 0.1,
      similar_to: 0.1,
      conflicts_with: 0.1,
      specializes: 0.1,
    };
    expect(
      selectRelationType({ ...base, depends_on: 0.85, composes_with: 0.7 }),
    ).toBe("depends_on");
    expect(
      selectRelationType({ ...base, depends_on: 0.95, composes_with: 0.8 }),
    ).toBe("depends_on");
    expect(
      selectRelationType({ ...base, depends_on: 0.85, composes_with: 0.71 }),
    ).toBe("related");
    expect(selectRelationType({ ...base, depends_on: 0.84 })).toBe("related");

    expect(
      selectRelationType({ ...base, conflicts_with: 0.85, similar_to: 0.7 }),
    ).toBe("conflicts_with");
    expect(
      selectRelationType({ ...base, conflicts_with: 0.85, similar_to: 0.71 }),
    ).toBe("related");
    expect(selectRelationType({ ...base, conflicts_with: 0.84 })).toBe(
      "related",
    );

    expect(
      selectRelationType({ ...base, similar_to: 0.85, composes_with: 0.7 }),
    ).toBe("similar_to");
    expect(
      selectRelationType({ ...base, similar_to: 0.85, composes_with: 0.71 }),
    ).toBe("related");
    expect(selectRelationType({ ...base, similar_to: 0.84 })).toBe("related");

    expect(
      selectRelationType({ ...base, composes_with: 0.68, similar_to: 0.53 }),
    ).toBe("composes_with");
    expect(
      selectRelationType({ ...base, composes_with: 0.68, similar_to: 0.54 }),
    ).toBe("related");
    expect(selectRelationType({ ...base, composes_with: 0.67 })).toBe(
      "related",
    );

    expect(selectRelationType({ ...base, specializes: 0.9 })).toBe(
      "specializes",
    );
    expect(
      selectRelationType({
        specializes: 0.85,
        similar_to: 0.88,
        composes_with: 0.8,
        conflicts_with: 0.55,
        depends_on: 0.55,
      }),
    ).toBe("specializes");
    expect(
      selectRelationType({
        ...base,
        specializes: 0.85,
        similar_to: 0.88 + 1.5 * Number.EPSILON,
      }),
    ).toBe("related");
    expect(
      selectRelationType({
        specializes: 0.84,
        similar_to: 0.1,
        composes_with: 0.1,
        conflicts_with: 0.1,
        depends_on: 0.1,
      }),
    ).toBe("related");
    expect(
      selectRelationType({
        ...base,
        specializes: 0.85,
        similar_to: 0.89,
      }),
    ).toBe("related");
    expect(
      selectRelationType({
        ...base,
        specializes: 0.85,
        composes_with: 0.81,
      }),
    ).toBe("related");
    expect(
      selectRelationType({
        ...base,
        specializes: 0.85,
        conflicts_with: 0.56,
      }),
    ).toBe("related");
    expect(
      selectRelationType({
        ...base,
        specializes: 0.85,
        depends_on: 0.56,
      }),
    ).toBe("related");
    expect(
      selectRelationType({
        ...base,
        conflicts_with: 0.88,
        specializes: 0.86,
      }),
    ).toBe("related");
  });
  it("classifies one relation per request with concurrency bounded to four and fixed predicate questions", async () => {
    let active = 0,
      max = 0;
    const classifier = client(async (input) => {
      active++;
      max = Math.max(max, active);
      const req = input as {
        state: Record<string, unknown>;
        questions: Record<string, unknown>;
      };
      expect(req.state).toHaveProperty("source");
      expect(req.state).toHaveProperty("target");
      expect(req.state).toHaveProperty("reason");
      expect(req.state).not.toHaveProperty("edges");
      expect(Object.keys(req.questions).sort()).toEqual(
        [...scoredRelationTypes].sort(),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return response(input);
    });
    const result = await classifyRelations(plan(23), classifier, { limit: 20 });
    expect(Object.keys(result.results)).toHaveLength(20);
    expect(max).toBe(4);
    expect(classifier.client.systemOne).toHaveBeenCalledTimes(20);
    expect(result.results["0"].relation.type).toBe("composes_with");
  });
  it("skips no-reason requests, retries failed entries and invalidates changed model", async () => {
    const input = plan(2);
    input.candidates[0].relation.reason = "";
    const failed = client(() => {
      throw new Error("secret");
    });
    const first = await classifyRelations(input, failed);
    expect(first.results["0"].status).toBe("completed");
    expect(first.results["1"].status).toBe("failed");
    expect(JSON.stringify(first)).not.toContain("secret");
    const success = client(response);
    const second = await classifyRelations(input, success, {
      checkpoint: first,
    });
    expect(success.client.systemOne).toHaveBeenCalledTimes(1);
    await classifyRelations(input, success, { checkpoint: second });
    expect(success.client.systemOne).toHaveBeenCalledTimes(1);
    await classifyRelations(
      input,
      { ...success, model: "changed" },
      { checkpoint: second },
    );
    expect(success.client.systemOne).toHaveBeenCalledTimes(2);
  });
  it("isolates an invalid single-edge response without failing neighboring relations", async () => {
    const classifier = client((input) => {
      const targetName = (input as { state: { target: { name: string } } })
        .state.target.name;
      if (targetName === "b0") {
        return {
          answers: { depends_on: { type: "noul", noul: Infinity } },
        };
      }
      return response(input);
    });
    const result = await classifyRelations(plan(2), classifier);
    expect(result.results["0"].status).toBe("failed");
    expect(result.results["0"].relation.type).toBe("related");
    expect(result.results["0"].relation.scores).toBeUndefined();
    expect(result.results["1"].status).toBe("completed");
    expect(result.results["1"].relation.type).toBe("composes_with");
  });
  it("rejects older classificationVersion checkpoints before reuse or apply", async () => {
    const input = plan(1);
    const classifier = client(response);
    const checkpoint = await classifyRelations(input, classifier);
    const stale = {
      ...checkpoint,
      classificationVersion: "author-relations-v1",
    };
    await expect(
      classifyRelations(input, classifier, { checkpoint: stale }),
    ).rejects.toThrow("invalid-checkpoint");
    await expect(
      applyImportCheckpoint(await root(), input, stale),
    ).rejects.toThrow("invalid-checkpoint");
  });
  it("reports one estimated request per non-empty relation during preflight", async () => {
    const dir = await root();
    await skill(dir, "a", '{b: "r1", c: "r2", d: ""}');
    await skill(dir, "b");
    await skill(dir, "c");
    await skill(dir, "d");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runRelationImportCli(["preflight", "--source", dir]);
      const summary = JSON.parse(output.mock.calls[0]?.[0] as string) as {
        relations: number;
        needsModel: number;
        estimatedRequests: number;
      };
      expect(summary.relations).toBe(3);
      expect(summary.needsModel).toBe(2);
      expect(summary.estimatedRequests).toBe(2);
    } finally {
      output.mockRestore();
    }
  });
  it("flushes CLI checkpoints once for 19 or 20 edges and twice for 21 edges", async () => {
    for (const [count, expectedWrites] of [
      [19, 1],
      [20, 1],
      [21, 2],
    ] as const) {
      const dir = await root();
      const dataRoot = await root();
      const related = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`b${i}`, `reason ${i}`]),
      );
      await skill(dir, "a", `'${JSON.stringify(related)}'`);
      for (let i = 0; i < count; i++) await skill(dir, `b${i}`);
      const config = path.join(dataRoot, "config.json");
      const checkpoint = path.join(dataRoot, "checkpoint.json");
      await fs.writeFile(
        config,
        JSON.stringify({
          plugins: {
            entries: {
              "skill-harness": {
                config: {
                  decisionModel: { model: "test-jev", apiKey: "fixture-only" },
                },
              },
            },
          },
        }),
      );
      const request = vi
        .spyOn(TypeSafeClient.prototype, "systemOne")
        .mockImplementation((async (input: unknown) =>
          response(input)) as TypeSafeClient["systemOne"]);
      const renameSpy = vi.mocked(fsSync.renameSync);
      renameSpy.mockClear();
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await runRelationImportCli([
          "classify",
          "--source",
          dir,
          "--config",
          config,
          "--checkpoint",
          checkpoint,
        ]);
        const writes = renameSpy.mock.calls.filter(
          ([, newPath]) => newPath === checkpoint,
        ).length;
        expect(writes).toBe(expectedWrites);
        const saved = JSON.parse(await fs.readFile(checkpoint, "utf8")) as {
          results: Record<string, unknown>;
        };
        expect(Object.keys(saved.results)).toHaveLength(count);
      } finally {
        renameSpy.mockClear();
        request.mockRestore();
        output.mockRestore();
      }
    }
  });
  it("stops admitting new edges and drains in-flight requests when a CLI checkpoint flush fails", async () => {
    const count = 65;
    const dir = await root();
    const dataRoot = await root();
    const related = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`b${i}`, `reason ${i}`]),
    );
    await skill(dir, "a", `'${JSON.stringify(related)}'`);
    for (let i = 0; i < count; i++) await skill(dir, `b${i}`);
    const config = path.join(dataRoot, "config.json");
    const checkpoint = path.join(dataRoot, "checkpoint.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        plugins: {
          entries: {
            "skill-harness": {
              config: {
                decisionModel: { model: "test-jev", apiKey: "fixture-only" },
              },
            },
          },
        },
      }),
    );
    let started = 0;
    let active = 0;
    let settled = 0;
    const request = vi
      .spyOn(TypeSafeClient.prototype, "systemOne")
      .mockImplementation((async (input: unknown) => {
        started++;
        active++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        settled++;
        return response(input);
      }) as TypeSafeClient["systemOne"]);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const renameSpy = vi
      .mocked(fsSync.renameSync)
      .mockImplementation((oldPath, newPath) => {
        if (newPath === checkpoint) {
          throw Object.assign(new Error("ENOSPC: no space left on device"), {
            code: "ENOSPC",
          });
        }
        return actualFs.renameSync(oldPath, newPath);
      });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        runRelationImportCli([
          "classify",
          "--source",
          dir,
          "--config",
          config,
          "--checkpoint",
          checkpoint,
        ]),
      ).rejects.toThrow("ENOSPC");
      const startedAtRejection = started;
      expect(active).toBe(0);
      expect(settled).toBe(startedAtRejection);
      expect(startedAtRejection).toBeGreaterThanOrEqual(20);
      expect(startedAtRejection).toBeLessThanOrEqual(23);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(started).toBe(startedAtRejection);
      expect(fsSync.existsSync(checkpoint)).toBe(false);
      expect(
        (await fs.readdir(dataRoot)).filter((name) =>
          name.startsWith("checkpoint.json.tmp-"),
        ),
      ).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      request.mockRestore();
      output.mockRestore();
    }
  });
  it("applies idempotently and rejects changed content", async () => {
    const dir = await root();
    const data = await root();
    await skill(dir, "a", '{b: "handoff"}');
    await skill(dir, "b");
    const input = await preflightRelations(dir);
    const classified = await classifyRelations(input, client(response));
    expect((await applyImportCheckpoint(data, input, classified)).added).toBe(
      1,
    );
    expect(
      (await applyImportCheckpoint(data, input, classified)).unchanged,
    ).toBe(1);
    await skill(dir, "a", '{b: "handoff"}', "changed");
    await expect(
      applyImportCheckpoint(data, input, classified),
    ).rejects.toThrow("stale-source");
  });
  it("checkpoint identity changes never reuse stale evidence", async () => {
    const input = plan(1);
    const classifier = client(response);
    const first = await classifyRelations(input, classifier);
    input.candidates[0].relation.reason = "changed";
    const next = await classifyRelations(input, classifier, {
      checkpoint: first,
    });
    expect(classifier.client.systemOne).toHaveBeenCalledTimes(2);
    expect(next.results["0"].relation.reason).toBe("changed");
    expect(next.classificationVersion).toBe(CLASSIFICATION_VERSION);
  });
  it("rejects tampered classification scores before reuse or apply", async () => {
    const input = plan(1);
    const classifier = client(response);
    const checkpoint = await classifyRelations(input, classifier);
    checkpoint.results["0"].relation.scores!.depends_on = 2;
    await expect(
      classifyRelations(input, classifier, { checkpoint }),
    ).rejects.toThrow("invalid-checkpoint");
    await expect(
      applyImportCheckpoint(await root(), input, checkpoint),
    ).rejects.toThrow("invalid-checkpoint");
  });
  it("does not let metadata-only removal invalidate already prepared import", async () => {
    const dir = await root();
    const data = await root();
    await skill(dir, "a", '{b: "handoff"}');
    await skill(dir, "b");
    const input = await preflightRelations(dir);
    const checkpoint = await classifyRelations(input, client(response));
    await skill(dir, "a");
    expect((await applyImportCheckpoint(data, input, checkpoint)).added).toBe(
      1,
    );
  });
});
