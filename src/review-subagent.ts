import crypto from "node:crypto";
import { z } from "zod";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import type { EvolutionFinding, ReviewSnapshot } from "./evolution-types.js";
import type { EvolutionTrigger } from "./trigger-checker.js";
import type { ResolvedIntentionHintPluginConfig } from "./types.js";
import { EVOLUTION_OPERATIONS } from "./evolution-backlog.js";
import { extractPayloadText } from "./subagent.js";

const REVIEW_INSTRUCTIONS: Record<
  EvolutionTrigger,
  { focus: string; goal: string }
> = {
  skill_candidate: {
    focus:
      "Identify reusable skills, tools, execution sequences, tips, parameters, and pitfalls that the matched intent Markdown should preserve. Exclude one-off tool usage and capabilities outside the intent boundary.",
    goal: "Refine the matched intent Markdown's Skills & Tools, Concrete Workflow, or Experience section when the sequence or lesson is stable.",
  },
  process_gap: {
    focus:
      "Trace the failed execution and recovery path, then identify which missing intent guideline, tool call example, workflow step, or Experience pitfall would have prevented the gap.",
    goal: "Refine the matched intent Markdown's Guidelines, Skills & Tools, Concrete Workflow, or Experience so future runs follow the successful path.",
  },
  successful_pattern: {
    focus:
      "Identify reusable workflow, tool sequence, skill usage, parameters, and pitfalls from a completed successful turn. Exclude one-off details and do not propose writes outside runtime intent Markdown.",
    goal: "Refine the matched intent Markdown's Experience, Concrete Workflow, or Response Strategy so future runs preserve the successful pattern without interrupting the user.",
  },
  satisfaction_check: {
    focus:
      "Inspect recent turns for dissatisfaction, repeated requests, or routing corrections that reveal an intent boundary, body guidance, or response-strategy problem. Return no_finding without evidence.",
    goal: "Refine the relevant intent Markdown's boundary, examples, Guidelines, or Response Strategy; recommend split or merge only when evidence shows a collision.",
  },
  missing_intent: {
    focus:
      "Extract the uncategorized user goal, its distinguishing boundary, representative trigger descriptions, examples, required skills/tools, and execution strategy. Check that it is not merely a refinement of an existing intent.",
    goal: "Draft a new, narrowly scoped intent Markdown definition that follows the bundled intention-hint Skill format.",
  },
  weak_intent: {
    focus:
      "Explain the classification ambiguity, likely matched intent, neighboring collision, and missing or misleading trigger/example coverage.",
    goal: "Refine the matched intent Markdown frontmatter triggers/examples and clarify its boundary without adding classification prose to the body.",
  },
  behavior_fix: {
    focus:
      "Compare the user correction with the matched intent's routed behavior and identify the specific Markdown instruction that caused, allowed, or failed to prevent the mistake.",
    goal: "Refine the matched intent Markdown's Guidelines, Response Strategy, Skills & Tools, Concrete Workflow, or Experience to encode the corrected behavior.",
  },
};

