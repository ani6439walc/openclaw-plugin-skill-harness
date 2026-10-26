import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalIdentity } from "../normalize.js";
import type { AvailableSkill } from "../skills/types.js";
import { resolveConfinedFile } from "../skills/paths.js";
import { readRelationSources } from "../skills/relation-sources.js";
import {
  applyRelationReviewChanges,
  readRelationGraph,
  readSkillIdentity,
} from "../skills/relation-graph.js";
import type {
  GraphRelation,
  RelationReviewChange,
  SkillIdentity,
} from "../skills/relation-graph.js";
import type { SkillRelationReviewFinding } from "./types.js";

export const MAX_RELATION_EXTRA_SKILLS = 8;
export const MAX_RELATION_CHANGES = 8;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export interface RelationReviewSkill {
  name: string;
  identity: SkillIdentity;
  content: string;
  fileDigest: string;
  workspacePath: string;
}

export interface RelationReviewContext {
  dataRoot: string;
  seedIds: readonly string[];
  skills: readonly RelationReviewSkill[];
  relations: readonly GraphRelation[];
  relationRevisions: ReadonlyMap<string, string>;
  getVisibleSkills: () => Promise<readonly AvailableSkill[]>;
}

function visibleWinners(skills: readonly AvailableSkill[]) {
  const result = new Map<string, AvailableSkill>();
  for (const skill of skills) {
    const key = canonicalIdentity(skill.name);
    // An ambiguous input is unavailable, rather than borrowing a same-name root.
    if (result.has(key)) throw new Error("ambiguous-review-skill");
    result.set(key, skill);
  }
  return result;
}

