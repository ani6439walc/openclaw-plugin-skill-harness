import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import matter from "gray-matter";

const skillPath = path.resolve("skills/skill-harness/SKILL.md");
const referencePath = path.resolve("skills/skill-harness/references/review.md");
const keywordAuditReferencePath = path.resolve(
  "skills/skill-harness/references/keyword-audit.md",
);
const keywordAuditScriptPath = path.resolve(
  "skills/skill-harness/scripts/review-keyword-audit.py",
);

describe("skill-harness review mode", () => {
  it("keeps automated review separate while exposing keyword audit maintenance", () => {
    const parsed = matter(fs.readFileSync(skillPath, "utf-8"));

    expect(parsed.data).toMatchObject({
      name: "skill-harness",
      description: expect.stringContaining(
        "updating Intent Review trigger keywords from runtime evidence",
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
    expect(parsed.content).toContain("## Mode: keyword-audit");
    expect(parsed.content).toContain("references/keyword-audit.md");
    expect(parsed.content).toContain("scripts/review-keyword-audit.py");
    expect(fs.existsSync(keywordAuditReferencePath)).toBe(true);
    expect(fs.existsSync(keywordAuditScriptPath)).toBe(true);
  });
});
