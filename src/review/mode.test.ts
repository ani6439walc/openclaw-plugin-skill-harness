import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/skill-harness/SKILL.md");
const referencePath = path.resolve("skills/skill-harness/references/review.md");

describe("skill-harness review mode", () => {
  it("does not expose manual review workflow now handled by subagents", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));

    expect(parsed.data).toMatchObject({
      name: "skill-harness",
      description: expect.stringContaining(
        "Design, inventory, or extract intent definitions",
      ),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain(
      "Background subagents handle automated self-improvement",
    );
    expect(parsed.content).not.toContain("## Mode: evolve");
    expect(parsed.content).not.toContain("references/review.md");
    expect(parsed.content).not.toContain("Process a review finding");
    expect(fs.existsSync(referencePath)).toBe(false);
  });
});
