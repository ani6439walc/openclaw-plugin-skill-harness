import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/skill-harness/SKILL.md");
const referencePath = path.resolve(
  "skills/skill-harness/references/evolution.md",
);

describe("skill-harness backlog mode", () => {
  it("documents direct evolution without backlog tool surfaces", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));
    const reference = fs.readFileSync(referencePath, "utf-8");

    expect(parsed.data).toMatchObject({
      name: "skill-harness",
      description: expect.stringContaining(
        "Design, inventory, evolve, or extract intent definitions",
      ),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain("## Mode: evolve");
    expect(parsed.content).toContain("references/evolution.md");

    expect(reference).toContain(
      "Evolution no longer creates or processes backlog items",
    );
    expect(reference).toContain(
      "bounded `read`/`write` tools rooted at the runtime intents directory",
    );
    expect(reference).toContain("schemaVersion: 4");
    expect(reference).toContain("processedEvents");
    expect(reference).toContain("There is no `items` array");
    expect(reference).not.toContain("skill_harness_evolution");
    expect(reference).not.toContain("/skill-harness evolution");
    expect(reference).toContain("get explicit confirmation before editing");
    expect(reference).toContain("pnpm test src/intent-validation.test.ts");
  });
});