async function boundedSearch<T>(
  search: (params: { query: string; limit: number }) => Promise<T>,
  params: { query: string; limit: number },
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      search(params),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("review-search-timeout")),
          timeoutMs,
        );
        onAbort = () => reject(new Error("review-search-aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function prepareRelationReviewContext(params: {
  dataRoot: string;
  seedNames: readonly string[];
  getVisibleSkills: () => Promise<readonly AvailableSkill[]>;
  search?: (params: {
    query: string;
    limit: number;
  }) => Promise<readonly { name: string }[] | undefined>;
  signal?: AbortSignal;
  searchTimeoutMs?: number;
}): Promise<RelationReviewContext | undefined> {
  params.signal?.throwIfAborted();
  if (!params.seedNames.length) return;
  const registry = readRelationSources(params.dataRoot);
  if (!registry) return;
  const winners = visibleWinners(await params.getVisibleSkills());
  params.signal?.throwIfAborted();
  const captured = new Map<string, RelationReviewSkill>();
  let bytes = 0;
  async function capture(name: string) {
    const key = canonicalIdentity(name);
    if (captured.has(key)) return captured.get(key);
    const skill = winners.get(key);
    if (!skill) return;
    const file = await resolveConfinedFile(
      path.dirname(skill.location),
      skill.location,
    );
    if (!file || (await fs.stat(file)).size > MAX_SKILL_BYTES) return;
    const content = await fs.readFile(file, "utf8");
    const identity = await readSkillIdentity(skill, registry);
    if (!identity?.source_id || (await fs.readFile(file, "utf8")) !== content)
      return;
    const size = Buffer.byteLength(content);
    if (bytes + size > MAX_SNAPSHOT_BYTES)
      throw new Error("review-evidence-budget");
    params.signal?.throwIfAborted();
    const snapshot: RelationReviewSkill = {
      name: skill.name,
      identity,
      content,
      fileDigest: digest(content),
      workspacePath: `relation-evidence/${digest(identity.id)}/SKILL.md`,
    };
    bytes += size;
    captured.set(key, snapshot);
    return snapshot;
  }
  const seedIds = new Set<string>();
  for (const name of new Set(params.seedNames.map(canonicalIdentity))) {
    const skill = await capture(name);
    if (skill) seedIds.add(skill.identity.id);
  }
  if (!seedIds.size) return;
  const graph = await readRelationGraph(params.dataRoot);
  const extraNames = new Set<string>();
  for (const edge of graph?.relations ?? []) {
    const other = seedIds.has(edge.from)
      ? edge.to
      : seedIds.has(edge.to)
        ? edge.from
        : undefined;
    const node = other ? graph?.entities.get(other) : undefined;
    if (typeof node?.properties.name === "string")
      extraNames.add(node.properties.name);
  }
  const attemptedExtras = new Set<string>();
  async function captureExtra(name: string) {
    const key = canonicalIdentity(name);
    if (
      attemptedExtras.size >= MAX_RELATION_EXTRA_SKILLS ||
      captured.has(key) ||
      attemptedExtras.has(key) ||
      !winners.has(key)
    )
      return;
    attemptedExtras.add(key);
    await capture(name);
  }
  for (const name of [...extraNames].sort()) await captureExtra(name);
  if (attemptedExtras.size < MAX_RELATION_EXTRA_SKILLS && params.search) {
    const query = Array.from(
      [...captured.values()]
        .filter((skill) => seedIds.has(skill.identity.id))
        .map(
          (skill) =>
            `${skill.name}: ${winners.get(canonicalIdentity(skill.name))?.description ?? ""}`,
        )
        .join("\n"),
    )
      .slice(0, 1000)
      .join("");
    let hits: readonly { name: string }[] | undefined;
    try {
      hits = await boundedSearch(
        params.search,
        { query, limit: MAX_RELATION_EXTRA_SKILLS - attemptedExtras.size },
        params.signal,
        params.searchTimeoutMs ?? 15000,
      );
    } catch {
      params.signal?.throwIfAborted();
    }
    params.signal?.throwIfAborted();
    for (const hit of hits ?? []) await captureExtra(hit.name);
  }
  const skills = [...captured.values()];
  const ids = new Set(skills.map((skill) => skill.identity.id));
  return {
    dataRoot: params.dataRoot,
    seedIds: [...seedIds],
    skills,
    relations: structuredClone(
      (graph?.relations ?? []).filter(
        (edge) =>
          ids.has(edge.from) &&
          ids.has(edge.to) &&
          (seedIds.has(edge.from) || seedIds.has(edge.to)),
      ),
    ),
    relationRevisions: new Map(graph?.relationRevisions),
    getVisibleSkills: params.getVisibleSkills,
  };
}

export async function stageRelationReviewEvidence(
  context: RelationReviewContext,
  workspace: string,
): Promise<void> {
  for (const skill of context.skills) {
    const file = path.join(workspace, skill.workspacePath);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, skill.content, { mode: 0o400 });
  }
}

export function formatRelationReviewContext(
  context: RelationReviewContext,
): string {
  return JSON.stringify({
    seed_skill_ids: context.seedIds,
    skills: context.skills.map((skill) => ({
      id: skill.identity.id,
      name: skill.name,
      file_path: skill.workspacePath,
    })),
    relations: context.relations.map((edge) => ({
      from: edge.from,
      to: edge.to,
      type: edge.rel,
      reason: edge.properties.reason,
    })),
  });
}

