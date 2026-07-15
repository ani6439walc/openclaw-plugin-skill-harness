interface ToolTraceCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError: boolean;
}

interface ValidateInstructionSkillEvidenceParams {
  additionalCandidateSkills: readonly string[];
  availableSkillNames: readonly string[];
  transcript: string;
  toolSummary?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return;
  }
}

function messageFromLine(line: string): Record<string, unknown> | undefined {
  const entry = parseJsonRecord(line);
  if (entry?.type !== "message") return;
  return asRecord(entry.message);
}

function textContent(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseToolTrace(transcript: string): ToolTraceCall[] {
  const calls: ToolTraceCall[] = [];
  const callsById = new Map<string, ToolTraceCall>();

  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const message = messageFromLine(line);
    if (!message) continue;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const record = asRecord(block);
        if (record?.type !== "toolCall") continue;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : "";
        const args =
          parseJsonRecord(record.arguments) ??
          parseJsonRecord(record.input) ??
          {};
        if (!id || !name || callsById.has(id)) continue;
        const call: ToolTraceCall = {
          id,
          name,
          arguments: args,
          isError: false,
        };
        calls.push(call);
        callsById.set(id, call);
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const toolCallId =
      typeof message.toolCallId === "string" ? message.toolCallId.trim() : "";
    const call = callsById.get(toolCallId);
    if (!call) continue;
    call.isError = message.isError === true;
    call.result = parseJsonRecord(textContent(message));
  }

  return calls;
}

function parseToolSummary(
  value: unknown,
): { calls: number; tools: string[]; failures: number } | undefined {
  const record = asRecord(value);
  if (!record) return;
  const calls = record.calls;
  const failures = record.failures;
  if (
    typeof calls !== "number" ||
    !Number.isInteger(calls) ||
    calls < 0 ||
    typeof failures !== "number" ||
    !Number.isInteger(failures) ||
    failures < 0 ||
    !Array.isArray(record.tools) ||
    !record.tools.every((tool) => typeof tool === "string" && tool.trim())
  ) {
    return;
  }
  return {
    calls,
    failures,
    tools: record.tools.map((tool) => (tool as string).trim()),
  };
}

function uniqueToolNames(calls: readonly ToolTraceCall[]): string[] {
  return [...new Set(calls.map((call) => call.name))];
}

function successfulViewName(call: ToolTraceCall): string | undefined {
  if (
    call.name !== "skill_view" ||
    call.isError ||
    call.result?.success !== true
  ) {
    return;
  }
  if (normalizedName(call.arguments.file_path)) return;
  const argumentName = normalizedName(call.arguments.name);
  const resultName = normalizedName(call.result.name);
  return argumentName && argumentName === resultName ? resultName : undefined;
}

function successfulSearchNames(call: ToolTraceCall): Set<string> | undefined {
  if (
    call.name !== "skill_search" ||
    call.isError ||
    call.arguments.limit !== 3 ||
    call.result?.success !== true ||
    !Array.isArray(call.result.skills)
  ) {
    return;
  }
  const names = call.result.skills
    .map((skill) => normalizedName(asRecord(skill)?.name))
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

export function validateInstructionSkillEvidence(
  params: ValidateInstructionSkillEvidenceParams,
): boolean {
  if (params.additionalCandidateSkills.length > 1) return false;
  const additional: string[] = [];
  for (const candidate of params.additionalCandidateSkills) {
    const normalized = normalizedName(candidate);
    if (!normalized) return false;
    additional.push(normalized);
  }
  const available = new Set(
    params.availableSkillNames
      .map(normalizedName)
      .filter((name): name is string => Boolean(name)),
  );
  const calls = parseToolTrace(params.transcript);
  const summary = parseToolSummary(params.toolSummary);

  if (!summary) return calls.length === 0 && additional.length === 0;
  if (
    summary.failures !== 0 ||
    summary.calls !== calls.length ||
    summary.tools.join("\n") !== uniqueToolNames(calls).join("\n")
  ) {
    return false;
  }

  if (calls.length === 0) return additional.length === 0;

  if (calls.length === 1) {
    const viewedName = successfulViewName(calls[0]);
    return Boolean(
      viewedName && available.has(viewedName) && additional.length === 0,
    );
  }

  if (calls.length !== 2) return false;
  const searchNames = successfulSearchNames(calls[0]);
  const viewedName = successfulViewName(calls[1]);
  if (!searchNames || !viewedName || !searchNames.has(viewedName)) return false;
  if (additional.length === 0) return true;
  return (
    additional.length === 1 &&
    additional[0] === viewedName &&
    !available.has(viewedName)
  );
}
