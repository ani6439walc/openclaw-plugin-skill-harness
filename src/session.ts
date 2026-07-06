import type { OpenClawPluginApi } from "../api.js";
import { logger } from "../api.js";
import type { ResolvedSkillHarnessPluginConfig } from "./types.js";

export function isEnabledForAgent(
  config: ResolvedSkillHarnessPluginConfig,
  agentId: string | undefined,
): boolean {
  if (!agentId) return false;
  return config.agents.includes(agentId);
}

export function isEligibleInteractiveSession(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
}): boolean {
  if (ctx.trigger !== "user") return false;
  if (ctx.sessionKey && ctx.sessionKey.trim().length > 0) return true;
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  if (provider === "webchat") return true;
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

function isDreamingSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts[2]?.startsWith("dreaming-") === true;
}

export function shouldSkipIntentAnalysis(ctx: {
  trigger?: string;
  sessionKey?: string;
  sessionId?: string;
}): boolean {
  const sessionKey = (ctx.sessionKey ?? "").trim().toLowerCase();
  const sessionId = (ctx.sessionId ?? "").trim().toLowerCase();

  if (ctx.trigger && ctx.trigger !== "user") return true;

  return (
    sessionKey.includes(":active-memory:") ||
    isDreamingSessionKey(sessionKey) ||
    sessionKey.includes(":skill-harness:") ||
    sessionKey.includes(":subagent:") ||
    sessionId.startsWith("active-memory-") ||
    sessionId.startsWith("skill-harness-")
  );
}

function resolveChatType(ctx: {
  sessionKey?: string;
  messageProvider?: string;
  channelId?: string;
  mainKey?: string;
}): string | undefined {
  const sessionKey = ctx.sessionKey?.trim().toLowerCase();
  if (sessionKey) {
    if (
      sessionKey.startsWith("agent:") &&
      sessionKey.split(":")[2] === "explicit"
    )
      return "explicit";
    if (sessionKey.includes(":group:")) return "group";
    if (sessionKey.includes(":channel:")) return "channel";
    if (sessionKey.includes(":direct:") || sessionKey.includes(":dm:"))
      return "direct";
    const mainKey = ctx.mainKey?.trim().toLowerCase() || "main";
    const parts = sessionKey.split(":");
    if (
      parts.length === 3 &&
      parts[0] === "agent" &&
      (parts[2] === mainKey || parts[2] === "main")
    ) {
      const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
      const channelId = (ctx.channelId ?? "").trim();
      if (provider && provider !== "webchat" && channelId) return "direct";
    }
  }
  if ((ctx.messageProvider ?? "").trim().toLowerCase() === "webchat")
    return "direct";
  return;
}

export function isAllowedChatType(
  config: ResolvedSkillHarnessPluginConfig,
  ctx: {
    sessionKey?: string;
    messageProvider?: string;
    channelId?: string;
    mainKey?: string;
  },
): boolean {
  const chatType = resolveChatType(ctx);
  if (!chatType) return false;
  return config.allowedChatTypes.includes(chatType);
}

export function isAllowedChatId(
  config: ResolvedSkillHarnessPluginConfig,
  ctx: { sessionKey?: string; messageProvider?: string },
): boolean {
  const provider = (ctx.messageProvider ?? "").trim().toLowerCase();
  const normalizedSessionKey = (ctx.sessionKey ?? "").trim().toLowerCase();
  const chatIdParts: string[] = [];
  if (provider) chatIdParts.push(provider);

  const parts = normalizedSessionKey.split(":");
  if (parts.length >= 4 && parts[0] === "agent" && parts[2]) {
    const peerId = parts.slice(2).join(":");
    chatIdParts.push(peerId);
  }

  if (chatIdParts.length === 0) return true;
  const chatId = chatIdParts.join(":");
  if (
    config.allowedChatIds.length > 0 &&
    !config.allowedChatIds.includes(chatId)
  )
    return false;
  if (config.deniedChatIds.includes(chatId)) return false;
  return true;
}

export function resolveStatusUpdateAgentId(ctx: {
  agentId?: string;
  sessionKey?: string;
}): string {
  if (ctx.agentId) return ctx.agentId;
  const key = (ctx.sessionKey ?? "").trim().toLowerCase();
  const parts = key.split(":");
  if (parts[0] === "agent" && parts[1]) return parts[1];
  return "main";
}

export function resolveCanonicalSessionKeyFromSessionId(params: {
  api: OpenClawPluginApi;
  agentId: string;
  sessionId: string | undefined;
}): string | undefined {
  if (!params.sessionId) return;
  try {
    const entries = params.api.runtime.agent.session.listSessionEntries({
      agentId: params.agentId,
    });
    const match = entries.find(
      ({ entry }) => entry.sessionId === params.sessionId,
    );
    return match?.sessionKey;
  } catch (err) {
    logger.warn("failed to resolve canonical session key", { error: err });
    return;
  }
}
