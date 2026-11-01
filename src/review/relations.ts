import { constants as fsConstants, promises as fs } from "node:fs";
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

export interface RelationPreparationSummary {
  status: "ready" | "skipped";
  reason?:
    | "no-seeds"
    | "registry-unavailable"
    | "no-eligible-seeds"
    | "preparation-failed"
    | "no-data-root";
  requestedSeeds: number;
  capturedSeeds: number;
  capturedExtras: number;
  existingNeighborAttempts: number;
  discoveryAttempts: number;
  skippedCaptureCount: number;
}

export type RelationSkillAdmission =
  | { status: "eligible"; skill: RelationReviewSkill }
  | {
      status: "ineligible";
      reason:
        | "not-visible"
        | "registry-unavailable"
        | "unregistered"
        | "unreadable"
        | "file-too-large"
        | "evidence-budget"
        | "extra-skill-budget"
        | "unstable-content";
    };

export interface RelationReviewContext {
  dataRoot: string;
  seedIds: readonly string[];
  skills: readonly RelationReviewSkill[];
  relations: readonly GraphRelation[];
  relationRevisions: ReadonlyMap<string, string>;
  getVisibleSkills: () => Promise<readonly AvailableSkill[]>;
  preparation: RelationPreparationSummary;
  inspectionCursor?: { key: string; nextOffset: number };
  admitSkill: (name: string) => Promise<RelationSkillAdmission>;
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

export async function prepareRelationReviewContext(params: {
  dataRoot: string;
  seedNames: readonly string[];
  getVisibleSkills: () => Promise<readonly AvailableSkill[]>;
  getNeighborOffset?: (key: string) => number;
  onPreparation?: (summary: RelationPreparationSummary) => void;
  signal?: AbortSignal;
}): Promise<RelationReviewContext | undefined> {
  const checkActive = () => params.signal?.throwIfAborted();
  checkActive();
  const requestedSeeds = [...new Set(params.seedNames.map(canonicalIdentity))];
  const preparation: RelationPreparationSummary = {
    status: "skipped",
    requestedSeeds: requestedSeeds.length,
    capturedSeeds: 0,
    capturedExtras: 0,
    existingNeighborAttempts: 0,
    discoveryAttempts: 0,
    skippedCaptureCount: 0,
  };
  const skip = (reason: RelationPreparationSummary["reason"]) => {
    preparation.reason = reason;
    params.onPreparation?.(preparation);
    return undefined;
  };
  if (!requestedSeeds.length) return skip("no-seeds");
  if (!readRelationSources(params.dataRoot))
    return skip("registry-unavailable");
  const initialWinners = visibleWinners(await params.getVisibleSkills());
  checkActive();
  const captured = new Map<string, RelationReviewSkill>();
  const skills: RelationReviewSkill[] = [];
  const relations: GraphRelation[] = [];
  const relationRevisions = new Map<string, string>();
  let bytes = 0;

  async function captureSnapshot(
    name: string,
    winners: ReadonlyMap<string, AvailableSkill>,
  ): Promise<RelationSkillAdmission> {
    checkActive();
    const skill = winners.get(canonicalIdentity(name));
    if (!skill) return { status: "ineligible", reason: "not-visible" };
    const registry = readRelationSources(params.dataRoot);
    if (!registry)
      return { status: "ineligible", reason: "registry-unavailable" };
    try {
      const file = await resolveConfinedFile(
        path.dirname(skill.location),
        skill.location,
      );
      checkActive();
      if (!file) return { status: "ineligible", reason: "unreadable" };
      const stat = await fs.stat(file);
      checkActive();
      if (stat.size > MAX_SKILL_BYTES)
        return { status: "ineligible", reason: "file-too-large" };
      const content = await fs.readFile(file, "utf8");
      checkActive();
      const size = Buffer.byteLength(content);
      if (size > MAX_SKILL_BYTES)
        return { status: "ineligible", reason: "file-too-large" };
      if (bytes + size > MAX_SNAPSHOT_BYTES)
        return { status: "ineligible", reason: "evidence-budget" };
      const identity = await readSkillIdentity(skill, registry);
      checkActive();
      if (!identity?.source_id)
        return { status: "ineligible", reason: "unregistered" };
      const after = await fs.readFile(file, "utf8");
      checkActive();
      if (after !== content)
        return { status: "ineligible", reason: "unstable-content" };
      return {
        status: "eligible",
        skill: {
          name: skill.name,
          identity,
          content,
          fileDigest: digest(content),
          workspacePath: `relation-evidence/${digest(identity.id)}/SKILL.md`,
        },
      };
    } catch {
      checkActive();
      return { status: "ineligible", reason: "unreadable" };
    }
  }
  function retain(skill: RelationReviewSkill) {
    bytes += Buffer.byteLength(skill.content);
    captured.set(canonicalIdentity(skill.name), skill);
    skills.push(skill);
  }
  const seedIds = new Set<string>();
  for (const name of requestedSeeds) {
    const result = await captureSnapshot(name, initialWinners);
    checkActive();
    if (result.status === "eligible") {
      retain(result.skill);
      seedIds.add(result.skill.identity.id);
    } else preparation.skippedCaptureCount++;
  }
  preparation.capturedSeeds = seedIds.size;
  if (!seedIds.size) return skip("no-eligible-seeds");
  const graph = await readRelationGraph(params.dataRoot);
  checkActive();
  // Initial seed pairs are fixed at preparation time, including tombstones.
  for (const from of seedIds)
    for (const to of seedIds) {
      const pair = JSON.stringify([from, to]);
      const revision = graph?.relationRevisions?.get(pair);
      if (revision !== undefined) relationRevisions.set(pair, revision);
    }
  relations.push(
    ...structuredClone(
      (graph?.relations ?? []).filter(
        (edge) => seedIds.has(edge.from) && seedIds.has(edge.to),
      ),
    ),
  );
  const extraNames = new Set<string>();
  for (const edge of graph?.relations ?? []) {
    const other = seedIds.has(edge.from)
      ? edge.to
      : seedIds.has(edge.to)
        ? edge.from
        : undefined;
    const node = other ? graph?.entities.get(other) : undefined;
    if (typeof node?.properties.name === "string") {
      const key = canonicalIdentity(node.properties.name);
      if (!captured.has(key) && initialWinners.has(key)) extraNames.add(key);
    }
  }
  const attemptedExtras = new Map<string, RelationSkillAdmission>();
  async function captureExtra(
    name: string,
    source: "existing" | "discovery",
  ): Promise<RelationSkillAdmission> {
    checkActive();
    const key = canonicalIdentity(name);
    const existing = captured.get(key);
    if (existing) return { status: "eligible", skill: existing };
    const previous = attemptedExtras.get(key);
    if (previous) return previous;
    if (attemptedExtras.size >= MAX_RELATION_EXTRA_SKILLS)
      return { status: "ineligible", reason: "extra-skill-budget" };
    // Reserve the attempt before I/O; failed captures also consume the budget.
    attemptedExtras.set(key, { status: "ineligible", reason: "unreadable" });
    if (source === "existing") preparation.existingNeighborAttempts++;
    else preparation.discoveryAttempts++;
    const winners = visibleWinners(await params.getVisibleSkills());
    checkActive();
    const result = await captureSnapshot(name, winners);
    checkActive();
    if (result.status === "eligible") {
      const currentGraph = await readRelationGraph(params.dataRoot);
      checkActive();
      const id = result.skill.identity.id;
      // Admission may happen much later than preparation. Only new pairs take
      // a fresh baseline; refreshing old pairs could hide concurrent edits.
      for (const seed of seedIds)
        for (const [from, to] of [
          [seed, id],
          [id, seed],
        ]) {
          const pair = JSON.stringify([from, to]);
          const revision = currentGraph?.relationRevisions?.get(pair);
          if (revision !== undefined) relationRevisions.set(pair, revision);
        }
      relations.push(
        ...structuredClone(
          (currentGraph?.relations ?? []).filter(
            (edge) =>
              (edge.from === id && seedIds.has(edge.to)) ||
              (edge.to === id && seedIds.has(edge.from)),
          ),
        ),
      );
      retain(result.skill);
      preparation.capturedExtras++;
    } else preparation.skippedCaptureCount++;
    attemptedExtras.set(key, result);
    return result;
  }
  const neighbors = [...extraNames].sort();
  const cursorKey = digest(JSON.stringify([...seedIds].sort()));
  const rawOffset = params.getNeighborOffset?.(cursorKey) ?? 0;
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset >= 0 && neighbors.length
      ? rawOffset % neighbors.length
      : 0;
  const initialAttempts = Math.min(4, neighbors.length);
  for (let index = 0; index < initialAttempts; index++)
    await captureExtra(
      neighbors[(offset + index) % neighbors.length],
      "existing",
    );
  checkActive();
  preparation.status = "ready";
  params.onPreparation?.(preparation);
  // A single run can issue parallel tool calls. Serialize admission so the
  // byte/skill budgets and pair baselines are checked and changed atomically.
  let admissionQueue: Promise<unknown> = Promise.resolve();
  return {
    dataRoot: params.dataRoot,
    seedIds: [...seedIds],
    skills,
    relations,
    relationRevisions,
    getVisibleSkills: params.getVisibleSkills,
    preparation,
    ...(neighbors.length
      ? {
          inspectionCursor: {
            key: cursorKey,
            nextOffset: (offset + initialAttempts) % neighbors.length,
          },
        }
      : {}),
    admitSkill(name) {
      const admission = admissionQueue.then(() =>
        captureExtra(name, "discovery"),
      );
      admissionQueue = admission.catch(() => undefined);
      return admission;
    },
  };
}

export async function stageRelationReviewSkill(
  skill: RelationReviewSkill,
  workspace: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const segment = digest(skill.identity.id);
  if (skill.workspacePath !== `relation-evidence/${segment}/SKILL.md`)
    throw new Error("invalid-staged-evidence-path");
  const root = await fs.realpath(workspace);
  signal?.throwIfAborted();
  let directory = root;
  for (const part of ["relation-evidence", segment]) {
    directory = path.join(directory, part);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    signal?.throwIfAborted();
    const stat = await fs.lstat(directory);
    signal?.throwIfAborted();
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("invalid-staged-evidence-directory");
    signal?.throwIfAborted();
  }
  const file = path.join(directory, "SKILL.md");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created = false;
  try {
    try {
      handle = await fs.open(
        file,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o400,
      );
      created = true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      handle = await fs.open(
        file,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    }
    signal?.throwIfAborted();
    const stat = await handle.stat();
    signal?.throwIfAborted();
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES)
      throw new Error("invalid-staged-evidence-file");
    if (created) await handle.writeFile(skill.content, "utf8");
    else if ((await handle.readFile("utf8")) !== skill.content)
      throw new Error("stale-staged-evidence");
    signal?.throwIfAborted();
  } finally {
    await handle?.close();
  }
}

export async function stageRelationReviewEvidence(
  context: RelationReviewContext,
  workspace: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const skill of context.skills)
    await stageRelationReviewSkill(skill, workspace, signal);
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
