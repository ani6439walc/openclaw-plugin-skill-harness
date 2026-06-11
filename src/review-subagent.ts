import crypto from "node:crypto";
import { z } from "zod";
import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import type { EvolutionFinding, ReviewSnapshot } from "./evolution-types.js";
import type { EvolutionTrigger } from "./trigger-checker.js";
import type { ResolvedIntentionHintPluginConfig } from "./types.js";

const REVIEW_INSTRUCTIONS: Record<
  EvolutionTrigger,
  { focus: string; goal: string }
> = {
  skill_candidate: {
    focus:
      "Identify reusable skills, tools, and execution sequences that the matched intent Markdown should route to. Exclude one-off tool usage and capabilities outside the intent boundary.",
    goal: "Refine the matched intent Markdown's Skills & Tools section and add or improve Concrete Workflow steps when the sequence is stable.",
  },
  process_gap: {
    focus:
      "Trace the failed execution and recovery path, then identify which missing intent guideline, tool call example, or workflow step would have prevented the gap.",
    goal: "Refine the matched intent Markdown's Guidelines, Skills & Tools, or Concrete Workflow so future runs follow the successful path.",
  },
  satisfaction_check: {
    focus:
      "Inspect recent turns for dissatisfaction, repeated requests, or routing corrections that reveal an intent boundary, body guidance, or response-strategy problem. Return no_finding without evidence.",
    goal: "Refine the relevant intent Markdown's boundary, examples, Guidelines, or Response Strategy; recommend split or merge only when evidence shows a collision.",
  },
  missing_intent: {
    focus:
      "Extract the uncategorized user goal, its distinguishing boundary, representative trigger descriptions, examples, required skills/tools, and execution strategy. Check that it is not merely a refinement of an existing intent.",
    goal: "Draft a new, narrowly scoped intent Markdown definition that follows the intent-craft format.",
  },
  weak_intent: {
    focus:
      "Explain the classification ambiguity, likely matched intent, neighboring collision, and missing or misleading trigger/example coverage.",
    goal: "Refine the matched intent Markdown frontmatter triggers/examples and clarify its boundary without adding classification prose to the body.",
  },
  behavior_fix: {
    focus:
      "Compare the user correction with the matched intent's routed behavior and identify the specific Markdown instruction that caused, allowed, or failed to prevent the mistake.",
    goal: "Refine the matched intent Markdown's Guidelines, Response Strategy, Skills & Tools, or Concrete Workflow to encode the corrected behavior.",
  },
};

const INTENT_CRAFT_RUBRIC = `Intent Markdown review rules:
- Decide whether the evidence calls for creating, refining, splitting, or merging an intent. Prefer the smallest maintainable boundary.
- Frontmatter is classification-only: id, name, enabled: true, triggers[], and examples[]. Triggers describe the user goal and boundary; examples are realistic user messages.
- The body guides execution and must use this order: detection line, ## Guidelines, ## Skills & Tools, ## Response Strategy, then optional ## Concrete Workflow.
- Put skill hints on an indented "skill: <name>" line beneath a descriptive list item.
- Put concrete tool call shapes in Skills & Tools or workflow steps; do not use vague tool prose.
- Include Concrete Workflow for multi-step or sequence-sensitive intents. Use short numbered "### Step N — <name>" sections.
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

  return `You are an Intent Self-Evolution reviewer.
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
{"findings":[{"trigger":"skill_candidate","hasFinding":true,"dedupeKey":"stable-short-key","summary":"...","evidence":["..."],"correctionGoal":"...","suggestedChange":"..."},{"trigger":"process_gap","hasFinding":false}]}

For every hasFinding=true item:
- correctionGoal must name the intent Markdown outcome.
- suggestedChange must be a concrete intent Markdown draft or patch instruction, including the exact frontmatter fields or body sections to add/change.

Review snapshot:
${JSON.stringify(snapshot)}`;
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
      timeoutMs: params.config.selfEvolution.reviewTimeoutMs,
      runId,
      workspaceDir: "/tmp",
      agentDir: "/tmp",
      sessionFile: "/tmp/session.jsonl",
      trigger: "manual",
      modelRun: true,
      promptMode: "none",
      toolsAllow: [],
      disableTools: true,
      disableMessageTool: true,
      allowGatewaySubagentBinding: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      thinkLevel: "off",
      reasoningLevel: "off",
      silentExpected: true,
      authProfileFailurePolicy: "local",
      cleanupBundleMcpOnRunEnd: true,
    });
    const rawReply = ((result.payloads ?? []) as { text?: string }[])
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
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
