import type { AvailableSkill } from "../types.js";
import { indentXmlLines } from "../xml-format.js";
import {
  projectIntentCatalog,
  type CatalogProjection,
} from "./catalog-projection.js";
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
  | "current_turn"
  | "recent_turn"
  | "recent_turns"
  | "turn_metadata"
  | "user_input"
  | "intent_metadata"
  | "skills_used"
  | "tool_calls"
  | "assistant_result"
  | "assistant_result_omission"
  | "agent_error"
  | "matched_intent"
  | "intent_body"
  | "skill"
  | "name"
  | "description"
  | "path"
  | "available_skills"
  | "intent_catalog";

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

function formatIntentMetadata(
  intent: ReviewSnapshot["current"]["intent"],
): string {
  if (!intent) return "";
  const metadata: Record<string, unknown> = {};
  addDefined(metadata, "intent", intent.intent);
  addDefined(metadata, "domain", intent.domain);
  addDefined(metadata, "confidence", intent.confidence);
  addDefined(metadata, "complexity", intent.complexity);
  addDefined(metadata, "reason", intent.reason);
  addDefined(metadata, "topic", intent.topic);
  addDefined(metadata, "keywords", intent.keywords);
  addDefined(metadata, "topicChangeReason", intent.topicChangeReason);
  addDefined(metadata, "suggestion", intent.suggestion);
  return stringifySnapshotJson(metadata);
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

function formatAvailableSkills(skills: readonly AvailableSkill[] | undefined) {
  return wrapOptionalReviewSnapshotBlock(
    "available_skills",
    skills
      ?.map((skill) =>
        formatSkill({
          name: skill.name,
          description: skill.description,
          path: skill.location,
        }),
      )
      .join("\n") ?? "",
  );
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

  const fields = [
    wrapOptionalReviewSnapshotBlock(
      "turn_metadata",
      Object.keys(metadata).length > 0 ? stringifySnapshotJson(metadata) : "",
    ),
    wrapOptionalReviewSnapshotBlock(
      "user_input",
      state.input?.trim() ? escapeSnapshotText(state.input) : "",
    ),
    wrapOptionalReviewSnapshotBlock(
      "intent_metadata",
      formatIntentMetadata(state.intent),
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

function formatMatchedIntent(snapshot: ReviewSnapshot): string | undefined {
  const intent = snapshot.matchedIntent;
  if (!intent) return undefined;
  return wrapRequiredReviewSnapshotBlock(
    "matched_intent",
    [
      wrapRequiredReviewSnapshotBlock(
        "intent_metadata",
        stringifySnapshotJson(formatIntentEntryMetadata(intent)),
      ),
      wrapOptionalReviewSnapshotBlock(
        "intent_body",
        intent.definition.prompt.trim()
          ? escapeSnapshotText(intent.definition.prompt)
          : "",
      ),
    ]
      .filter((field): field is string => field !== undefined)
      .join("\n\n"),
  );
}

function formatIntentEntryMetadata(
  entry:
    ReviewSnapshot["intentCatalog"][number] | ReviewSnapshot["matchedIntent"],
  selectionReasons?: CatalogProjection["entries"][number]["selectionReasons"],
): Record<string, unknown> {
  if (!entry) return {};
  const definition = "definition" in entry ? entry.definition : entry;
  const metadata: Record<string, unknown> = {
    id: entry.id,
    domain: definition.domain ?? null,
  };
  metadata.triggers = [...definition.triggers];
  metadata.examples = [...definition.examples];
  const fastpath = definition.fastpath;
  if (fastpath) {
    metadata.fastpath = {
      keywords: [...fastpath.keywords],
      ...(fastpath.hint !== undefined ? { hint: fastpath.hint } : {}),
    };
  }
  const candidate = definition.candidate;
  if (candidate) {
    metadata.candidate = {
      ...(candidate.scope !== undefined ? { scope: candidate.scope } : {}),
      ...(candidate.keywords !== undefined
        ? { keywords: [...candidate.keywords] }
        : {}),
    };
  }
  if (selectionReasons) metadata.selectionReasons = [...selectionReasons];
  return metadata;
}

function formatIntentCatalog(
  projection: CatalogProjection,
): string | undefined {
  return wrapOptionalReviewSnapshotBlock(
    "intent_catalog",
    projection.entries
      .map(
        ({ entry, selectionReasons }) =>
          `<intent>${stringifySnapshotJson(
            formatIntentEntryMetadata(entry, selectionReasons),
          )}</intent>`,
      )
      .join("\n"),
  );
}

interface FormatReviewSnapshotOptions {
  includeIntentCatalog?: boolean;
  requestedTriggers?: readonly ReviewTrigger[];
}

function formatSnapshotManifest(
  snapshot: ReviewSnapshot,
  options: FormatReviewSnapshotOptions,
  availableSkillRenderedCodePointCount: number,
  catalogProjection:
    | CatalogProjection
    | {
        mode: "omitted";
        originalCount: number;
        includedCount: 0;
        omittedCount: number;
      },
): string {
  const intentCatalog: Record<string, unknown> = {
    mode: catalogProjection.mode,
    originalCount: catalogProjection.originalCount,
    includedCount: catalogProjection.includedCount,
    omittedCount: catalogProjection.omittedCount,
  };
  if ("fallbackReason" in catalogProjection) {
    intentCatalog.fallbackReason = catalogProjection.fallbackReason;
  }
  const manifest = {
    requestedTriggers: [...(options.requestedTriggers ?? [])],
    currentIntent: snapshot.current.intent?.intent ?? null,
    intentConfidence: snapshot.current.intent?.confidence ?? null,
    recentTurnCount: snapshot.recent.length,
    currentSkillsUsedCount: snapshot.current.skillsUsed?.length ?? 0,
    currentToolCallCount: snapshot.current.toolCalls?.length ?? 0,
    availableSkillCount: snapshot.availableSkills?.length ?? 0,
    availableSkillRenderedCodePointCount,
    matchedIntentPresent: snapshot.matchedIntent !== undefined,
    intentCatalog,
  };
  return wrapRequiredReviewSnapshotBlock(
    "snapshot_manifest",
    stringifySnapshotJson(manifest),
  );
}

export function formatReviewSnapshot(
  snapshot: ReviewSnapshot,
  options: FormatReviewSnapshotOptions = {},
): string {
  const catalogProjection =
    options.includeIntentCatalog === false
      ? undefined
      : projectIntentCatalog(snapshot, options.requestedTriggers ?? []);
  const catalogManifest = catalogProjection ?? {
    mode: "omitted" as const,
    originalCount: snapshot.intentCatalog.length,
    includedCount: 0 as const,
    omittedCount: snapshot.intentCatalog.length,
  };
  const availableSkills = formatAvailableSkills(snapshot.availableSkills);
  const recent = wrapOptionalReviewSnapshotBlock(
    "recent_turns",
    snapshot.recent
      .map((state, index) =>
        formatReviewState("recent_turn", state, { recentIndex: index + 1 }),
      )
      .join("\n"),
  );

  const blocks = [
    formatSnapshotManifest(
      snapshot,
      options,
      availableSkills ? Array.from(indentXmlLines(availableSkills)).length : 0,
      catalogManifest,
    ),
    formatReviewState("current_turn", snapshot.current, {
      turnNumber: snapshot.turnNumber,
    }),
    formatMatchedIntent(snapshot),
    recent,
    availableSkills,
    catalogProjection ? formatIntentCatalog(catalogProjection) : undefined,
  ]
    .filter((block): block is string => block !== undefined)
    .join("\n\n");
  return wrapRequiredReviewSnapshotBlock("review_snapshot", blocks);
}