const INTENT_CRAFT_RUBRIC = `Intent Markdown review rules:
- Decide whether the evidence calls for creating, refining, splitting, or merging an intent. Prefer the smallest maintainable boundary.
- Intent ids come from Markdown filenames without the .md suffix. Frontmatter is classification-only and contains only triggers[] and examples[]. Triggers describe the user goal and boundary; examples are realistic user messages.
- The body guides execution and must use this order: ## Guidelines, ## Skills & Tools, ## Response Strategy, then optional ## Concrete Workflow, then optional ## Experience.
- Put skill hints on an indented "skill: <name>" line beneath a descriptive list item.
- Put concrete tool call shapes in Skills & Tools or workflow steps; do not use vague tool prose.
- Include Concrete Workflow for multi-step or sequence-sensitive intents. Use short numbered "### Step N — <name>" sections.
- Use Experience for reusable tips, parameters, pitfalls, stable skill/tool lessons, and recovery notes that help future turns with the same intent.
- The review subagent may use the read tool to inspect SKILL.md files referenced by the review snapshot's Skills Used paths when the skill description is not enough to judge an intent-local improvement. Read only the relevant SKILL.md files and do not inspect unrelated files.
- For completed reusable workflows, prefer a concise intent-local Experience note or Response Strategy reminder that preserves the pattern in future turns; do not ask the user to record it and do not propose writes outside runtime intent Markdown.
- Recordability filter: the core question is whether the lesson will save future time.
- General workflow lessons are recordable only when they are reusable workflows or decision steps, costly error recovery paths, critical parameters/settings/prerequisites, stable user preference or style rules, multi-attempt successful solutions with failure reasons and success conditions, reusable templates/checklists/formats, or stable external dependency/resource locations.
- General workflow lessons are not recordable when they are one-off Q&A, pure conceptual explanations without concrete steps or decision criteria, or conclusions without specific reusable context.
- Skill/tool experience lessons are recordable only when they capture a skill-specific pitfall and fix, error message or localization path, result-shaping parameter/configuration, reusable prompt/template/workflow, dependency or asset path, project entry point/module location, or required step ordering.
- Skill/tool experience lessons are not recordable when they are pure theory, conclusions without reproducible steps, or one-time non-reusable operations.
- When evidence resembles an external learning entry, distill only the reusable title, context, solution steps, key paths, parameters, and keywords that directly improve the matched intent's Guidelines, Response Strategy, Concrete Workflow, or Experience; do not propose external file formats or writes.
- When the lesson is general knowledge rather than intent-routing guidance, return no_finding unless it directly improves the matched intent's Guidelines, Response Strategy, Concrete Workflow, or Experience.
- Never mention another intent name or id inside an intent body. Express scope boundaries through frontmatter triggers and examples.
- Do not propose changes to skills, tools, AGENTS.md, SOUL.md, or other production files. The only correction target is intent Markdown content.
- Return no finding when the evidence does not justify a concrete intent Markdown improvement.`;

const FindingSchema = z.discriminatedUnion("hasFinding", [
  z.object({
    trigger: z.string(),
    hasFinding: z.literal(false),
  }),
  z.object({
    trigger: z.string(),
    hasFinding: z.literal(true),
    operation: z.enum(EVOLUTION_OPERATIONS),
    targetIntentIds: z.array(z.string().trim().min(1)).min(1).max(10),
    dedupeKey: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    evidence: z.array(z.string().trim().min(1).max(1000)).max(10),
    correctionGoal: z.string().trim().min(1).max(1000),
    suggestedChange: z.string().trim().min(1).max(12000),
  }),
]);

const ReviewResponseSchema = z.object({
  findings: z.array(z.unknown()),
});

function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function escapeSnapshotText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatList(values: readonly string[] | undefined): string {
  if (!values?.length) return "- none";
  return values.map((value) => `- ${escapeSnapshotText(value)}`).join("\n");
}

function formatIntentResult(
  intent: ReviewSnapshot["current"]["intent"],
): string {
  if (!intent) return "- none";
  const lines = [
    `- Intent: ${escapeSnapshotText(intent.intent)}`,
    `- Confidence: ${escapeSnapshotText(intent.confidence)}`,
    `- Complexity: ${escapeSnapshotText(intent.complexity)}`,
    `- Reason: ${escapeSnapshotText(intent.reason)}`,
  ];
  if (intent.topic) lines.push(`- Topic: ${escapeSnapshotText(intent.topic)}`);
  if (intent.keywords?.length) {
    lines.push(
      `- Keywords: ${intent.keywords.map(escapeSnapshotText).join(", ")}`,
    );
  }
  if (intent.suggestion) {
    lines.push(`- Suggestion: ${escapeSnapshotText(intent.suggestion)}`);
  }
  return lines.join("\n");
}

