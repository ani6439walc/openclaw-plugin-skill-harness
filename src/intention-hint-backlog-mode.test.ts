import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/intention-hint/SKILL.md");
const referencePath = path.resolve(
  "skills/intention-hint/references/process-backlog.md",
);

describe("intention-hint backlog mode", () => {
  it("routes explicit backlog requests to the transactional reference", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));
    const reference = fs.readFileSync(referencePath, "utf-8");

    expect(parsed.data).toMatchObject({
      name: "intention-hint",
      description: expect.stringContaining(
        "Use when designing or refining intent definitions",
      ),
    });
    expect(parsed.data).not.toHaveProperty("disable-model-invocation");
    expect(parsed.content).toContain("## Mode: backlog");
    expect(parsed.content).toContain("only when the user explicitly asks");
    expect(parsed.content).toContain("references/process-backlog.md");
    expect(parsed.content).toContain("Process exactly one pending finding");

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