export function validateRelationReviewFindings(
  context: RelationReviewContext,
  findings: readonly SkillRelationReviewFinding[],
): RelationReviewChange[] {
  if (findings.length > MAX_RELATION_CHANGES)
    throw new Error("review-change-budget");
  const skills = new Map(
    context.skills.map((skill) => [skill.identity.id, skill]),
  );
  const seeds = new Set(context.seedIds);
  const pairs = new Set<string>();
  return findings.map((finding) => {
    const from = skills.get(finding.fromSkillId),
      to = skills.get(finding.toSkillId);
    const pair = JSON.stringify([finding.fromSkillId, finding.toSkillId]);
    if (
      !from ||
      !to ||
      from === to ||
      pairs.has(pair) ||
      (!seeds.has(from.identity.id) && !seeds.has(to.identity.id))
    )
      throw new Error("invalid-review-endpoints");
    pairs.add(pair);
    const previous = context.relations.filter(
      (edge) => edge.from === from.identity.id && edge.to === to.identity.id,
    );
    if (
      previous.length > 1 ||
      (finding.operation === "create"
        ? previous.length !== 0
        : previous.length !== 1)
    )
      throw new Error("invalid-review-operation");
    if (
      !finding.relationEvidence.length ||
      finding.relationEvidence.length > 16
    )
      throw new Error("invalid-review-evidence");
    const evidence = finding.relationEvidence.map((reference) => {
      const skill = skills.get(reference.skillId);
      if (
        !skill ||
        (skill !== from && skill !== to) ||
        reference.filePath !== "SKILL.md" ||
        !Number.isInteger(reference.startLine) ||
        !Number.isInteger(reference.endLine) ||
        reference.startLine < 1 ||
        reference.endLine < reference.startLine ||
        reference.endLine - reference.startLine >= 200
      )
        throw new Error("invalid-review-evidence");
      const lines = skill.content.split(/\r?\n/);
      if (
        reference.endLine > lines.length ||
        !reference.quote.trim() ||
        Array.from(reference.quote).length > 2000 ||
        lines.slice(reference.startLine - 1, reference.endLine).join("\n") !==
          reference.quote
      )
        throw new Error("invalid-review-quote");
      return { ...reference, fileDigest: skill.fileDigest };
    });
    if (
      ![from, to].every((skill) =>
        evidence.some((reference) => reference.skillId === skill.identity.id),
      )
    )
      throw new Error("missing-endpoint-evidence");
    return {
      operation: finding.operation,
      from: from.identity,
      to: to.identity,
      expected: previous[0] ?? null,
      ...(finding.operation !== "delete"
        ? { type: finding.relationType, reason: finding.reason }
        : {}),
      rationale: finding.correctionGoal,
      evidence,
    };
  });
}

export async function applyPreparedRelationReview(
  context: RelationReviewContext,
  findings: readonly SkillRelationReviewFinding[],
  eventId: string,
  agentId: string,
  signal?: AbortSignal,
) {
  const changes = validateRelationReviewFindings(context, findings);
  const targets = new Set(
    changes.flatMap((change) => [change.from.id, change.to.id]),
  );
  return applyRelationReviewChanges(context.dataRoot, changes, {
    batchId: randomUUID(),
    eventId,
    agentId,
    signal,
    assertCurrent: async () => {
      signal?.throwIfAborted();
      const winners = visibleWinners(await context.getVisibleSkills());
      const registry = readRelationSources(context.dataRoot);
      if (!registry) throw new Error("stale-review-registry");
      const currentGraph = await readRelationGraph(context.dataRoot);
      for (const change of changes) {
        const pair = JSON.stringify([change.from.id, change.to.id]);
        if (
          currentGraph?.relationRevisions?.get(pair) !==
          context.relationRevisions.get(pair)
        )
          throw new Error("stale-review-revision");
      }
      for (const skill of context.skills.filter((entry) =>
        targets.has(entry.identity.id),
      )) {
        const current = winners.get(canonicalIdentity(skill.name));
        if (!current) throw new Error("stale-review-winner");
        const file = await resolveConfinedFile(
          path.dirname(current.location),
          current.location,
        );
        const identity = await readSkillIdentity(current, registry);
        if (
          !file ||
          !identity ||
          identity.id !== skill.identity.id ||
          identity.source !== skill.identity.source ||
          identity.source_path !== skill.identity.source_path ||
          identity.fingerprint !== skill.identity.fingerprint ||
          digest(await fs.readFile(file, "utf8")) !== skill.fileDigest
        )
          throw new Error("stale-review-evidence");
      }
      signal?.throwIfAborted();
    },
  });
}
