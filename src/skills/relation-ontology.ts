import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { canonicalIdentity } from "../normalize.js";
import { resolveConfinedFile } from "./paths.js";
import {
  destinationGraphDigest,
  publishRelationSnapshot,
  readSkillIdentity,
  registryDigest,
  relationDigest,
  relationGraphPath,
  relationTypes,
  replayRelationGraph,
} from "./relation-graph.js";
import type {
  ImportedRelation,
  RelationGraph,
  RelationType,
  SkillIdentity,
} from "./relation-graph.js";
import {
  canonicalRelationSourceId,
  readRelationSources,
  relationSourcesPath,
  stableSkillId,
} from "./relation-sources.js";
import type { RelationSource } from "./relation-sources.js";

export interface OntologyImportInput {
  dataRoot: string;
  graphFile: string;
  schemaFile: string;
  sourceId: string;
  additionalSourceIds?: readonly string[];
}

export interface OntologyImportPlan {
  version: 2;
  sourceId: string;
  additionalSourceIds: string[];
  graphFile: string;
  schemaFile: string;
  graphDigest: string;
  schemaDigest: string;
  sourceDigest: string;
  sourcesDigest: string;
  expectedGraphDigest: string | null;
  identities: SkillIdentity[];
  relations: ImportedRelation[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();
const ordered = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fail(reason: string): never {
  throw new Error(`Invalid ontology import: ${reason}`);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function additionalSources(
  values: readonly string[],
  primary: string,
): string[] {
  for (const value of values) {
    if (
      typeof value !== "string" ||
      canonicalRelationSourceId(value) !== value ||
      value === primary
    )
      fail("additional-source-id");
  }
  return [...new Set(values)].sort(ordered);
}
function exactly(values: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(values) &&
    values.length === expected.length &&
    values.every((value) => typeof value === "string") &&
    [...values]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}
function sourcePath(value: unknown): value is string {
  return (
    string(value) &&
    value === value.trim() &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..") &&
    path.posix.basename(value) === "SKILL.md"
  );
}
function schemaPattern(raw: string, sourceId: string): RegExp {
  const schema: unknown = matter(`---\n${raw}\n---\n`).data;
  if (
    !object(schema) ||
    schema.version !== 2 ||
    !object(schema.identity) ||
    schema.identity.format !== "<provider>:<repository>:<skill>" ||
    !object(schema.sources) ||
    !object(schema.sources[sourceId]) ||
    !object(schema.types) ||
    !object(schema.types.Skill) ||
    !exactly(schema.types.Skill.required, ["name", "source_path"]) ||
    !object(schema.types.Skill.properties) ||
    schema.types.Skill.properties.name !== "string" ||
    schema.types.Skill.properties.source_path !== "string" ||
    !object(schema.relations) ||
    !exactly(Object.keys(schema.relations), relationTypes)
  )
    fail("schema-profile");
  for (const value of Object.values(schema.relations)) {
    if (
      !object(value) ||
      !exactly(value.from_types, ["Skill"]) ||
      !exactly(value.to_types, ["Skill"]) ||
      !exactly(value.required, ["reason"]) ||
      !object(value.properties) ||
      value.properties.reason !== "string" ||
      (value.cardinality !== undefined &&
        value.cardinality !== "many_to_many") ||
      (value.acyclic !== undefined && value.acyclic !== false)
    )
      fail("schema-relation");
  }
  const pattern = schema.sources[sourceId].skills;
  if (!sourcePath(pattern) || /[?\[\]{}]/u.test(pattern)) fail("schema-source");
  const parts = pattern.split("/");
  const expression = parts
    .map((part, index) => {
      if (part === "**") return "(?:[^/]+/)*";
      return (
        part
          .split("*")
          .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*") + (index < parts.length - 1 ? "/" : "")
      );
    })
    .join("");
  return new RegExp(`^${expression}$`, "u");
}

/** The source log shares ontology replay semantics, with catalog-specific invariants. */
function sourceGraph(raw: string): RelationGraph {
  const active = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const record: unknown = JSON.parse(line);
    if (!object(record)) fail("operation");
    if (record.op === "create") {
      if (
        !object(record.entity) ||
        !string(record.entity.id) ||
        record.entity.type !== "Skill" ||
        active.has(record.entity.id)
      )
        fail("duplicate-or-invalid-node");
      active.add(record.entity.id);
    } else if (record.op === "delete") {
      if (!string(record.id)) fail("delete");
      active.delete(record.id);
    }
  }
  return replayRelationGraph(raw);
}

async function inputFile(
  file: string,
  source: RelationSource,
): Promise<string> {
  if (!path.isAbsolute(file)) fail("source-file-path");
  const resolved = await resolveConfinedFile(source.root, file);
  if (!resolved) fail("source-file-outside-root");
  return resolved;
}

/** Full replacement is limited to author-owned records from this registered source. */
async function assertDestinationScope(
  dataRoot: string,
  source: RelationSource,
  identities: readonly SkillIdentity[],
  additionalSourceIds: readonly string[],
  expected: string | null,
): Promise<void> {
  if (expected === null) return;
  const raw = await fs.readFile(relationGraphPath(dataRoot), "utf8");
  if (relationDigest(raw) !== expected) fail("stale-destination");
  const graph = replayRelationGraph(raw);
  // Full source replacement must never erase Review edits or deletion tombstones.
  // A deliberate reset uses the lower-level publishRelationSnapshot API.
  if (graph.reviewedPairs?.size) fail("reviewed-destination-history");
  const supplementalNodes = new Set<string>();
  for (const node of graph.entities.values()) {
    if (node.type !== "Skill") fail("foreign-destination-node");
    if (node.properties.formatVersion === 2) {
      if (additionalSourceIds.includes(node.properties.source_id as string)) {
        const identity = identities.find((entry) => entry.id === node.id);
        if (
          !identity ||
          canonical(node.properties) !==
            canonical({
              name: identity.name,
              source_id: identity.source_id,
              skill_key: identity.skill_key,
              source_path: identity.source_path,
              formatVersion: 2,
            })
        )
          fail("changed-supplemental-node");
        supplementalNodes.add(node.id);
        continue;
      }
      if (
        node.properties.source_id !== source.id ||
        !string(node.properties.skill_key) ||
        stableSkillId(source.id, node.properties.skill_key) !== node.id
      )
        fail("foreign-destination-source");
    } else if (node.properties.formatVersion === 1) {
      if (
        !identities.some(
          (identity) =>
            identity.source_id === source.id &&
            identity.name === node.properties.name &&
            identity.source === node.properties.source,
        )
      )
        fail("foreign-legacy-source");
    } else fail("destination-version");
  }
  for (const edge of graph.relations) {
    if (
      !graph.entities.has(edge.from) ||
      !graph.entities.has(edge.to) ||
      (edge.properties.source !== undefined &&
        edge.properties.source !== "author-import") ||
      supplementalNodes.has(edge.from) ||
      supplementalNodes.has(edge.to)
    )
      fail("foreign-destination-relation");
  }
}

/** Build an exact source snapshot; no models, registry writes or graph publication. */
export async function preflightOntologyImport(
  input: OntologyImportInput,
): Promise<OntologyImportPlan> {
  if (canonicalRelationSourceId(input.sourceId) !== input.sourceId)
    fail("source-id");
  const additionalSourceIds = additionalSources(
    input.additionalSourceIds ?? [],
    input.sourceId,
  );
  const registry = readRelationSources(input.dataRoot);
  const source = registry?.sources.find((entry) => entry.id === input.sourceId);
  if (!registry || !source) fail("missing-source-registry");
  const graphFile = await inputFile(input.graphFile, source);
  const schemaFile = await inputFile(input.schemaFile, source);
  if (graphFile === schemaFile) fail("source-files");
  const [raw, schemaRaw] = await Promise.all([
    fs.readFile(graphFile, "utf8"),
    fs.readFile(schemaFile, "utf8"),
  ]);
  const pattern = schemaPattern(schemaRaw, source.id);
  const graph = sourceGraph(raw);
  const graphDigest = relationDigest(raw);
  const schemaDigest = relationDigest(schemaRaw);
  const sourceDigest = relationDigest(canonical({ graphDigest, schemaDigest }));
  const identities: SkillIdentity[] = [];
  const names = new Set<string>();
  for (const node of [...graph.entities.values()].sort((a, b) =>
    ordered(a.id, b.id),
  )) {
    const { name, source_path: relative } = node.properties;
    if (
      node.type !== "Skill" ||
      !string(name) ||
      name !== name.trim() ||
      !sourcePath(relative) ||
      !pattern.test(relative) ||
      !node.id.startsWith(`${source.id}:`)
    )
      fail("node-identity");
    const key = node.id.slice(source.id.length + 1);
    const binding = source.skills[key];
    if (
      stableSkillId(source.id, key) !== node.id ||
      !binding ||
      binding.name !== name ||
      binding.source_path !== relative ||
      names.has(canonicalIdentity(name))
    )
      fail("node-binding");
    names.add(canonicalIdentity(name));
    const location = path.join(source.root, relative);
    if (!(await resolveConfinedFile(path.dirname(location), location)))
      fail("skill-file");
    const identity = await readSkillIdentity({ name, location }, registry);
    if (!identity || identity.id !== node.id) fail("current-identity");
    identities.push(identity);
  }
  if (identities.length !== Object.keys(source.skills).length)
    fail("incomplete-catalog");
  const nodes = new Map(identities.map((identity) => [identity.id, identity]));
  const pairs = new Set<string>();
  const relations: ImportedRelation[] = [];
  for (const edge of graph.relations) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    const pair = canonical([edge.from, edge.to]);
    if (
      !from ||
      !to ||
      from.id === to.id ||
      pairs.has(pair) ||
      !relationTypes.includes(edge.rel as RelationType) ||
      !string(edge.properties.reason)
    )
      fail("relation-invariant");
    pairs.add(pair);
    relations.push({
      from,
      to,
      type: edge.rel as RelationType,
      reason: edge.properties.reason,
      sourceGraphDigest: sourceDigest,
    });
  }
  relations.sort(
    (a, b) => ordered(a.from.id, b.from.id) || ordered(a.to.id, b.to.id),
  );
  for (const id of additionalSourceIds) {
    const additional = registry.sources.find((entry) => entry.id === id);
    if (!additional) fail("missing-additional-source");
    for (const key of Object.keys(additional.skills).sort(ordered)) {
      const binding = additional.skills[key];
      const identity = await readSkillIdentity(
        {
          name: binding.name,
          location: path.join(additional.root, binding.source_path),
        },
        registry,
      );
      if (!identity || identity.id !== stableSkillId(id, key))
        fail("additional-source-binding");
      identities.push(identity);
    }
  }
  identities.sort((a, b) => ordered(a.id, b.id));
  const expectedGraphDigest = await destinationGraphDigest(input.dataRoot);
  await assertDestinationScope(
    input.dataRoot,
    source,
    identities,
    additionalSourceIds,
    expectedGraphDigest,
  );
  // Detect source changes that occurred while resolving every endpoint.
  const [graphNow, schemaNow] = await Promise.all([
    fs.readFile(graphFile, "utf8"),
    fs.readFile(schemaFile, "utf8"),
  ]);
  if (
    graphNow !== raw ||
    schemaNow !== schemaRaw ||
    registryDigest(
      readRelationSources(input.dataRoot) ?? { version: 1, sources: [] },
    ) !== registryDigest(registry)
  )
    fail("source-changed-during-preflight");
  return {
    version: 2,
    sourceId: source.id,
    additionalSourceIds,
    graphFile,
    schemaFile,
    graphDigest,
    schemaDigest,
    sourceDigest,
    sourcesDigest: registryDigest(registry),
    expectedGraphDigest,
    identities,
    relations,
  };
}

/** A saved plan is compared with authoritative source again under the writer lock. */
export async function applyOntologyImport(
  dataRoot: string,
  plan: OntologyImportPlan,
) {
  if (
    !object(plan) ||
    plan.version !== 2 ||
    !string(plan.sourceId) ||
    !string(plan.graphFile) ||
    !string(plan.schemaFile)
  )
    fail("plan-shape");
  const pinned = structuredClone(plan);
  const assertCurrent = async () => {
    const fresh = await preflightOntologyImport({
      dataRoot,
      sourceId: pinned.sourceId,
      additionalSourceIds: pinned.additionalSourceIds,
      graphFile: pinned.graphFile,
      schemaFile: pinned.schemaFile,
    });
    if (canonical(pinned) !== canonical(fresh)) fail("stale-or-modified-plan");
  };
  await assertCurrent();
  return publishRelationSnapshot(
    dataRoot,
    pinned.identities,
    pinned.relations,
    {
      expectedGraphDigest: pinned.expectedGraphDigest,
      expectedSourcesDigest: pinned.sourcesDigest,
      assertSourceCurrent: assertCurrent,
    },
  );
}

/** Resolve not-yet-created outputs before mkdir, including parent symlink aliases. */
async function plannedRealPath(file: string): Promise<string> {
  let current = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function planOutputPath(
  output: string,
  dataRoot: string,
  plan: OntologyImportPlan,
): Promise<string> {
  const lexical = path.resolve(output);
  const resolved = await plannedRealPath(lexical);
  const registry = readRelationSources(dataRoot);
  if (!registry || registryDigest(registry) !== plan.sourcesDigest)
    fail("stale-registry");
  for (const source of registry.sources) {
    if (
      inside(source.root, lexical) ||
      inside(await plannedRealPath(source.root), resolved)
    )
      fail("plan-output-inside-source");
  }
  const protectedFiles = [
    plan.graphFile,
    plan.schemaFile,
    relationGraphPath(dataRoot),
    path.join(path.dirname(relationGraphPath(dataRoot)), "schema.yaml"),
    relationSourcesPath(dataRoot),
  ];
  for (const file of protectedFiles) {
    if (
      path.resolve(file) === lexical ||
      (await plannedRealPath(file)) === resolved
    )
      fail("plan-output-conflict");
  }
  return resolved;
}

export async function runOntologyImportCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const flags: Record<string, string> = {};
  const allowed = new Set([
    "data-root",
    "graph",
    "schema",
    "source-id",
    "additional-source-ids",
    "output",
    "plan",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (
      !flag?.startsWith("--") ||
      !args[index + 1] ||
      !allowed.has(flag.slice(2)) ||
      flags[flag.slice(2)] !== undefined
    )
      fail("arguments");
    flags[flag.slice(2)] = args[index + 1];
  }
  if (
    !["preflight", "apply"].includes(command) ||
    !flags["data-root"] ||
    !flags.graph ||
    !flags.schema ||
    !flags["source-id"]
  )
    fail("arguments");
  if (command === "preflight") {
    if (flags.plan) fail("arguments");
    const plan = await preflightOntologyImport({
      dataRoot: flags["data-root"],
      graphFile: flags.graph,
      schemaFile: flags.schema,
      sourceId: flags["source-id"],
      additionalSourceIds: flags["additional-source-ids"]?.split(",") ?? [],
    });
    if (flags.output) {
      const output = await planOutputPath(
        flags.output,
        flags["data-root"],
        plan,
      );
      const directory = path.dirname(output);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
        fail("plan-directory-not-private");
      writeJsonAtomic(output, plan);
      await fs.chmod(output, 0o600);
    }
    console.log(
      JSON.stringify({
        nodes: plan.identities.length,
        relations: plan.relations.length,
        sourceDigest: plan.sourceDigest,
        sourcesDigest: plan.sourcesDigest,
        expectedGraphDigest: plan.expectedGraphDigest,
      }),
    );
    return;
  }
  if (!flags.plan || flags.output) fail("plan-required");
  const plan = readJsonFile<OntologyImportPlan>(flags.plan);
  if (
    !object(plan) ||
    plan.sourceId !== flags["source-id"] ||
    plan.graphFile !== (await fs.realpath(flags.graph)) ||
    plan.schemaFile !== (await fs.realpath(flags.schema)) ||
    canonical(plan.additionalSourceIds) !==
      canonical(
        additionalSources(
          flags["additional-source-ids"]?.split(",") ?? [],
          flags["source-id"],
        ),
      )
  )
    fail("plan-input-mismatch");
  const result = await applyOntologyImport(flags["data-root"], plan);
  console.log(
    JSON.stringify({
      nodes: result.nodes,
      relations: result.relations,
      graphDigest: result.graphDigest,
      backupCreated: result.backupPath !== undefined,
    }),
  );
}
