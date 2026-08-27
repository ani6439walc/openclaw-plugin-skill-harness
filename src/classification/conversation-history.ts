import type {
  ContextWindow,
  HistoricalIntentRecord,
  RecentTurn,
} from "../types.js";

function normalizeTurnText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function attachHistoricalIntents(
  conversation: RecentTurn[],
  records: HistoricalIntentRecord[],
  options: { latestInput?: string } = {},
): RecentTurn[] {
  const enriched = conversation.map((turn) => ({ ...turn }));
  const normalizedLatestInput = options.latestInput
    ? normalizeTurnText(options.latestInput)
    : undefined;
  let firstAttachableIndex = enriched.length - 1;

  for (let index = enriched.length - 1; index >= 0; index--) {
    const turn = enriched[index];
    if (turn.role !== "user") continue;

    if (
      !normalizedLatestInput ||
      normalizeTurnText(turn.text) === normalizedLatestInput
    ) {
      firstAttachableIndex = index - 1;
    }
    break;
  }

  const recordsByInput = new Map<string, HistoricalIntentRecord[]>();
  for (const record of records) {
    const normalizedInput = normalizeTurnText(record.input);
    const matchingRecords = recordsByInput.get(normalizedInput) ?? [];
    matchingRecords.push(record);
    recordsByInput.set(normalizedInput, matchingRecords);
  }

  for (let turnIndex = firstAttachableIndex; turnIndex >= 0; turnIndex--) {
    const turn = enriched[turnIndex];
    if (turn.role !== "user") continue;

    const record = recordsByInput.get(normalizeTurnText(turn.text))?.pop();
    if (!record) continue;
    const historicalIntent: RecentTurn["historicalIntent"] = {
      intent: record.intent,
      domain: record.domain ?? "other",
    };
    if (record.keywords?.length) historicalIntent.keywords = record.keywords;
    if (record.topic) historicalIntent.topic = record.topic;
    if (record.topicChangeReason) {
      historicalIntent.topicChangeReason = record.topicChangeReason;
    }
    turn.historicalIntent = historicalIntent;
  }

  return enriched;
}

export function limitConversationTurns(
  allTurns: RecentTurn[],
  queryMode: "message" | "recent" | "full",
  cWindow: ContextWindow = {
    user: { turns: 5, chars: 220 },
    assistant: { turns: 5, chars: 180 },
  },
): RecentTurn[] {
  if (queryMode === "message") return [];
  if (queryMode === "full") return allTurns;

  const filtered = allTurns.filter((turn) => turn.text.trim().length > 0);
  const truncateTurn = (text: string, limit: number): string => {
    const codePoints = Array.from(normalizeTurnText(text));
    if (codePoints.length <= limit) return codePoints.join("");
    const suffix = Array.from(" (truncated...)");
    if (limit <= suffix.length) return codePoints.slice(0, limit).join("");
    return [
      ...codePoints.slice(0, Math.max(0, limit - suffix.length)),
      ...suffix,
    ].join("");
  };

  let remainingUser = cWindow.user.turns;
  let remainingAssistant = cWindow.assistant.turns;
  const picked: RecentTurn[] = [];
  for (let index = filtered.length - 1; index >= 0; index--) {
    const turn = filtered[index];
    if (turn.role === "user" && remainingUser > 0) {
      remainingUser--;
      picked.unshift({
        ...turn,
        role: turn.role,
        text: truncateTurn(turn.text, cWindow.user.chars),
      });
    } else if (turn.role === "assistant" && remainingAssistant > 0) {
      remainingAssistant--;
      picked.unshift({
        ...turn,
        role: turn.role,
        text: truncateTurn(turn.text, cWindow.assistant.chars),
      });
    }
    if (remainingUser === 0 && remainingAssistant === 0) break;
  }

  return picked;
}
