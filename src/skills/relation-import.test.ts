import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyImportCheckpoint,
  CLASSIFICATION_VERSION,
  classifyRelations,
  parseAuthorRelations,
  preflightRelations,
  selectRelationType,
} from "./relation-import.js";
import { scoredRelationTypes } from "./relation-graph.js";
import type { ImportCandidate, ImportPlan } from "./relation-import.js";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
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
  it("uses threshold and margin without promoting uncertain relations", () => {
    const scores = {
      depends_on: 0.8,
      composes_with: 0.65,
      similar_to: 0.1,
      conflicts_with: 0.1,
      specializes: 0.1,
    };
    expect(selectRelationType(scores)).toBe("depends_on");
    expect(selectRelationType({ ...scores, composes_with: 0.7 })).toBe(
      "related",
    );
    expect(selectRelationType({ ...scores, depends_on: 0.79 })).toBe("related");
  });
  it("bounds batches to five and concurrency to two; evaluates fixed questions", async () => {
    let active = 0,
      max = 0;
    const classifier = client(async (input) => {
      active++;
      max = Math.max(max, active);
      expect(
        Object.keys((input as { questions: object }).questions).length,
      ).toBeLessThanOrEqual(25);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return response(input);
    });
    const result = await classifyRelations(plan(23), classifier, { limit: 20 });
    expect(Object.keys(result.results)).toHaveLength(20);
    expect(max).toBe(2);
    expect(classifier.client.systemOne).toHaveBeenCalledTimes(4);
    expect(result.results["0"].relation.type).toBe("composes_with");
  });
  it("skips no-reason requests, retries failed batches and invalidates changed model", async () => {
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
  it("rejects an incomplete batch rather than partially recording classifications", async () => {
    const classifier = client(() => ({
      answers: { edge_0_depends_on: { type: "noul", noul: Infinity } },
    }));
    const result = await classifyRelations(plan(2), classifier);
    expect(
      Object.values(result.results).every(
        (r) => r.status === "failed" && r.relation.type === "related",
      ),
    ).toBe(true);
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
