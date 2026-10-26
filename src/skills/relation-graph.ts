import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import matter from "gray-matter";
import { withFileLock } from "../file-utils.js";
import { resolveConfinedFile } from "./paths.js";
import { canonicalIdentity } from "../normalize.js";
import {
  readRelationSources,
  resolveRelationSource,
  stableSkillId,
  relationSourcesPath,
} from "./relation-sources.js";
import type { RelationSourceRegistry } from "./relation-sources.js";

export const scoredRelationTypes = [
  "depends_on",
  "composes_with",
  "similar_to",
  "conflicts_with",
  "specializes",
] as const;
export const relationTypes = ["related", ...scoredRelationTypes] as const;
export type RelationType = (typeof relationTypes)[number];
export type RelationScores = Record<
  (typeof scoredRelationTypes)[number],
  number
>;
export interface SkillIdentity {
  id: string;
  name: string;
  source: string;
  fingerprint: string;
  source_id?: string;
  skill_key?: string;
  source_path?: string;
}
export interface ImportedRelation {
  from: SkillIdentity;
  to: SkillIdentity;
  type: RelationType;
  reason: string;
  scores?: RelationScores;
  classificationVersion?: string;
  model?: string;
  sourceGraphDigest?: string;
}
export interface GraphRelatedSkill {
  name: string;
  reason: string;
  direction: "current-to-related" | "related-to-current";
  relation_type: RelationType;
  source?: "author-import" | "review";
}
export interface GraphEntity {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  created?: string;
  updated?: string | null;
}
export interface GraphRelation {
  from: string;
  rel: string;
  to: string;
  properties: Record<string, unknown>;
}
export interface RelationGraph {
  entities: Map<string, GraphEntity>;
  relations: GraphRelation[];
  /** Latest operation revision for each ordered pair, including absent/deleted edges. */
  readonly relationRevisions?: ReadonlyMap<string, string>;
  /** Includes deleted pairs so ordinary imports cannot resurrect reviewed edges. */
  reviewedPairs?: Set<string>;
}
export interface RelationReviewEvidence {
  skillId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  quote: string;
  fileDigest: string;
}
export interface RelationReviewChange {
  operation: "create" | "update" | "delete";
  from: SkillIdentity;
  to: SkillIdentity;
  expected: GraphRelation | null;
  type?: RelationType;
  reason?: string;
  rationale: string;
  evidence: readonly RelationReviewEvidence[];
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export async function readSkillIdentity(
  skill: { name: string; location: string },
  registry?: RelationSourceRegistry,
): Promise<SkillIdentity | undefined> {
  try {
    const source = await fs.realpath(path.dirname(skill.location));
    const file = await resolveConfinedFile(source, skill.location);
    if (!file) return;
    const parsed = matter(await fs.readFile(file, "utf8"));
    if (
      typeof parsed.data.name !== "string" ||
      parsed.data.name.trim() !== skill.name
    )
      return;
    const data = { ...parsed.data };
    if (object(data.metadata)) {
      data.metadata = { ...data.metadata };
      delete data.metadata["related-skills"];
      if (!Object.keys(data.metadata).length) delete data.metadata;
    }
    const fingerprint = hash(stable({ data, content: parsed.content }));
    if (registry) {
      const binding = await resolveRelationSource(skill, registry);
      if (!binding) return;
      return { ...binding, name: skill.name, source, fingerprint };
    }
    return {
      id: `skill_${hash(stable({ name: skill.name, source, fingerprint }))}`,
      name: skill.name,
      source,
      fingerprint,
    };
  } catch {
    return;
  }
}

/** Replay ontology 1.0.4 operations; malformed streams are rejected as a whole. */
export function replayRelationGraph(raw: string): RelationGraph {
  const relationRevisions = new Map<string, string>();
  const graph: RelationGraph = {
    entities: new Map(),
    relations: [],
    relationRevisions,
  };
  let ordinal = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    ordinal++;
    const record: unknown = JSON.parse(line);
    if (!object(record)) throw new Error("Invalid graph record");
    if (record.op === "create") {
      const entity = record.entity;
      if (
        !object(entity) ||
        !string(entity.id) ||
        !string(entity.type) ||
        !object(entity.properties)
      )
        throw new Error("Invalid graph entity");
      graph.entities.set(entity.id, {
        ...entity,
        properties: { ...entity.properties },
      } as GraphEntity);
    } else if (record.op === "update") {
      if (
        !string(record.id) ||
        (record.properties !== undefined && !object(record.properties))
      )
        throw new Error("Invalid graph update");
      const entity = graph.entities.get(record.id);
      if (entity) {
        entity.properties = {
          ...entity.properties,
          ...(record.properties as Record<string, unknown> | undefined),
        };
        entity.updated =
          typeof record.timestamp === "string" ? record.timestamp : null;
      }
    } else if (record.op === "delete") {
      if (!string(record.id)) throw new Error("Invalid graph delete");
      graph.entities.delete(record.id);
    } else if (record.op === "relate" || record.op === "unrelate") {
      if (
        ![record.from, record.rel, record.to].every(string) ||
        (record.properties !== undefined && !object(record.properties))
      )
        throw new Error("Invalid graph relation");
      const relation = {
        from: record.from as string,
        rel: record.rel as string,
        to: record.to as string,
        properties: (record.properties ?? {}) as Record<string, unknown>,
      };
      relationRevisions.set(
        stable([relation.from, relation.to]),
        hash(stable({ ordinal, record })),
      );
      if (object(record.review)) {
        graph.reviewedPairs ??= new Set();
        graph.reviewedPairs.add(stable([relation.from, relation.to]));
      }
      if (record.op === "relate") graph.relations.push(relation);
      else
        graph.relations = graph.relations.filter(
          (r) =>
            r.from !== relation.from ||
            r.rel !== relation.rel ||
            r.to !== relation.to,
        );
    } else throw new Error("Unknown graph operation");
  }
  return graph;
}
export function relationGraphPath(dataRoot: string): string {
  return path.join(dataRoot, "skill-relations", "graph.jsonl");
}
const graphCache = new Map<
  string,
  { signature: string; graph: RelationGraph | undefined }
