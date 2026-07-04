import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/intention-hint/SKILL.md");
const referencePath = path.resolve(
  "skills/intention-hint/references/evolution.md",
);

describe("intention-hint backlog mode", () => {
  it("routes explicit backlog requests to the transactional reference", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));
    const reference = fs.readFileSync(referencePath, "utf-8");

    expect(parsed.data).toMatchObject({
      name: "intention-hint",
      description: expect.stringContaining(
        "Design, inventory, evolve, or extract intent definitions",
      ),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain("## Mode: evolve");
    expect(parsed.content).toContain("references/evolution.md");

    expect(reference).toContain("only when the user explicitly asks");
    expect(reference).toContain("Process exactly one pending finding");
    expect(reference).toContain("intention_hint_evolution");
    expect(reference).toContain("/intention-hint evolution show");
    expect(reference).toContain("/intention-hint evolution set-target");
    expect(reference).toContain("/intention-hint evolution validate-intents");
    expect(reference).toContain("/intention-hint evolution mark-processed");
    expect(reference).toContain("/intention-hint evolution mark-dismissed");
    expect(reference).toContain("/intention-hint evolution list");
    expect(reference).toContain("obtain explicit user confirmation");
    expect(reference).toContain("leave the item `pending`");
    expect(reference).toContain("duplicate, superseded, unsafe");
    expect(reference).toContain("Body-boundary Mismatch Decision");
    expect(reference).toContain("oversized intent");
    expect(reference).toContain("Propose a rename");
  });
});
