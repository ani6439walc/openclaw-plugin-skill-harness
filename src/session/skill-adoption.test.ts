import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSkillInfo, SessionTracker } from "./tracker.js";
import { StatsAggregator } from "../stats/aggregator.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);
const markdown =
  "---\nname: sample\ndescription: Sample skill.\n---\nInstructions.";

describe("skill adoption evidence", () => {
  it.each([
    {
      command: "cat /skills/sample/SKILL.md",
      result: "missing",
      success: false,
      error: "exit 1",
      adopted: false,
    },
    {
      command: "cat /skills/sample/SKILL.md",
      result: markdown,
      success: false,
      adopted: false,
    },
    {
      command: "cat /skills/sample/SKILL.md",
      result: markdown,
      error: "failed",
      adopted: false,
    },
    {
      command: "ls /skills/sample/SKILL.md",
      result: "/skills/sample/SKILL.md",
      success: true,
      adopted: false,
    },
    {
      command: "cat /skills/sample/SKILL.md",
      result: "",
      success: true,
      adopted: false,
    },
    {
      command: "cat /skills/sample/SKILL.md",
      result: "---\nname: sample",
      success: true,
      adopted: false,
    },
    {
      command: "cat /skills/sample/SKILL.md",
      result: markdown,
      success: true,
      adopted: true,
    },
  ])(
    "counts only verified reads: $command / $result / $success",
    async ({ command, result, success, error, adopted }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-adoption-"));
      roots.push(root);
      const tracker = SessionTracker.create(root);
      await tracker.preparePromptTurn({
        sessionId: "session",
        agentId: "main",
        runId: "turn",
        input: "read skill",
        startedAt: new Date().toISOString(),
      });
      const call = {
        toolCallId: "call",
        name: "exec",
        params: { command },
        result,
        success,
        error,
      };
      for (let i = 0; i < 2; i++)
        await tracker.mergeTurnAndPersist({
          sessionId: "session",
          expectedTurnKey: "turn",
          data: {
            matchedSkills: ["sample"],
            matchedExperiences: [],
            toolCalls: [call],
          },
        });
      await tracker.finalizeTurnFromAgentEnd({
        sessionId: "session",
        expectedTurnKey: "turn",
        endedAt: new Date().toISOString(),
      });
      const state = tracker.getCurrentState("session")!;
      expect(state.skillsUsed?.length ?? 0).toBe(adopted ? 1 : 0);
      expect(StatsAggregator.create(root).record("session", state)).toBe(true);
      const stats = JSON.parse(
        fs.readFileSync(path.join(root, "stats.json"), "utf8"),
      );
      expect(stats.skills.sample.usageTurns).toBe(adopted ? 1 : 0);
      expect(stats.skills.sample.adoptedTurns).toBe(adopted ? 1 : 0);
    },
  );

  it("requires a complete successful skill_view response or valid read frontmatter", () => {
    const response = {
      success: true,
      name: "sample",
      path: "/skills/sample/SKILL.md",
      content: markdown,
    };
    expect(
      extractSkillInfo("skill_view", {}, JSON.stringify(response))?.name,
    ).toBe("sample");
    for (const override of [
      { success: false },
      { content: "" },
      { name: " " },
    ]) {
      expect(
        extractSkillInfo(
          "skill_view",
          {},
          JSON.stringify({ ...response, ...override }),
        ),
      ).toBeUndefined();
    }
    expect(
      extractSkillInfo("read", { path: response.path }, markdown)?.name,
    ).toBe("sample");
    expect(
      extractSkillInfo(
        "read",
        { path: response.path },
        "---\nname: ' '\n---\n",
      ),
    ).toBeUndefined();
  });
});
