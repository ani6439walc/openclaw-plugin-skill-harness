import { describe, expect, it } from "vitest";
import { SKILL_HARNESS_SYSTEM_CONTEXT } from "./system-context.js";

describe("SKILL_HARNESS_SYSTEM_CONTEXT", () => {
  it("defines fixed skill discovery and hint fallback guidance", () => {
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain("## Skills (mandatory)");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain("`skill_list`");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain("`skill_search`");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain("`skill_view`");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain("`skill_manage`");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain(
      "Use only the Skill Harness tools exposed in the current turn",
    );
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain(
      "When a workflow supplies a narrower tool allowlist",
    );
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain(
      "search with 1-3 concise task concepts",
    );
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).toContain(
      "proceed without one rather than inventing a match",
    );
  });

  it("contains no runtime skill inventory or per-turn payload", () => {
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).not.toContain("<available_skills>");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).not.toContain(
      "<domain_skill_candidates>",
    );
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).not.toContain("<skill_harness_plugin");
    expect(SKILL_HARNESS_SYSTEM_CONTEXT).not.toMatch(/\/[^\s`]+\/SKILL\.md/);
  });
});
