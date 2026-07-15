import { describe, expect, it } from "vitest";
import { validateInstructionSkillEvidence } from "./instruction-skill-evidence.js";

interface ToolCallFixture {
  id: string;
  name: "skill_search" | "skill_view";
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  isError?: boolean;
}

function transcript(...calls: ToolCallFixture[]): string {
  const lines: string[] = [];
  for (const call of calls) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: call.isError === true,
          content: [{ type: "text", text: JSON.stringify(call.result) }],
        },
      }),
    );
  }
  return lines.join("\n");
}

function summary(
  calls: number,
  tools: string[],
  failures = 0,
): Record<string, unknown> {
  return { calls, tools, failures };
}

describe("validateInstructionSkillEvidence", () => {
  it("accepts a no-tool result only when no additional skill is returned", () => {
    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: [],
        availableSkillNames: ["existing-skill"],
        transcript: "",
      }),
    ).toBe(true);
    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: ["invented-skill"],
        availableSkillNames: ["existing-skill"],
        transcript: "",
      }),
    ).toBe(false);
    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: ["   "],
        availableSkillNames: [],
        transcript: "",
      }),
    ).toBe(false);
  });

  it("accepts one successful view only for an existing candidate", () => {
    const viewTranscript = transcript({
      id: "view-1",
      name: "skill_view",
      arguments: { name: "existing-skill" },
      result: { success: true, name: "existing-skill" },
    });

    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: [],
        availableSkillNames: ["existing-skill"],
        transcript: viewTranscript,
        toolSummary: summary(1, ["skill_view"]),
      }),
    ).toBe(true);
    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: ["existing-skill"],
        availableSkillNames: ["existing-skill"],
        transcript: viewTranscript,
        toolSummary: summary(1, ["skill_view"]),
      }),
    ).toBe(false);
    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: [],
        availableSkillNames: ["existing-skill"],
        transcript: transcript({
          id: "view-support",
          name: "skill_view",
          arguments: {
            name: "existing-skill",
            file_path: "references/checklist.md",
          },
          result: { success: true, name: "existing-skill" },
        }),
        toolSummary: summary(1, ["skill_view"]),
      }),
    ).toBe(false);
  });

  it("accepts one new skill only after matching search and view evidence", () => {
    const searchThenView = transcript(
      {
        id: "search-1",
        name: "skill_search",
        arguments: { query: "release safety", limit: 3 },
        result: {
          success: true,
          skills: [{ name: "shipping-and-launch" }],
        },
      },
      {
        id: "view-1",
        name: "skill_view",
        arguments: { name: "shipping-and-launch" },
        result: { success: true, name: "shipping-and-launch" },
      },
    );

    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: ["shipping-and-launch"],
        availableSkillNames: ["existing-skill"],
        transcript: searchThenView,
        toolSummary: summary(2, ["skill_search", "skill_view"]),
      }),
    ).toBe(true);
    expect(
      validateInstructionSkillEvidence({
        additionalCandidateSkills: ["different-skill"],
        availableSkillNames: ["existing-skill"],
        transcript: searchThenView,
        toolSummary: summary(2, ["skill_search", "skill_view"]),
      }),
    ).toBe(false);
  });

  it("rejects missing, failed, reordered, or over-budget tool evidence", () => {
    const searchThenView = transcript(
      {
        id: "search-1",
        name: "skill_search",
        arguments: { query: "release safety", limit: 3 },
        result: {
          success: true,
          skills: [{ name: "shipping-and-launch" }],
        },
      },
      {
        id: "view-1",
        name: "skill_view",
        arguments: { name: "shipping-and-launch" },
        result: { success: true, name: "shipping-and-launch" },
      },
    );
    const params = {
      additionalCandidateSkills: ["shipping-and-launch"],
      availableSkillNames: ["existing-skill"],
    };

    expect(
      validateInstructionSkillEvidence({
        ...params,
        transcript: "",
        toolSummary: summary(2, ["skill_search", "skill_view"]),
      }),
    ).toBe(false);
    expect(
      validateInstructionSkillEvidence({
        ...params,
        transcript: searchThenView,
        toolSummary: summary(2, ["skill_search", "skill_view"], 1),
      }),
    ).toBe(false);
    expect(
      validateInstructionSkillEvidence({
        ...params,
        transcript: searchThenView,
        toolSummary: summary(2, ["skill_view", "skill_search"]),
      }),
    ).toBe(false);
    expect(
      validateInstructionSkillEvidence({
        ...params,
        transcript: `${searchThenView}\n${transcript({
          id: "view-2",
          name: "skill_view",
          arguments: { name: "another-skill" },
          result: { success: true, name: "another-skill" },
        })}`,
        toolSummary: summary(3, ["skill_search", "skill_view"]),
      }),
    ).toBe(false);
    expect(
      validateInstructionSkillEvidence({
        ...params,
        transcript: transcript(
          {
            id: "search-wide",
            name: "skill_search",
            arguments: { query: "release safety", limit: 20 },
            result: {
              success: true,
              skills: [{ name: "shipping-and-launch" }],
            },
          },
          {
            id: "view-wide",
            name: "skill_view",
            arguments: { name: "shipping-and-launch" },
            result: { success: true, name: "shipping-and-launch" },
          },
        ),
        toolSummary: summary(2, ["skill_search", "skill_view"]),
      }),
    ).toBe(false);
  });
});
