import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import matter from "gray-matter";
import { withFileLock } from "../file-utils.js";
import { resolveConfinedFile } from "./paths.js";
import { canonicalIdentity } from "../normalize.js";

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
}
export interface ImportedRelation {
  from: SkillIdentity;
  to: SkillIdentity;
  type: RelationType;
  reason: string;
  scores?: RelationScores;
  classificationVersion?: string;
  model?: string;
}
export interface GraphRelatedSkill {
  name: string;
  reason: string;
  direction: "current-to-related" | "related-to-current";
  relation_type: RelationType;
  verification_status: "unverified";
  source: "author-import";
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
export async function readSkillIdentity(skill: {
  name: string;
  location: string;
}): Promise<SkillIdentity | undefined> {
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
  const graph: RelationGraph = { entities: new Map(), relations: [] };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
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
function validIdentity(value: unknown): value is SkillIdentity {
  return (
    object(value) &&
    string(value.id) &&
    string(value.name) &&
    string(value.source) &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    path.isAbsolute(value.source) &&
    value.id ===
      `skill_${hash(stable({ name: value.name, source: value.source, fingerprint: value.fingerprint }))}`
  );
}
function validProperties(p: Record<string, unknown>): boolean {
  return (
    p.source === "author-import" &&
    p.verification_status === "unverified" &&
    p.formatVersion === 1 &&
    typeof p.reason === "string" &&
    (p.classificationVersion === undefined ||
      string(p.classificationVersion)) &&
    (p.model === undefined || string(p.model)) &&
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
  const names = new Map<string, string>();
  // Read only skills named by graph nodes, not the whole inventory.
  const graphNames = new Set(
    [...graph.entities.values()].map((entity) => entity.properties.name),
  );
  for (const skill of skills) {
    if (!graphNames.has(skill.name)) continue;
    const identity = await readSkillIdentity(skill);
    if (!identity) continue;
    const node = graph.entities.get(identity.id);
    if (
      node?.type === "Skill" &&
      node.properties.formatVersion === 1 &&
      node.properties.name === identity.name &&
      node.properties.source === identity.source &&
      node.properties.fingerprint === identity.fingerprint
    )
      names.set(identity.id, skill.name);
  }
  const seen = new Set<string>();
  for (const edge of graph.relations) {
    const from = names.get(edge.from),
      to = names.get(edge.to);
    if (
      !from ||
      !to ||
      from === to ||
      !relationTypes.includes(edge.rel as RelationType) ||
      !validProperties(edge.properties)
    )
      continue;
    const key = stable([edge.from, edge.rel, edge.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [name, other, direction] of [
      [from, to, "current-to-related"],
      [to, from, "related-to-current"],
    ] as const) {
      const key = canonicalIdentity(name);
      const list = result.get(key) ?? [];
      list.push({
        name: other,
        reason: edge.properties.reason as string,
        direction,
        relation_type: edge.rel as RelationType,
        verification_status: "unverified",
        source: "author-import",
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
async function writeTextAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
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
  const result = await withFileLock(file, async () => {
    let raw = "";
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
    for (const edge of relations) {
      const properties = {
        reason: edge.reason,
        source: "author-import",
        verification_status: "unverified",
        formatVersion: 1,
        ...(edge.scores ? { scores: edge.scores } : {}),
        ...(edge.classificationVersion
          ? { classificationVersion: edge.classificationVersion }
          : {}),
        ...(edge.model ? { model: edge.model } : {}),
      };
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
      if (previous.some((r) => r.properties.source !== "author-import")) {
        result.conflicts.push(`${edge.from.name} -> ${edge.to.name}`);
        continue;
      }
      for (const node of [edge.from, edge.to]) {
        const existing = graph.entities.get(node.id);
        if (
          existing &&
          (existing.type !== "Skill" ||
            stable(existing.properties) !==
              stable({
                name: node.name,
                source: node.source,
                fingerprint: node.fingerprint,
                formatVersion: 1,
              }))
        )
          throw new Error("Graph entity ownership conflict");
      }
      if (
        graph.entities.has(edge.from.id) &&
        graph.entities.has(edge.to.id) &&
        previous.length === 1 &&
        previous[0].rel === edge.type &&
        stable(previous[0].properties) === stable(properties)
      ) {
        result.unchanged++;
        continue;
      }
      const batch: Record<string, unknown>[] = [];
      for (const node of [edge.from, edge.to]) {
        const properties = {
          name: node.name,
          source: node.source,
          fingerprint: node.fingerprint,
          formatVersion: 1,
        };
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
        relationSchema,
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
