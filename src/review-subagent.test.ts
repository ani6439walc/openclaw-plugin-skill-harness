import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { resolveConfig } from "./config.js";
import {
  buildReviewPrompt,
  parseReviewFindings,
  runReviewSubagent,
} from "./review-subagent.js";
import type { ReviewSnapshot } from "./evolution-types.js";

const snapshot: ReviewSnapshot = {
  sessionId: "session-1",
  sessionKey: "main-session-key",
  agentId: "main",
  eventId: "session-1:2026-06-11T00:00:00.000Z",
  turnNumber: 10,
  current: {
    input: "No, use the existing helper",
    intent: {
      intent: "other",
      reason: "unclear",
      confidence: 0.2,
      complexity: "high",
    },
    toolCalls: [{ name: "exec", error: "failed" }],
    result: "Done",
    timestamps: { start: "2026-06-11T00:00:00.000Z" },
  },
  recent: [],
  matchedIntent: {
    id: "other",
    definition: {
      triggers: ["Requests that do not match a defined intent"],
      examples: ["help with this"],
      prompt: "## Guidelines\n\n- Ask for context.",
    },
  },
  intentCatalog: [
    {
      id: "other",
      triggers: ["Requests that do not match a defined intent"],
      examples: ["help with this"],
    },
  ],
};

describe("buildReviewPrompt", () => {
  it("grounds every review in bundled intention-hint Markdown rules", () => {
    const prompt = buildReviewPrompt(snapshot, ["weak_intent"]);

    expect(prompt).toContain(
      "sole purpose is to improve the content and routing quality of intention-hint intents/*.md files",
    );
    expect(prompt).toContain(
      "Intent ids come from Markdown filenames without the .md suffix",
    );
    expect(prompt).toContain(
      "Frontmatter is classification-only and contains only triggers[] and examples[]",
    );
    expect(prompt).toContain(
      "## Guidelines, ## Skills & Tools, ## Response Strategy",
    );
    expect(prompt).toContain('indented "skill: <name>" line');
    expect(prompt).toContain("Concrete Workflow");
    expect(prompt).toContain("optional ## Experience");
    expect(prompt).toContain("reusable tips, parameters, pitfalls");
    expect(prompt).toContain("Recordability filter");
    expect(prompt).toContain("reusable workflows or decision steps");
    expect(prompt).toContain("costly error recovery paths");
    expect(prompt).toContain("critical parameters/settings/prerequisites");
    expect(prompt).toContain("multi-attempt successful solutions");
    expect(prompt).toContain("reusable templates/checklists/formats");
    expect(prompt).toContain("specific reusable context");
    expect(prompt).toContain("General workflow lessons");
    expect(prompt).toContain("Skill/tool experience lessons");
    expect(prompt).toContain("skill-specific pitfall and fix");
    expect(prompt).toContain("error message or localization path");
    expect(prompt).toContain("result-shaping parameter/configuration");
    expect(prompt).toContain("dependency or asset path");
    expect(prompt).toContain("required step ordering");
    expect(prompt).toContain("conclusions without reproducible steps");
    expect(prompt).toContain("reusable title, context, solution steps");
    expect(prompt).toContain("key paths, parameters, and keywords");
    expect(prompt).toContain("external learning entry");
    expect(prompt).toContain("writes outside runtime intent Markdown");
    expect(prompt).toContain("one-off Q&A");
    expect(prompt).toContain(
      "general knowledge rather than intent-routing guidance",
    );
    expect(prompt).toContain(
      "Never mention another intent name or id inside an intent body",
    );
    expect(prompt).toContain(
      "The only correction target is intent Markdown content",
    );
    expect(prompt).toContain(
      "suggestedChange must be a concrete intent Markdown draft or patch instruction",
    );
    expect(prompt).toContain(
      "matchedIntent as the source of truth for the current intent Markdown",
    );
    expect(prompt).toContain(
      "intentCatalog only to detect coverage gaps, overlaps, and boundary collisions",
    );
  });

  it.each([
    [
      "skill_candidate",
      "matched intent Markdown should preserve",
      "Skills & Tools, Concrete Workflow, or Experience section",
    ],
    [
      "process_gap",
      "failed execution and recovery path",
      "Guidelines, Skills & Tools, Concrete Workflow, or Experience",
    ],
    [
      "successful_pattern",
      "completed successful turn",
      "preserve the successful pattern",
    ],
    [
      "satisfaction_check",
      "intent boundary, body guidance, or response-strategy problem",
      "recommend split or merge only when evidence shows a collision",
    ],
    [
      "missing_intent",
      "uncategorized user goal",
      "Draft a new, narrowly scoped intent Markdown definition",
    ],
    [
      "weak_intent",
      "classification ambiguity",
      "frontmatter triggers/examples",
    ],
    [
      "behavior_fix",
      "matched intent's routed behavior",
      "encode the corrected behavior",
    ],
  ] as const)(
    "gives %s a distinct intent Markdown review focus and goal",
    (trigger, focus, goal) => {
      const prompt = buildReviewPrompt(snapshot, [trigger]);
      expect(prompt).toContain(`${trigger}: Review focus:`);
      expect(prompt).toContain(focus);
      expect(prompt).toContain(goal);
    },
  );

  it("includes only requested trigger-specific instructions", () => {
    const prompt = buildReviewPrompt(snapshot, ["weak_intent"]);
    expect(prompt).toContain("weak_intent: Review focus:");
    expect(prompt).not.toContain("missing_intent: Review focus:");
  });

  it("renders a readable XML-wrapped markdown review snapshot without runtime metadata", () => {
    const prompt = buildReviewPrompt(snapshot, ["weak_intent"]);

    expect(prompt).toContain("Review snapshot:");
    expect(prompt).toContain("<review_snapshot>");
    expect(prompt).toContain("</review_snapshot>");
    expect(prompt).toContain("## Current Turn");
    expect(prompt).toContain("- Turn number: 10");
    expect(prompt).toContain("### User Input");
    expect(prompt).toContain("No, use the existing helper");
    expect(prompt).toContain("### Intent Result");
    expect(prompt).toContain("- Intent: other");
    expect(prompt).toContain("- Confidence: 0.2");
    expect(prompt).toContain("### Tool Calls");
    expect(prompt).toContain("- exec: error=failed");
    expect(prompt).toContain("### Assistant Result");
    expect(prompt).toContain("Done");
    expect(prompt).toContain("## Matched Intent");
    expect(prompt).toContain("- ID: other");
    expect(prompt).toContain("## Intent Catalog");
    expect(prompt).toContain("Requests that do not match a defined intent");

    expect(prompt).not.toContain("session-1");
    expect(prompt).not.toContain("main-session-key");
    expect(prompt).not.toContain("eventId");
    expect(prompt).not.toContain("agentId");
    expect(prompt).not.toContain('"current"');
  });
});

