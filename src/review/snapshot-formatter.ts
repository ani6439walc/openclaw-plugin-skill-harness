import { indentXmlLines } from "../xml-format.js";
import type { ReviewTrigger } from "./triggers.js";
import type { ReviewSnapshot } from "./types.js";

function escapeSnapshotText(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type ReviewSnapshotBlockName =
  | "review_snapshot"
  | "snapshot_manifest"
  | "skill_placement_candidate"
  | "selected_placement_skill"
  | "skill_metadata"
  | "skill_content"
  | "current_turn"
  | "recent_turn"
  | "recent_turns"
  | "turn_metadata"
  | "user_input"
  | "skills_used"
  | "tool_calls"
  | "assistant_result"
  | "assistant_result_omission"
  | "agent_error"
  | "skill"
  | "name"
  | "description"
  | "path";

function wrapRequiredReviewSnapshotBlock(
  name: ReviewSnapshotBlockName,
  content: string,
  attributes = "",
): string {
  if (!content.trim()) return `<${name}${attributes}>\n</${name}>`;
  return `<${name}${attributes}>\n${indentXmlLines(content)}\n</${name}>`;
}

function wrapOptionalReviewSnapshotBlock(
  name: ReviewSnapshotBlockName,
  content: string,
): string | undefined {
  if (!content.trim()) return undefined;
  return wrapRequiredReviewSnapshotBlock(name, content);
}

function stringifySnapshotJson(value: unknown): string {
  return escapeSnapshotText(JSON.stringify(value));
}

function addDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

type SnapshotToolCall = NonNullable<
  ReviewSnapshot["current"]["toolCalls"]
>[number];

const GROUPABLE_TOOL_NAMES = new Set([
  "read",
  "skill_list",
  "skill_search",
  "skill_view",
]);

function canonicalToolParams(params: SnapshotToolCall["params"]) {
  return Object.fromEntries(
    Object.entries(params ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function toolGroupingKey(call: SnapshotToolCall): string | undefined {
  if (call.success !== true || !GROUPABLE_TOOL_NAMES.has(call.name)) {
    return undefined;
  }
  return JSON.stringify([call.name, canonicalToolParams(call.params)]);
}

function formatSingleToolCall(call: SnapshotToolCall): string {
  const metadata: Record<string, unknown> = {
    kind: "single",
    name: call.name,
  };
  if (call.params && Object.keys(call.params).length > 0) {
    metadata.params = call.params;
  }
  addDefined(metadata, "error", call.error);
  addDefined(metadata, "durationMs", call.durationMs);
  return `<tool_call>${stringifySnapshotJson(metadata)}</tool_call>`;
}

function formatGroupedToolCall(calls: SnapshotToolCall[]): string {
  const first = calls[0]!;
  const knownDurations = calls
    .map((call) => call.durationMs)
    .filter(
      (duration): duration is number =>
        typeof duration === "number" && Number.isFinite(duration),
    );
  const durationMs: Record<string, number> = {
    knownCount: knownDurations.length,
    originalCount: calls.length,
  };
  if (knownDurations.length > 0) {
    durationMs.min = Math.min(...knownDurations);
    durationMs.max = Math.max(...knownDurations);
  }
  const metadata: Record<string, unknown> = {
    kind: "group",
    name: first.name,
  };
  const params = canonicalToolParams(first.params);
  if (Object.keys(params).length > 0) metadata.params = params;
  metadata.callCount = calls.length;
  metadata.durationMs = durationMs;
  return `<tool_call>${stringifySnapshotJson(metadata)}</tool_call>`;
}

function formatToolCalls(
  toolCalls: ReviewSnapshot["current"]["toolCalls"],
): string {
  if (!toolCalls?.length) return "";

  const entries: string[] = [];
  let groupedRunCount = 0;
  for (let index = 0; index < toolCalls.length;) {
    const call = toolCalls[index]!;
    const key = toolGroupingKey(call);
    if (key === undefined) {
      entries.push(formatSingleToolCall(call));
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < toolCalls.length && toolGroupingKey(toolCalls[end]!) === key) {
      end += 1;
    }
    const run = toolCalls.slice(index, end);
    if (run.length >= 3) {
      entries.push(formatGroupedToolCall(run));
      groupedRunCount += 1;
    } else {
      entries.push(...run.map(formatSingleToolCall));
    }
    index = end;
  }

  if (groupedRunCount === 0) return entries.join("\n");
  const projection = {
    originalCallCount: toolCalls.length,
    renderedEntryCount: entries.length,
    collapsedCallCount: toolCalls.length - entries.length,
    groupedRunCount,
  };
  return [
    `<tool_call_projection>${stringifySnapshotJson(projection)}</tool_call_projection>`,
    ...entries,
  ].join("\n");
}

function formatSkill(skill: {
  name: string;
  description?: string;
  path: string;
}): string {
  return wrapRequiredReviewSnapshotBlock(
    "skill",
    [
      formatSkillTextElement("name", skill.name),
      skill.description
        ? formatSkillTextElement("description", skill.description)
        : undefined,
      formatSkillTextElement("path", skill.path),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
}

function formatSkillTextElement(
  name: "name" | "description" | "path",
  value: string,
): string {
  const content = escapeSnapshotText(value).replaceAll("\r", "&#xD;");
  return content.includes("\n")
    ? wrapRequiredReviewSnapshotBlock(name, content)
    : `<${name}>${content}</${name}>`;
}

function formatSkillsUsed(
  skillsUsed: ReviewSnapshot["current"]["skillsUsed"],
): string {
  return skillsUsed?.map(formatSkill).join("\n") ?? "";
}

const RECENT_RESULT_HEAD_CODE_POINTS = 500;
const RECENT_RESULT_TAIL_CODE_POINTS = 500;
const RECENT_RESULT_MAX_CODE_POINTS =
  RECENT_RESULT_HEAD_CODE_POINTS + RECENT_RESULT_TAIL_CODE_POINTS;

function formatAssistantResult(
  result: string | undefined,
  recent: boolean,
): string {
  if (!result) return "";
  if (!recent) return escapeSnapshotText(result);

  const codePoints = Array.from(result);
  if (codePoints.length <= RECENT_RESULT_MAX_CODE_POINTS) {
    return escapeSnapshotText(result);
  }

  const omittedCodePointCount =
    codePoints.length - RECENT_RESULT_MAX_CODE_POINTS;
  return [
    escapeSnapshotText(
      codePoints.slice(0, RECENT_RESULT_HEAD_CODE_POINTS).join(""),
    ),
    wrapRequiredReviewSnapshotBlock(
      "assistant_result_omission",
      stringifySnapshotJson({ omittedCodePointCount }),
    ),
    escapeSnapshotText(
      codePoints.slice(-RECENT_RESULT_TAIL_CODE_POINTS).join(""),
    ),
  ].join("\n");
}

function formatReviewState(
  blockName: "current_turn" | "recent_turn",
  state: ReviewSnapshot["current"],
  options: { turnNumber?: number; recentIndex?: number } = {},
): string {
  const metadata: Record<string, unknown> = {};
  addDefined(metadata, "turnNumber", options.turnNumber);
  addDefined(metadata, "startedAt", state.timestamps?.start);
  addDefined(metadata, "endedAt", state.timestamps?.end);
  addDefined(metadata, "confidence", state.confidence);
  addDefined(metadata, "matchedSkills", state.matchedSkills);
  addDefined(metadata, "matchedExperiences", state.matchedExperiences);
  addDefined(metadata, "capabilityFit", state.capabilityFit);

  const fields = [
    wrapOptionalReviewSnapshotBlock(
      "turn_metadata",
      Object.keys(metadata).length > 0 ? stringifySnapshotJson(metadata) : "",
    ),
    wrapOptionalReviewSnapshotBlock(
      "user_input",
      state.input?.trim() ? escapeSnapshotText(state.input) : "",
    ),
    state.skillsUsed?.length
      ? wrapRequiredReviewSnapshotBlock(
          "skills_used",
          formatSkillsUsed(state.skillsUsed),
        )
      : undefined,
    wrapOptionalReviewSnapshotBlock(
      "tool_calls",
      formatToolCalls(state.toolCalls),
    ),
    wrapOptionalReviewSnapshotBlock(
      "assistant_result",
      formatAssistantResult(state.result, blockName === "recent_turn"),
    ),
  ].filter((field): field is string => field !== undefined);
  if (state.error?.trim()) {
    fields.push(
      wrapRequiredReviewSnapshotBlock(
        "agent_error",
        escapeSnapshotText(state.error),
      ),
    );
  }
  const content = fields.join("\n\n");
  if (blockName === "recent_turn") {
    return wrapRequiredReviewSnapshotBlock(
      "recent_turn",
      content,
      ` index="${options.recentIndex}"`,
    );
  }
  return wrapRequiredReviewSnapshotBlock("current_turn", content);
}

interface FormatReviewSnapshotOptions {
  requestedTriggers?: readonly ReviewTrigger[];
}

function formatSnapshotManifest(
  snapshot: ReviewSnapshot,
  options: FormatReviewSnapshotOptions,
): string {
  const manifest: Record<string, unknown> = {
    requestedTriggers: [...(options.requestedTriggers ?? [])],
    recentTurnCount: snapshot.recent.length,
    currentSkillsUsedCount: snapshot.current.skillsUsed?.length ?? 0,
    currentToolCallCount: snapshot.current.toolCalls?.length ?? 0,
  };
  return wrapRequiredReviewSnapshotBlock(
    "snapshot_manifest",
    stringifySnapshotJson(manifest),
  );
}

function formatSkillPlacementCandidate(
  candidate: ReviewSnapshot["skillPlacementCandidate"],
): string | undefined {
  if (!candidate) return undefined;
  return wrapRequiredReviewSnapshotBlock(
    "skill_placement_candidate",
    stringifySnapshotJson({
      name: candidate.name,
      source: candidate.source,
      reason: candidate.reason,
      observedTurns: candidate.observedTurns,
      usageTurns: candidate.usageTurns,
      ...(candidate.adoptionRate !== undefined
        ? { adoptionRate: candidate.adoptionRate }
        : {}),
    }),
  );
}

function formatSelectedPlacementSkill(
  skill: ReviewSnapshot["selectedPlacementSkill"],
): string | undefined {
  if (!skill) return undefined;
  return wrapRequiredReviewSnapshotBlock(
    "selected_placement_skill",
    [
      wrapRequiredReviewSnapshotBlock(
        "skill_metadata",
        stringifySnapshotJson({
          name: skill.name,
          description: skill.description,
          ...(skill.omittedCodePointCount !== undefined
            ? { omittedCodePointCount: skill.omittedCodePointCount }
            : {}),
        }),
      ),
      wrapRequiredReviewSnapshotBlock(
        "skill_content",
        escapeSnapshotText(skill.content),
      ),
    ].join("\n\n"),
  );
}

export function formatReviewSnapshot(
  snapshot: ReviewSnapshot,
  options: FormatReviewSnapshotOptions = {},
): string {
  const recent = wrapOptionalReviewSnapshotBlock(
    "recent_turns",
    snapshot.recent
      .map((state, index) =>
        formatReviewState("recent_turn", state, { recentIndex: index + 1 }),
      )
      .join("\n"),
  );
  const blocks = [
    formatSnapshotManifest(snapshot, options),
    formatReviewState("current_turn", snapshot.current, {
      turnNumber: snapshot.turnNumber,
    }),
    recent,
    formatSkillPlacementCandidate(snapshot.skillPlacementCandidate),
    formatSelectedPlacementSkill(snapshot.selectedPlacementSkill),
  ]
    .filter((block): block is string => block !== undefined)
    .join("\n\n");
  return wrapRequiredReviewSnapshotBlock("review_snapshot", blocks);
}
