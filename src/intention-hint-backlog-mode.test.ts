import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/intention-hint/SKILL.md");
const referencePath = path.resolve(
  "skills/intention-hint/references/evolve-workflow.md",
);

describe("intention-hint backlog mode", () => {
  it("routes explicit backlog requests to the transactional reference", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));
    const reference = fs.readFileSync(referencePath, "utf-8");

    expect(parsed.data).toMatchObject({
      name: "intention-hint",
      description: expect.stringContaining(
        "Design, inventory, or evolve intent definitions",
      ),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain("## Mode: evolve");
    expect(parsed.content).toContain("references/evolve-workflow.md");

    expect(reference).toContain("only when the user explicitly asks");
    expect(reference).toContain("Process exactly one pending finding");
    expect(reference).toContain("pnpm run backlog -- show");
    expect(reference).toContain("pnpm run backlog -- set-target");
    expect(reference).toContain("pnpm run backlog -- validate-intents");
    expect(reference).toContain("pnpm run backlog -- mark-processed");
    expect(reference).toContain("pnpm run backlog -- list --json");
    expect(reference).toContain("obtain explicit user confirmation");
    expect(reference).toContain("leave the item `pending`");
    expect(reference).toContain("Never mark an item `dismissed`");
  });
});
