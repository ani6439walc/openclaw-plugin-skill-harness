import { randomInt } from "node:crypto";
import type { SessionData, SessionState } from "../session/tracker.js";
import type { AvailableSkill } from "../skills/types.js";
import type { CuratedSkillCandidate } from "./types.js";

export interface ColdStartSelection {
  ranked: CuratedSkillCandidate[];
  selected: CuratedSkillCandidate[];
}

export type SampleWithoutReplacement = <T>(
  values: readonly T[],
  count: number,
) => T[];

interface RankedPoolEntry {
  name: string;
  declarationOrder: number;
  usageCount: number;
  lastUsedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function canonicalIntentIdentity(value: unknown): string {
  const normalized = normalizeIdentity(value);
  return normalized.match(/^([a-z0-9_-]+)/)?.[1] ?? normalized;
}

function finalizedStates(session: SessionData): readonly SessionState[] {
  if (!isRecord(session)) return [];
  const history = Array.isArray(session.history)
    ? session.history.filter(isRecord)
    : [];
  return [
    ...history,
    ...(isRecord(session.current) ? [session.current] : []),
  ] as SessionState[];
}

export const sampleWithoutReplacement: SampleWithoutReplacement = <T>(
  values: readonly T[],
  count: number,
): T[] => {
  const pool = [...values];
  const boundedCount = Math.min(pool.length, Math.max(0, Math.floor(count)));

  for (let index = 0; index < boundedCount; index += 1) {
    const selectedIndex = randomInt(index, pool.length);
    [pool[index], pool[selectedIndex]] = [pool[selectedIndex], pool[index]];
  }

  return pool.slice(0, boundedCount);
};

export function selectColdStartCandidates(params: {
  agentId: string;
  intentId: string;
  declaredSkillNames: readonly string[];
  inventory: readonly AvailableSkill[];
  sessions: readonly SessionData[];
  nowMs: number;
  retentionMs: number;
  sampleWithoutReplacement: SampleWithoutReplacement;
}): ColdStartSelection {
  const inventoryByIdentity = new Map<string, AvailableSkill>();
  for (const skill of params.inventory) {
    const identity = normalizeIdentity(skill.name);
    if (identity && !inventoryByIdentity.has(identity)) {
      inventoryByIdentity.set(identity, skill);
    }
  }

  const poolByIdentity = new Map<string, RankedPoolEntry>();
  for (const declaredName of params.declaredSkillNames) {
    const identity = normalizeIdentity(declaredName);
    const resolved = inventoryByIdentity.get(identity);
    if (!identity || !resolved || poolByIdentity.has(identity)) continue;

    poolByIdentity.set(identity, {
      name: resolved.name,
      declarationOrder: poolByIdentity.size,
      usageCount: 0,
      lastUsedAt: Number.NEGATIVE_INFINITY,
    });
  }

  const normalizedAgentId = normalizeIdentity(params.agentId);
  const normalizedIntentId = canonicalIntentIdentity(params.intentId);
  const cutoffMs = params.nowMs - params.retentionMs;

  for (const session of params.sessions) {
    if (!isRecord(session)) continue;
    if (normalizeIdentity(session.agentId) !== normalizedAgentId) continue;

    for (const state of finalizedStates(session)) {
      if (state.error !== undefined) continue;
      if (
        canonicalIntentIdentity(state.intent?.result?.intent ?? "") !==
        normalizedIntentId
      ) {
        continue;
      }

      const rawEndedAt = state.timestamps?.end;
      if (typeof rawEndedAt !== "string") continue;
      const endedAt = Date.parse(rawEndedAt);
      if (!Number.isFinite(endedAt) || endedAt <= cutoffMs) continue;

      const usedPoolIdentities = new Set<string>();
      const usedSkills = Array.isArray(state.skillsUsed)
        ? state.skillsUsed
        : [];
      for (const usedSkill of usedSkills) {
        if (!isRecord(usedSkill)) continue;
        const identity = normalizeIdentity(usedSkill.name);
        if (poolByIdentity.has(identity)) usedPoolIdentities.add(identity);
      }

      for (const identity of usedPoolIdentities) {
        const candidate = poolByIdentity.get(identity);
        if (!candidate) continue;
        candidate.usageCount += 1;
        candidate.lastUsedAt = Math.max(candidate.lastUsedAt, endedAt);
      }
    }
  }

  const rankedEntries = [...poolByIdentity.values()].sort(
    (left, right) =>
      right.usageCount - left.usageCount ||
      right.lastUsedAt - left.lastUsedAt ||
      left.declarationOrder - right.declarationOrder,
  );
  const ranked = rankedEntries.map<CuratedSkillCandidate>((candidate) => ({
    name: candidate.name,
    provenance: "historical-top",
  }));
  const exploitation = ranked.slice(0, 4);
  const remainder = ranked.slice(4).map((candidate) => candidate.name);
  const exploration =
    remainder.length === 0
      ? []
      : params
          .sampleWithoutReplacement(remainder, Math.min(2, remainder.length))
          .map<CuratedSkillCandidate>((name) => ({
            name,
            provenance: "random-exploration",
          }));

  return {
    ranked,
    selected: [...exploitation, ...exploration],
  };
}

export function selectExplorationCandidates<T>(
  items: readonly T[],
  targetCount: number,
  ratio = 2 / 3,
  sampler: SampleWithoutReplacement = sampleWithoutReplacement,
): T[] {
  if (items.length <= targetCount) return [...items];
  const exploitationCount = Math.round(targetCount * ratio);
  const explorationCount = targetCount - exploitationCount;
  const top = items.slice(0, exploitationCount);
  const remainder = items.slice(exploitationCount);
  const sampled = sampler(remainder, explorationCount);
  return [...top, ...sampled];
}