>();
export async function readRelationGraph(
  dataRoot: string,
): Promise<RelationGraph | undefined> {
  const file = relationGraphPath(dataRoot);
  try {
    const stat = await fs.stat(file, { bigint: true });
    if (!stat.isFile()) return;
    const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    const cached = graphCache.get(file);
    if (cached?.signature === signature) return cached.graph;
    let graph: RelationGraph | undefined;
    try {
      graph = replayRelationGraph(await fs.readFile(file, "utf8"));
    } catch {
      /* Unavailable until the next publication. */
    }
    if (graphCache.size > 16) graphCache.clear();
    graphCache.set(file, { signature, graph });
    return graph;
  } catch {
    graphCache.delete(file);
    return;
  }
}
function stableIdentity(value: SkillIdentity): boolean {
  try {
    return (
      string(value.source_id) &&
      string(value.skill_key) &&
      string(value.source_path) &&
      value.id === stableSkillId(value.source_id, value.skill_key)
    );
  } catch {
    return false;
  }
}
function validIdentity(value: unknown): value is SkillIdentity {
  return (
    object(value) &&
    string(value.id) &&
    string(value.name) &&
    string(value.source) &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    path.isAbsolute(value.source) &&
    (stableIdentity(value as unknown as SkillIdentity) ||
      (value.source_id === undefined &&
        value.skill_key === undefined &&
        value.source_path === undefined &&
        value.id ===
          `skill_${hash(stable({ name: value.name, source: value.source, fingerprint: value.fingerprint }))}`))
  );
}
function validProperties(p: Record<string, unknown>): boolean {
  return (
    (p.source === undefined || p.source === "author-import") &&
    (p.formatVersion === 1 ||
      (p.formatVersion === 2 &&
        typeof p.fromFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(p.fromFingerprint) &&
        typeof p.toFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(p.toFingerprint) &&
        p.verification_status === undefined)) &&
    typeof p.reason === "string" &&
    (p.classificationVersion === undefined ||
      string(p.classificationVersion)) &&
    (p.model === undefined || string(p.model)) &&
    (p.sourceGraphDigest === undefined ||
      (typeof p.sourceGraphDigest === "string" &&
        /^[a-f0-9]{64}$/.test(p.sourceGraphDigest))) &&
    (p.scores === undefined ||
      (object(p.scores) &&
        scoredRelationTypes.every(
          (type) =>
            typeof (p.scores as Record<string, unknown>)[type] === "number" &&
            Number.isFinite((p.scores as Record<string, number>)[type]) &&
            (p.scores as Record<string, number>)[type] >= 0 &&
            (p.scores as Record<string, number>)[type] <= 1,
        )))
  );
}
export async function resolveRelationGraph(
  dataRoot: string,
  skills: readonly { name: string; location: string }[],
): Promise<Map<string, GraphRelatedSkill[]>> {
  const result = new Map<string, GraphRelatedSkill[]>();
  const graph = await readRelationGraph(dataRoot);
  if (!graph) return result;
  const registry = readRelationSources(dataRoot);
  const names = new Map<
    string,
    { name: string; fingerprint: string; version: number }
  >();
  // Read only skills named by graph nodes, not the whole inventory.
  const legacyNames = new Set(
    [...graph.entities.values()]
      .filter((entity) => entity.properties.formatVersion === 1)
      .map((entity) => entity.properties.name),
  );
  const stableNames = new Set<string>();
  for (const source of registry?.sources ?? [])
    for (const [key, binding] of Object.entries(source.skills))
      if (
        graph.entities.get(stableSkillId(source.id, key))?.properties
          .formatVersion === 2
      )
        stableNames.add(binding.name);
  for (const skill of skills) {
    if (registry && stableNames.has(skill.name)) {
      const identity = await readSkillIdentity(skill, registry);
      const node = identity ? graph.entities.get(identity.id) : undefined;
      if (
        identity &&
        node?.type === "Skill" &&
        node.properties.formatVersion === 2 &&
        node.properties.source_id === identity.source_id &&
        node.properties.skill_key === identity.skill_key
      )
        names.set(identity.id, {
          name: skill.name,
          fingerprint: identity.fingerprint,
          version: 2,
        });
    }
    if (legacyNames.has(skill.name)) {
      const identity = await readSkillIdentity(skill);
      const node = identity ? graph.entities.get(identity.id) : undefined;
      if (
        identity &&
        node?.type === "Skill" &&
        node.properties.formatVersion === 1 &&
        node.properties.name === identity.name &&
        node.properties.source === identity.source &&
        node.properties.fingerprint === identity.fingerprint
      )
        names.set(identity.id, {
          name: skill.name,
          fingerprint: identity.fingerprint,
          version: 1,
        });
    }
  }
  const seen = new Set<string>();
  for (const edge of graph.relations) {
    const from = names.get(edge.from),
      to = names.get(edge.to);
    if (
      !from ||
      !to ||
      canonicalIdentity(from.name) === canonicalIdentity(to.name) ||
      !relationTypes.includes(edge.rel as RelationType) ||
      !validProperties(edge.properties) ||
      from.version !== edge.properties.formatVersion ||
      to.version !== edge.properties.formatVersion ||
      (from.version === 2 &&
        (edge.properties.fromFingerprint !== from.fingerprint ||
          edge.properties.toFingerprint !== to.fingerprint))
    )
      continue;
    const key = stable([edge.from, edge.rel, edge.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [name, other, direction] of [
      [from.name, to.name, "current-to-related"],
      [to.name, from.name, "related-to-current"],
    ] as const) {
      const key = canonicalIdentity(name);
      const list = result.get(key) ?? [];
      list.push({
        name: other,
        reason: edge.properties.reason as string,
        direction,
        relation_type: edge.rel as RelationType,
        source: graph.reviewedPairs?.has(stable([edge.from, edge.to]))
          ? "review"
          : "author-import",
      });
      result.set(key, list);
    }
  }
  for (const list of result.values())
    list.sort(
      (a, b) =>
        a.direction.localeCompare(b.direction) ||
        a.name.localeCompare(b.name) ||
        a.relation_type.localeCompare(b.relation_type),
    );
  return result;
}
export const relationSchema = `types:\n  Skill:\n    required: [name, source, fingerprint, formatVersion]\nrelations:\n${relationTypes.map((type) => `  ${type}:\n    from_types: [Skill]\n    to_types: [Skill]\n`).join("")}`;
export const stableRelationSchema = `version: 2
identity:
  format: "<source_id>:<skill_key>"
types:
  Skill:
    required: [name, source_id, skill_key, source_path, formatVersion]
relations:
${relationTypes
  .map(
    (type) => `  ${type}:
    from_types: [Skill]
    to_types: [Skill]
    required: [reason, formatVersion, fromFingerprint, toFingerprint]
`,
  )
  .join("")}`;

export const relationDigest = hash;
export function registryDigest(registry: RelationSourceRegistry): string {
  return hash(stable(registry));
}

async function assertGraphDirectory(dataRoot: string): Promise<void> {
  try {
    if (
      !(await fs.lstat(path.dirname(relationGraphPath(dataRoot)))).isDirectory()
    )
      throw new Error("invalid-graph-directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function managedGraphText(dataRoot: string): Promise<string | undefined> {
  const file = relationGraphPath(dataRoot);
  try {
    if (!(await fs.lstat(path.dirname(file))).isDirectory())
      throw new Error("invalid-graph-directory");
    if (!(await fs.lstat(file)).isFile()) throw new Error("invalid-graph-file");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function destinationGraphDigest(
  dataRoot: string,
): Promise<string | null> {
  const raw = await managedGraphText(dataRoot);
  return raw === undefined ? null : hash(raw);
}

export interface RelationSnapshotOptions {
  expectedGraphDigest: string | null;
  expectedSourcesDigest: string;
  assertSourceCurrent: () => Promise<void>;
}

/** Explicit full replacement: compare and revalidate under the publication lock. */
export async function publishRelationSnapshot(
  dataRoot: string,
  identities: readonly SkillIdentity[],
  relations: readonly ImportedRelation[],
  options: RelationSnapshotOptions,
): Promise<{
  nodes: number;
  relations: number;
  graphDigest: string;
  backupPath?: string;
}> {
  const file = relationGraphPath(dataRoot);
  const directory = path.dirname(file);
  await assertGraphDirectory(dataRoot);
  const result = await withFileLock(file, async () => {
    const previous = await managedGraphText(dataRoot);
    await fs.chmod(directory, 0o700);
    if (
      (previous === undefined ? null : hash(previous)) !==
      options.expectedGraphDigest
    )
      throw new Error("stale-destination");
    const registry = readRelationSources(dataRoot);
    if (!registry || registryDigest(registry) !== options.expectedSourcesDigest)
      throw new Error("stale-registry");
    await options.assertSourceCurrent();
    await assertCurrentIdentities(identities, registry);
    const nodes = new Map<string, SkillIdentity>();
    const names = new Set<string>();
    for (const identity of identities) {
      const key = stable([
        identity.source_id,
        canonicalIdentity(identity.name),
      ]);
      if (nodes.has(identity.id) || names.has(key))
        throw new Error("duplicate-graph-node");
      nodes.set(identity.id, identity);
      names.add(key);
    }
    const pairs = new Set<string>();
    const timestamp = new Date().toISOString();
    const operations: Record<string, unknown>[] = identities.map(
      (identity) => ({
        op: "create",
        entity: {
          id: identity.id,
          type: "Skill",
          properties: identityProperties(identity),
          created: timestamp,
          updated: timestamp,
        },
        timestamp,
      }),
    );
    for (const relation of relations) {
      const from = nodes.get(relation.from.id),
        to = nodes.get(relation.to.id);
      const pair = stable([relation.from.id, relation.to.id]);
      const properties = importedProperties(relation);
      if (
        !from ||
        !to ||
        from.id === to.id ||
        pairs.has(pair) ||
        stable(from) !== stable(relation.from) ||
        stable(to) !== stable(relation.to) ||
        !relationTypes.includes(relation.type) ||
        !validProperties(properties) ||
        !relation.reason.trim()
      )
        throw new Error("Invalid snapshot relation");
      pairs.add(pair);
      operations.push({
        op: "relate",
        from: from.id,
        rel: relation.type,
        to: to.id,
        properties,
        timestamp,
      });
    }
    const raw =
      operations.map((operation) => JSON.stringify(operation)).join("\n") +
      "\n";
    const schemaFile = path.join(directory, "schema.yaml");
    let oldSchema: string | undefined;
    try {
      if (!(await fs.lstat(schemaFile)).isFile())
        throw new Error("invalid-graph-schema");
      oldSchema = await fs.readFile(schemaFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let backupPath: string | undefined;
    if (previous !== undefined) {
      backupPath = path.join(directory, `backup-${randomUUID()}`);
      await fs.mkdir(backupPath, { mode: 0o700 });
      const backups: [string, string | undefined][] = [
        ["graph.jsonl", previous],
        ["schema.yaml", oldSchema],
        [
          "sources.json",
          await fs.readFile(relationSourcesPath(dataRoot), "utf8"),
        ],
      ];
      for (const [name, content] of backups) {
        if (content !== undefined)
          await fs.writeFile(path.join(backupPath, name), content, {
            mode: 0o600,
            flag: "wx",
          });
      }
    }
    try {
      await writeTextAtomic(schemaFile, stableRelationSchema);
      await writeTextAtomic(file, raw);
    } catch (error) {
      if (oldSchema === undefined) await fs.rm(schemaFile, { force: true });
      else await writeTextAtomic(schemaFile, oldSchema);
      throw error;
    }
    graphCache.delete(file);
    return {
      nodes: nodes.size,
      relations: pairs.size,
      graphDigest: hash(raw),
      ...(backupPath ? { backupPath } : {}),
    };
  });
  if (!result) throw new Error("Skill relation graph is busy");
  return result;
}

function identityProperties(identity: SkillIdentity): Record<string, unknown> {
  return stableIdentity(identity)
    ? {
        name: identity.name,
        source_id: identity.source_id,
        skill_key: identity.skill_key,
        source_path: identity.source_path,
        formatVersion: 2,
      }
    : {
        name: identity.name,
        source: identity.source,
        fingerprint: identity.fingerprint,
        formatVersion: 1,
      };
}

function importedProperties(edge: ImportedRelation): Record<string, unknown> {
  if (stableIdentity(edge.from) !== stableIdentity(edge.to))
    throw new Error("Invalid imported relation");
  return {
    reason: edge.reason,
    formatVersion: stableIdentity(edge.from) ? 2 : 1,
    ...(stableIdentity(edge.from)
      ? {
          fromFingerprint: edge.from.fingerprint,
          toFingerprint: edge.to.fingerprint,
        }
      : {}),
    ...(edge.scores ? { scores: edge.scores } : {}),
    ...(edge.classificationVersion
      ? { classificationVersion: edge.classificationVersion }
      : {}),
    ...(edge.model ? { model: edge.model } : {}),
    ...(edge.sourceGraphDigest
      ? { sourceGraphDigest: edge.sourceGraphDigest }
      : {}),
  };
}

async function assertCurrentIdentities(
  identities: readonly SkillIdentity[],
  registry: RelationSourceRegistry | undefined,
): Promise<void> {
  for (const identity of identities) {
    if (!validIdentity(identity) || !stableIdentity(identity) || !registry)
      throw new Error("Invalid stable identity");
    const current = await readSkillIdentity(
      { name: identity.name, location: path.join(identity.source, "SKILL.md") },
      registry,
    );
    if (
      !current ||
      current.id !== identity.id ||
      current.name !== identity.name ||
      current.source !== identity.source ||
      current.fingerprint !== identity.fingerprint ||
      current.source_id !== identity.source_id ||
      current.skill_key !== identity.skill_key ||
      current.source_path !== identity.source_path
    )
      throw new Error("stale-source");
  }
}
async function writeTextAtomic(
  file: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    signal?.throwIfAborted();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    Array.from(value).length <= maximum
  );
}

function validReviewEvidence(
  evidence: unknown,
  from: SkillIdentity,
  to: SkillIdentity,
): evidence is readonly RelationReviewEvidence[] {
  if (!Array.isArray(evidence) || evidence.length < 2 || evidence.length > 16)
    return false;
  const covered = new Set<string>();
  for (const entry of evidence) {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "skillId",
            "filePath",
            "startLine",
            "endLine",
            "quote",
            "fileDigest",
          ].includes(key),
      ) ||
      (entry.skillId !== from.id && entry.skillId !== to.id) ||
      !boundedText(entry.filePath, 1024) ||
      entry.filePath.includes("\\") ||
      path.posix.isAbsolute(entry.filePath) ||
      /^[A-Za-z]:/.test(entry.filePath) ||
      /[\u0000-\u001f\u007f]/u.test(entry.filePath) ||
      !entry.filePath
        .split("/")
        .every((part) => part && part !== "." && part !== "..") ||
      !Number.isSafeInteger(entry.startLine) ||
      !Number.isSafeInteger(entry.endLine) ||
      (entry.startLine as number) < 1 ||
      (entry.endLine as number) > 1_000_000 ||
      (entry.endLine as number) < (entry.startLine as number) ||
      (entry.endLine as number) - (entry.startLine as number) >= 200 ||
      !boundedText(entry.quote, 2000) ||
      typeof entry.fileDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.fileDigest)
    )
      return false;
    covered.add(entry.skillId);
  }
  return covered.has(from.id) && covered.has(to.id);
}

function assertReviewChange(change: RelationReviewChange): void {
  if (
    !object(change) ||
    !["create", "update", "delete"].includes(change.operation) ||
    !validIdentity(change.from) ||
    !validIdentity(change.to) ||
    !stableIdentity(change.from) ||
    !stableIdentity(change.to) ||
    change.from.id === change.to.id ||
    canonicalIdentity(change.from.name) === canonicalIdentity(change.to.name) ||
    !boundedText(change.rationale, 2000) ||
    !validReviewEvidence(change.evidence, change.from, change.to) ||
    (change.operation === "create"
      ? change.expected !== null
      : !object(change.expected)) ||
    (change.operation === "delete"
      ? change.type !== undefined || change.reason !== undefined
      : !relationTypes.includes(change.type as RelationType) ||
        !boundedText(change.reason, 2000))
  )
    throw new Error("invalid-review-change");
}

function assertNodeOwnership(
  graph: RelationGraph,
  identity: SkillIdentity,
): void {
  const existing = graph.entities.get(identity.id);
  if (
    existing &&
    (existing.type !== "Skill" ||
      existing.properties.formatVersion !== 2 ||
      existing.properties.source_id !== identity.source_id ||
      existing.properties.skill_key !== identity.skill_key)
  )
    throw new Error("Graph entity ownership conflict");
}

/**
 * Append one logical Review batch under the same lock as imports and registry writes.
 * The caller checks evidence bytes, current visible winners, and each targeted
 * pair's captured relationRevisions inside this lock, including absent edges.
 */
export async function applyRelationReviewChanges(
  dataRoot: string,
  changes: readonly RelationReviewChange[],
  options: {
    batchId: string;
    eventId: string;
    agentId: string;
    assertCurrent: () => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<{ changed: number; batchId: string }> {
  if (
    !Array.isArray(changes) ||
    changes.length < 1 ||
    changes.length > 8 ||
    !boundedText(options.batchId, 256) ||
    !boundedText(options.eventId, 256) ||
    !boundedText(options.agentId, 256) ||
    typeof options.assertCurrent !== "function"
  )
    throw new Error("invalid-review-batch");
  const pinned = structuredClone(changes);
  const { batchId, eventId, agentId, assertCurrent, signal } = options;
  const pairs = new Set<string>();
  for (const change of pinned) {
    assertReviewChange(change);
    const pair = stable([change.from.id, change.to.id]);
    if (pairs.has(pair)) throw new Error("duplicate-review-pair");
    pairs.add(pair);
  }
  signal?.throwIfAborted();
  const file = relationGraphPath(dataRoot);
  await assertGraphDirectory(dataRoot);
  const result = await withFileLock(file, async () => {
    signal?.throwIfAborted();
    const raw = (await managedGraphText(dataRoot)) ?? "";
    const graph = replayRelationGraph(raw);
    if (
      [...graph.entities.values()].some(
        (node) => node.type !== "Skill" || node.properties.formatVersion !== 2,
      )
    )
      throw new Error("stable-writer-on-legacy-graph");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      if (
        object(record) &&
        object(record.review) &&
        (record.review.batchId === batchId || record.review.eventId === eventId)
      )
        throw new Error("duplicate-review");
    }
    await assertCurrent();
    signal?.throwIfAborted();
    const registry = readRelationSources(dataRoot);
    await assertCurrentIdentities(
      pinned.flatMap((change) => [change.from, change.to]),
      registry,
    );
    const currentRegistry = readRelationSources(dataRoot);
    if (
      !registry ||
      !currentRegistry ||
      registryDigest(currentRegistry) !== registryDigest(registry)
    )
      throw new Error("stale-registry");
    const timestamp = new Date().toISOString();
    const operations: Record<string, unknown>[] = [];
    for (const change of pinned) {
      for (const identity of [change.from, change.to])
        assertNodeOwnership(graph, identity);
      const previous = graph.relations.filter(
        (edge) => edge.from === change.from.id && edge.to === change.to.id,
      );
      if (
        change.expected === null
          ? previous.length !== 0
          : previous.length !== 1 ||
            stable(previous[0]) !== stable(change.expected)
      )
        throw new Error("stale-relation");
      if (
        previous[0] &&
        (!relationTypes.includes(previous[0].rel as RelationType) ||
          !validProperties(previous[0].properties) ||
          previous[0].properties.formatVersion !== 2)
      )
        throw new Error("invalid-review-target");
      // Missing nodes cannot be an update/delete target even in a malformed log.
      if (
        change.operation !== "create" &&
        (!graph.entities.has(change.from.id) ||
          !graph.entities.has(change.to.id))
      )
        throw new Error("stale-relation");
      const review = {
        batchId,
        eventId,
        agentId,
        operation: change.operation,
        timestamp,
        previousRelation: previous[0] ?? null,
        rationale: change.rationale,
        evidence: change.evidence,
      };
      if (change.operation !== "delete") {
        for (const identity of [change.from, change.to]) {
          const existing = graph.entities.get(identity.id);
          const properties = identityProperties(identity);
          if (!existing) {
            const entity = {
              id: identity.id,
              type: "Skill",
              properties,
              created: timestamp,
              updated: timestamp,
            };
            operations.push({ op: "create", entity, timestamp });
            graph.entities.set(identity.id, entity);
          } else if (stable(existing.properties) !== stable(properties)) {
            operations.push({
              op: "update",
              id: identity.id,
              properties,
              timestamp,
            });
            graph.entities.set(identity.id, {
              ...existing,
              properties,
              updated: timestamp,
            });
          }
        }
      }
      if (previous[0])
        operations.push({
          op: "unrelate",
          from: previous[0].from,
          rel: previous[0].rel,
          to: previous[0].to,
          timestamp,
          review,
        });
      if (change.operation !== "delete") {
        const sourceGraphDigest = previous[0]?.properties.sourceGraphDigest;
        operations.push({
          op: "relate",
          from: change.from.id,
          rel: change.type,
          to: change.to.id,
          properties: {
            reason: change.reason,
            formatVersion: 2,
            fromFingerprint: change.from.fingerprint,
            toFingerprint: change.to.fingerprint,
            ...(sourceGraphDigest === undefined ? {} : { sourceGraphDigest }),
          },
          timestamp,
          review,
        });
      }
    }
    signal?.throwIfAborted();
    const appended = `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${operations.map((operation) => JSON.stringify(operation)).join("\n")}\n`;
    await writeTextAtomic(
      path.join(path.dirname(file), "schema.yaml"),
      stableRelationSchema,
      signal,
    );
    await writeTextAtomic(file, appended, signal);
    graphCache.delete(file);
    return { changed: pinned.length, batchId };
  });
  if (!result) throw new Error("Skill relation graph is busy");
  return result;
}

export async function appendImportedRelations(
  dataRoot: string,
  relations: readonly ImportedRelation[],
): Promise<{
  added: number;
  updated: number;
  unchanged: number;
  conflicts: string[];
  backupPath?: string;
}> {
  const file = relationGraphPath(dataRoot);
  await assertGraphDirectory(dataRoot);
  const result = await withFileLock(file, async () => {
    const raw = (await managedGraphText(dataRoot)) ?? "";
    const graph = replayRelationGraph(raw);
    const operations: Record<string, unknown>[] = [];
    const result: {
      added: number;
      updated: number;
      unchanged: number;
      conflicts: string[];
      backupPath?: string;
    } = { added: 0, updated: 0, unchanged: 0, conflicts: [] };
    const timestamp = new Date().toISOString();
    const registry = readRelationSources(dataRoot);
    const stableNodes = relations
      .flatMap((edge) => [edge.from, edge.to])
      .filter(stableIdentity);
    if (stableNodes.length)
      await assertCurrentIdentities(stableNodes, registry);
    if (
      stableNodes.length &&
      [...graph.entities.values()].some(
        (node) => node.properties.formatVersion !== 2,
      )
    )
      throw new Error("stable-writer-on-legacy-graph");
    if (
      [...graph.entities.values()].some(
        (node) => node.properties.formatVersion === 2,
      ) &&
      relations.some(
        (edge) => !stableIdentity(edge.from) || !stableIdentity(edge.to),
      )
    )
      throw new Error("legacy-writer-on-stable-graph");
    for (const edge of relations) {
      const properties = importedProperties(edge);
      if (
        !validIdentity(edge.from) ||
        !validIdentity(edge.to) ||
        edge.from.id === edge.to.id ||
        !relationTypes.includes(edge.type) ||
        !validProperties(properties)
      )
        throw new Error("Invalid imported relation");
      const previous = graph.relations.filter(
        (r) => r.from === edge.from.id && r.to === edge.to.id,
      );
      if (
        graph.reviewedPairs?.has(stable([edge.from.id, edge.to.id])) ||
        previous.some(
          (r) =>
            r.properties.source !== undefined &&
            r.properties.source !== "author-import",
        )
      ) {
        result.conflicts.push(`${edge.from.name} -> ${edge.to.name}`);
        continue;
      }
      for (const node of [edge.from, edge.to]) {
        const existing = graph.entities.get(node.id);
        if (
          existing &&
          (existing.type !== "Skill" ||
            (!stableIdentity(node) &&
              stable(existing.properties) !==
                stable(identityProperties(node))) ||
            (stableIdentity(node) &&
              (existing.properties.formatVersion !== 2 ||
                existing.properties.source_id !== node.source_id ||
                existing.properties.skill_key !== node.skill_key)))
        )
          throw new Error("Graph entity ownership conflict");
      }
      if (
        graph.entities.has(edge.from.id) &&
        graph.entities.has(edge.to.id) &&
        previous.length === 1 &&
        previous[0].rel === edge.type &&
        stable(previous[0].properties) === stable(properties) &&
        [edge.from, edge.to].every(
          (node) =>
            stable(graph.entities.get(node.id)?.properties) ===
            stable(identityProperties(node)),
        )
      ) {
        result.unchanged++;
        continue;
      }
      const batch: Record<string, unknown>[] = [];
      for (const node of [edge.from, edge.to]) {
        const properties = identityProperties(node);
        const existing = graph.entities.get(node.id);
        if (!existing)
          batch.push({
            op: "create",
            entity: {
              id: node.id,
              type: "Skill",
              properties,
              created: timestamp,
              updated: timestamp,
            },
            timestamp,
          });
        else if (stable(existing.properties) !== stable(properties))
          batch.push({ op: "update", id: node.id, properties, timestamp });
      }
      for (const type of new Set(previous.map((r) => r.rel)))
        batch.push({
          op: "unrelate",
          from: edge.from.id,
          rel: type,
          to: edge.to.id,
          timestamp,
        });
      batch.push({
        op: "relate",
        from: edge.from.id,
        rel: edge.type,
        to: edge.to.id,
        properties,
        timestamp,
      });
      operations.push(...batch);
      const delta = replayRelationGraph(
        batch.map((op) => JSON.stringify(op)).join("\n"),
      );
      for (const [id, entity] of delta.entities) graph.entities.set(id, entity);
      graph.relations = graph.relations.filter(
        (r) => r.from !== edge.from.id || r.to !== edge.to.id,
      );
      graph.relations.push(...delta.relations);
      if (previous.length) result.updated++;
      else result.added++;
    }
    if (operations.length) {
      if (raw) {
        result.backupPath = `${file}.backup-${randomUUID()}`;
        await fs.writeFile(result.backupPath, raw, { mode: 0o600, flag: "wx" });
      }
      await writeTextAtomic(
        path.join(path.dirname(file), "schema.yaml"),
        [...graph.entities.values()].some(
          (node) => node.properties.formatVersion === 2,
        )
          ? stableRelationSchema
          : relationSchema,
      );
      await writeTextAtomic(
        file,
        `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${operations.map((op) => JSON.stringify(op)).join("\n")}\n`,
      );
      graphCache.delete(file);
    }
    return result;
  });
  if (!result) throw new Error("Skill relation graph is busy");
  return result;
}
