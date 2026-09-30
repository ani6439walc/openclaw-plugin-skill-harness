import type { ContextWindow, RecentTurn } from "../types.js";
import {
  DEFAULT_RECENT_USER_TURNS,
  DEFAULT_RECENT_USER_CHARS,
  DEFAULT_RECENT_ASSISTANT_TURNS,
  DEFAULT_RECENT_ASSISTANT_CHARS,
} from "../constants.js";

function normalizeTurnText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function limitConversationTurns(
  allTurns: RecentTurn[],
  queryMode: "message" | "recent" | "full",
  cWindow: ContextWindow = {
    user: {
      turns: DEFAULT_RECENT_USER_TURNS,
      chars: DEFAULT_RECENT_USER_CHARS,
    },
    assistant: {
      turns: DEFAULT_RECENT_ASSISTANT_TURNS,
      chars: DEFAULT_RECENT_ASSISTANT_CHARS,
    },
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