describe("parseReviewFindings", () => {
  it("parses valid findings and drops no_finding entries", () => {
    const parsed = parseReviewFindings(
      JSON.stringify({
        findings: [
          { trigger: "broken", hasFinding: true },
          {
            trigger: "skill_candidate",
            hasFinding: true,
            operation: "refine",
            targetIntentIds: ["productivity"],
            dedupeKey: "deploy-flow",
            summary: "Deployment flow is reusable",
            evidence: ["Five related tool calls"],
            correctionGoal: "Create a deployment skill",
            suggestedChange: "Draft SKILL.md",
          },
          { trigger: "process_gap", hasFinding: false },
        ],
      }),
      ["skill_candidate", "process_gap"],
    );

    expect(parsed).toEqual([
      {
        trigger: "skill_candidate",
        operation: "refine",
        targetIntentIds: ["productivity"],
        dedupeKey: "deploy-flow",
        summary: "Deployment flow is reusable",
        evidence: ["Five related tool calls"],
        correctionGoal: "Create a deployment skill",
        suggestedChange: "Draft SKILL.md",
      },
    ]);
  });

  it("accepts fenced JSON and rejects unknown or unrequested triggers", () => {
    const raw = `\`\`\`json
{"findings":[
  {"trigger":"unknown","hasFinding":true,"operation":"refine","targetIntentIds":["X"],"dedupeKey":"x","summary":"x","evidence":[],"correctionGoal":"x","suggestedChange":"x"},
  {"trigger":"weak_intent","hasFinding":true,"operation":"refine","targetIntentIds":["productivity"],"dedupeKey":"weak","summary":"weak","evidence":[],"correctionGoal":"improve","suggestedChange":"add examples"}
]}
\`\`\``;

    expect(parseReviewFindings(raw, ["skill_candidate"])).toEqual([]);
    expect(
      parseReviewFindings("not json", ["skill_candidate"]),
    ).toBeUndefined();
  });

  it("rejects findings without a valid operation and target intents", () => {
    const raw = JSON.stringify({
      findings: [
        {
          trigger: "weak_intent",
          hasFinding: true,
          operation: "unknown",
          targetIntentIds: [],
          dedupeKey: "weak",
          summary: "weak",
          evidence: [],
          correctionGoal: "improve",
          suggestedChange: "add examples",
        },
      ],
    });

    expect(parseReviewFindings(raw, ["weak_intent"])).toEqual([]);
  });
});

describe("runReviewSubagent", () => {
  it("runs an isolated tool-free review with the review timeout", async () => {
    const runEmbeddedPiAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: '{"findings":[]}' }],
    });
    const api = {
      config: {},
      runtime: { agent: { runEmbeddedPiAgent } },
    } as unknown as OpenClawPluginApi;

    await runReviewSubagent({
      api,
      config: resolveConfig({
        evolution: {
          enabled: true,
          thinking: "high",
          timeoutMs: 1234,
        },
      }),
      agentId: "main",
      modelRef: { provider: "google", model: "review" },
      snapshot,
      triggers: ["weak_intent"],
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "review",
        timeoutMs: 1234,
        thinkLevel: "high",
        trigger: "manual",
        promptMode: "none",
        disableTools: true,
        toolsAllow: [],
        sessionFile: expect.stringMatching(
          /^\/tmp\/intention-hint-review-.+\.session\.jsonl$/,
        ),
      }),
    );
  });
});