function formatToolCalls(
  toolCalls: ReviewSnapshot["current"]["toolCalls"],
): string {
  if (!toolCalls?.length) return "- none";
  return toolCalls
    .map((call) => {
      const lines = [`- ${escapeSnapshotText(call.name)}`];
      if (call.params && Object.keys(call.params).length > 0) {
        lines.push("  - Params:");
        for (const [key, value] of Object.entries(call.params)) {
          lines.push(
            `    - ${escapeSnapshotText(key)}: ${escapeSnapshotText(value)}`,
          );
        }
      }
      if (call.error)
        lines.push(`  - Error: ${escapeSnapshotText(call.error)}`);
      if (call.durationMs !== undefined) {
        lines.push(`  - Duration: ${call.durationMs}ms`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

function formatSkillsUsed(
  skillsUsed: ReviewSnapshot["current"]["skillsUsed"],
): string {
  if (!skillsUsed?.length) return "- none";
  return skillsUsed
    .map((skill) => {
      const lines = [`- ${escapeSnapshotText(skill.name)}`];
      if (skill.description) {
        lines.push(`  - Description: ${escapeSnapshotText(skill.description)}`);
      }
      lines.push(`  - Path: ${escapeSnapshotText(skill.path)}`);
      return lines.join("\n");
    })
    .join("\n");
}

function formatReviewState(
  title: string,
  state: ReviewSnapshot["current"],
  turnNumber?: number,
): string {
  const lines = [`## ${title}`];
  if (turnNumber !== undefined) lines.push(`- Turn number: ${turnNumber}`);
  if (state.timestamps?.start) {
    lines.push(`- Started at: ${escapeSnapshotText(state.timestamps.start)}`);
  }
  if (state.timestamps?.end) {
    lines.push(`- Ended at: ${escapeSnapshotText(state.timestamps.end)}`);
  }
  lines.push(
    "",
    "### User Input",
    escapeSnapshotText(state.input || "none"),
    "",
    "### Intent Result",
    formatIntentResult(state.intent),
    "",
    "### Skills Used",
    formatSkillsUsed(state.skillsUsed),
    "",
    "### Tool Calls",
    formatToolCalls(state.toolCalls),
    "",
    "### Assistant Result",
    escapeSnapshotText(state.result || "none"),
  );
  if (state.error) {
    lines.push("", "### Agent Error", escapeSnapshotText(state.error));
  }
  return lines.join("\n");
}

function formatMatchedIntent(snapshot: ReviewSnapshot): string {
  const intent = snapshot.matchedIntent;
  if (!intent) return "## Matched Intent\n- none";
  return [
    "## Matched Intent",
    `- ID: ${escapeSnapshotText(intent.id)}`,
    "",
    "### Triggers",
    formatList(intent.definition.triggers),
    "",
    "### Examples",
    formatList(intent.definition.examples),
    "",
    "### Body",
    escapeSnapshotText(intent.definition.prompt || "none"),
  ].join("\n");
}

function formatIntentCatalog(snapshot: ReviewSnapshot): string {
  if (snapshot.intentCatalog.length === 0) return "## Intent Catalog\n- none";
  return [
    "## Intent Catalog",
    ...snapshot.intentCatalog.map((entry) =>
      [
        `### ${escapeSnapshotText(entry.id)}`,
        "Triggers:",
        formatList(entry.triggers),
        "Examples:",
        formatList(entry.examples),
      ].join("\n"),
    ),
  ].join("\n\n");
}

export function formatReviewSnapshot(snapshot: ReviewSnapshot): string {
  const recent = snapshot.recent.length
    ? snapshot.recent
        .map((state, index) =>
          formatReviewState(`Recent Turn ${index + 1}`, state),
        )
        .join("\n\n")
    : "## Recent Turns\n- none";

  return [
    "<review_snapshot>",
    formatReviewState("Current Turn", snapshot.current, snapshot.turnNumber),
    recent,
    formatMatchedIntent(snapshot),
    formatIntentCatalog(snapshot),
    "</review_snapshot>",
  ].join("\n\n");
}

export function buildReviewPrompt(
  snapshot: ReviewSnapshot,
  triggers: readonly EvolutionTrigger[],
): string {
  const triggerPrompts = triggers
    .map((trigger) => {
      const instruction = REVIEW_INSTRUCTIONS[trigger];
      return `${trigger}: Review focus: ${instruction.focus}\nCorrection goal: ${instruction.goal}`;
    })
    .join("\n\n");

  return `You are an Intent Evolution reviewer.
Your sole purpose is to improve the content and routing quality of intention-hint intents/*.md files.
Review only the requested triggers. Each trigger is independent and may return hasFinding=false.
Do not invent evidence. Do not modify files; propose intent Markdown drafts or patches only.
Use reviewSnapshot.matchedIntent as the source of truth for the current intent Markdown.
Use reviewSnapshot.intentCatalog only to detect coverage gaps, overlaps, and boundary collisions.
If matchedIntent is absent, propose a new intent only when the evidence is not already covered by intentCatalog.

${INTENT_CRAFT_RUBRIC}

Requested trigger reviews:
${triggerPrompts}

Return JSON only:
{"findings":[{"trigger":"skill_candidate","hasFinding":true,"operation":"refine","targetIntentIds":["productivity"],"dedupeKey":"stable-short-key","summary":"...","evidence":["..."],"correctionGoal":"...","suggestedChange":"..."},{"trigger":"process_gap","hasFinding":false}]}

For every hasFinding=true item:
- correctionGoal must name the intent Markdown outcome.
- operation must be create, refine, split, or merge.
- targetIntentIds must list every existing or proposed intent ID affected by the change.
- suggestedChange must be a concrete intent Markdown draft or patch instruction, including the exact triggers/examples or body sections to add/change.

Review snapshot:
${formatReviewSnapshot(snapshot)}`;
}

export function parseReviewFindings(
  raw: string,
  requestedTriggers: readonly EvolutionTrigger[],
): EvolutionFinding[] | undefined {
  try {
    const parsed = ReviewResponseSchema.parse(JSON.parse(stripCodeFence(raw)));
    const requested = new Set<string>(requestedTriggers);
    return parsed.findings.flatMap((rawFinding) => {
      const result = FindingSchema.safeParse(rawFinding);
      if (!result.success) return [];
      const finding = result.data;
      if (!finding.hasFinding || !requested.has(finding.trigger)) return [];
      return [
        {
          trigger: finding.trigger as EvolutionTrigger,
          operation: finding.operation,
          targetIntentIds: finding.targetIntentIds,
          dedupeKey: finding.dedupeKey,
          summary: finding.summary,
          evidence: finding.evidence,
          correctionGoal: finding.correctionGoal,
          suggestedChange: finding.suggestedChange,
        },
      ];
    });
  } catch {
    return;
  }
}

export async function runReviewSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedIntentionHintPluginConfig;
  agentId: string;
  sessionKey?: string;
  messageProvider?: string;
  modelRef: { provider: string; model: string };
  snapshot: ReviewSnapshot;
  triggers: readonly EvolutionTrigger[];
}): Promise<EvolutionFinding[] | undefined> {
  const runId = `intention-hint-review-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const suffix = crypto
    .createHash("sha1")
    .update(params.snapshot.eventId)
    .digest("hex")
    .slice(0, 12);
  const sessionKey = params.sessionKey
    ? `${params.sessionKey}:intention-hint-review:${suffix}`
    : `agent:${params.agentId}:intention-hint-review:${suffix}`;

  try {
    const result = await params.api.runtime.agent.runEmbeddedPiAgent({
      sessionId: runId,
      sessionKey,
      agentId: params.agentId,
      messageProvider: params.messageProvider,
      config: params.api.config,
      prompt: buildReviewPrompt(params.snapshot, params.triggers),
      provider: params.modelRef.provider,
      model: params.modelRef.model,
      timeoutMs: params.config.evolution.timeoutMs,
      runId,
      workspaceDir: "/tmp",
      agentDir: "/tmp",
      sessionFile: `/tmp/${runId}.session.jsonl`,
      trigger: "manual",
      modelRun: false,
      promptMode: "none",
      toolsAllow: ["read"],
      disableTools: false,
      disableMessageTool: true,
      allowGatewaySubagentBinding: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      thinkLevel: params.config.evolution.thinking,
      reasoningLevel: "off",
      silentExpected: true,
      authProfileFailurePolicy: "local",
      cleanupBundleMcpOnRunEnd: true,
    });
    const rawReply = extractPayloadText(result);
    const findings = parseReviewFindings(rawReply, params.triggers);
    if (!findings) {
      logger.warn("evolution review result parse failed", { rawReply });
    }
    return findings;
  } catch (err) {
    logger.warn("evolution review subagent error", { error: err });
    return;
  }
}
