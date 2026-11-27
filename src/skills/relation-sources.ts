import { lstatSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import matter from "gray-matter";
import { readJsonFile, withFileLock, writeJsonAtomic } from "../file-utils.js";
import { canonicalIdentity } from "../normalize.js";
import { resolveConfinedFile } from "./paths.js";
import type { SkillSource } from "./types.js";

export interface RelationSourceBinding {
  name: string;
  source_path: string;
}

export interface RelationSource {
  id: string;
  root: string;
  label?: string;
  skills: Record<string, RelationSourceBinding>;
}

export interface RelationSourceRegistry {
  version: 1;
  sources: RelationSource[];
}

export interface RegisterRelationSourceInput {
  id?: string;
  root: string;
  label?: string;
  skills: Record<string, RelationSourceBinding>;
  rebind?: boolean;
  rename?: boolean;
  removeKeys?: readonly string[];
}

export interface ResolvedRelationSource {
  id: string;
  source_id: string;
  skill_key: string;
  source_path: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function fail(): never {
  throw new Error("Invalid relation source registry");
}

function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}

function repositorySegments(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.length >= 2 &&
    parts.every(
      (part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== "..",
    )
  );
}

/** Normalize only supported origin identifiers, never transport URLs or credentials. */
export function canonicalRelationSourceId(value: string): string {
  if (!text(value)) fail();
  if (value.startsWith("github:")) {
    const repository = value
      .slice(7)
      .replace(/\.git$/i, "")
      .toLowerCase();
    if (!repositorySegments(repository) || repository.split("/").length !== 2)
      fail();
    return `github:${repository}`;
  }
  if (value.startsWith("local:")) {
    const uuid = value.slice(6).toLowerCase();
    if (!uuidPattern.test(uuid)) fail();
    return `local:${uuid}`;
  }
  if (value.startsWith("git:")) {
    const match = /^git:([^/]+)\/(.+)$/.exec(value);
    if (!match) fail();
    const host = match[1].toLowerCase();
    const repository = match[2].replace(/\.git$/i, "");
    const [hostname, port] = host.split(":");
    if (
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/.test(host) ||
      hostname.split(".").some((part) => !part) ||
      (port !== undefined && Number(port) > 65535) ||
      !repositorySegments(repository)
    )
      fail();
    return `git:${host}/${repository}`;
  }
  return fail();
}

function validSkillKey(value: string): boolean {
  return (
    value === canonicalIdentity(value) &&
    /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value)
  );
}

export function stableSkillId(sourceId: string, skillKey: string): string {
  if (!validSkillKey(skillKey)) fail();
  return `${canonicalRelationSourceId(sourceId)}:${skillKey}`;
}

export function relationSourcesPath(dataRoot: string): string {
  return path.join(dataRoot, "skill-relations", "sources.json");
}

function validSourcePath(value: string): boolean {
  return (
    text(value) &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..") &&
    path.posix.basename(value) === "SKILL.md"
  );
}

/** Validate managed state without repairing, guessing, or discarding entries. */
export function validateRelationSources(
  input: unknown,
): RelationSourceRegistry {
  if (!object(input) || input.version !== 1 || !Array.isArray(input.sources))
    fail();
  fields(input, ["version", "sources"]);
  const ids = new Set<string>();
  const localRoots = new Set<string>();
  const locations = new Set<string>();
  const sources: RelationSource[] = [];
  for (const candidate of input.sources) {
    if (
      !object(candidate) ||
      !text(candidate.id) ||
      canonicalRelationSourceId(candidate.id) !== candidate.id ||
      ids.has(candidate.id) ||
      !text(candidate.root) ||
      !path.isAbsolute(candidate.root) ||
      path.normalize(candidate.root) !== candidate.root ||
      !object(candidate.skills) ||
      (candidate.label !== undefined && !text(candidate.label))
    )
      fail();
    fields(candidate, ["id", "root", "label", "skills"]);
    ids.add(candidate.id);
    if (candidate.id.startsWith("local:")) {
      if (localRoots.has(candidate.root)) fail();
      localRoots.add(candidate.root);
    }
    const names = new Set<string>();
    const skills: [string, RelationSourceBinding][] = [];
    for (const [key, binding] of Object.entries(candidate.skills)) {
      if (
        !validSkillKey(key) ||
        !object(binding) ||
        !text(binding.name) ||
        !text(binding.source_path) ||
        !validSourcePath(binding.source_path)
      )
        fail();
      fields(binding, ["name", "source_path"]);
      const name = canonicalIdentity(binding.name);
      const location = path.join(candidate.root, binding.source_path);
      if (names.has(name) || locations.has(location)) fail();
      names.add(name);
      locations.add(location);
      skills.push([
        key,
        { name: binding.name, source_path: binding.source_path },
      ]);
    }
    sources.push({
      id: candidate.id,
      root: candidate.root,
      ...(candidate.label === undefined ? {} : { label: candidate.label }),
      skills: Object.fromEntries(skills),
    });
  }
  return { version: 1, sources };
}

function readManagedRegistry(
  dataRoot: string,
): RelationSourceRegistry | undefined {
  const file = relationSourcesPath(dataRoot);
  try {
    if (!lstatSync(path.dirname(file)).isDirectory()) fail();
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return validateRelationSources(readJsonFile<unknown>(file));
}

/** Missing or invalid publication disables graph identities until a valid one appears. */
export function readRelationSources(
  dataRoot: string,
): RelationSourceRegistry | undefined {
  try {
    return readManagedRegistry(dataRoot);
  } catch {
    return;
  }
}

async function bindingFile(
  source: Pick<RelationSource, "root">,
  binding: RelationSourceBinding,
): Promise<string | undefined> {
  const location = path.join(source.root, binding.source_path);
  return resolveConfinedFile(path.dirname(location), location);
}

/** Resolve actual files only after origin bindings and the winning skill name match. */
export async function resolveRelationSource(
  skill: { name: string; location: string },
  registry: RelationSourceRegistry,
): Promise<ResolvedRelationSource | undefined> {
  try {
    if (path.basename(skill.location) !== "SKILL.md") return;
    const actual = await resolveConfinedFile(
      path.dirname(skill.location),
      skill.location,
    );
    if (!actual) return;
    let result: ResolvedRelationSource | undefined;
    for (const source of registry.sources) {
      for (const [key, binding] of Object.entries(source.skills)) {
        if (binding.name !== skill.name) continue;
        if ((await bindingFile(source, binding)) !== actual) continue;
        if (result) return;
        result = {
          id: stableSkillId(source.id, key),
          source_id: source.id,
          skill_key: key,
          source_path: binding.source_path,
        };
      }
    }
    return result;
  } catch {
    return;
  }
}

/** Explicit registration is the only operation allowed to allocate a local UUID. */
export async function registerRelationSource(
  dataRoot: string,
  input: RegisterRelationSourceInput,
): Promise<RelationSource> {
  if (
    !object(input) ||
    !text(input.root) ||
    !object(input.skills) ||
    (input.id !== undefined && !text(input.id)) ||
    (input.label !== undefined && !text(input.label)) ||
    (input.rebind !== undefined && typeof input.rebind !== "boolean") ||
    (input.rename !== undefined && typeof input.rename !== "boolean") ||
    (input.removeKeys !== undefined &&
      (!Array.isArray(input.removeKeys) ||
        input.removeKeys.some(
          (key) => typeof key !== "string" || !validSkillKey(key),
        ) ||
        new Set(input.removeKeys).size !== input.removeKeys.length))
  )
    fail();
  fields(input, [
    "id",
    "root",
    "label",
    "skills",
    "rebind",
    "rename",
    "removeKeys",
  ]);
  const directory = path.dirname(relationSourcesPath(dataRoot));
  try {
    if (!lstatSync(directory).isDirectory()) fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const root = await fs.realpath(input.root);
  if (!(await fs.stat(root)).isDirectory()) fail();
  const result = await withFileLock(
    path.join(directory, "graph.jsonl"),
    async () => {
      await fs.chmod(directory, 0o700);
      const registry = readManagedRegistry(dataRoot) ?? {
        version: 1,
        sources: [],
      };
      const existingLocal = registry.sources.find(
        (source) => source.root === root && source.id.startsWith("local:"),
      );
      const id =
        input.id === undefined
          ? (existingLocal?.id ?? `local:${randomUUID()}`)
          : canonicalRelationSourceId(input.id);
      const previous = registry.sources.find((source) => source.id === id);
      if (previous && previous.root !== root && !input.rebind)
        throw new Error("Relation source rebind requires explicit permission");
      const skills = { ...previous?.skills };
      for (const key of input.removeKeys ?? []) {
        if (
          !previous ||
          !Object.hasOwn(previous.skills, key) ||
          Object.hasOwn(input.skills, key)
        )
          fail();
        delete skills[key];
      }
      for (const [key, binding] of Object.entries(input.skills)) {
        const old =
          previous && Object.hasOwn(previous.skills, key)
            ? previous.skills[key]
            : undefined;
        if (
          old &&
          (old.name !== binding.name ||
            old.source_path !== binding.source_path) &&
          !input.rename
        )
          throw new Error(
            "Relation source rename requires explicit permission",
          );
        Object.defineProperty(skills, key, {
          value: binding,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const source: RelationSource = {
        id,
        root,
        ...(input.label === undefined
          ? previous?.label === undefined
            ? {}
            : { label: previous.label }
          : { label: input.label }),
        skills,
      };
      const next = validateRelationSources({
        version: 1,
        sources: [
          ...registry.sources.filter((entry) => entry.id !== id),
          source,
        ],
      });
      for (const [key, binding] of Object.entries(
        input.rebind ? source.skills : input.skills,
      )) {
        const file = await bindingFile(source, binding);
        if (!file) fail();
        const parsed = matter(await fs.readFile(file, "utf8"));
        if (
          typeof parsed.data.name !== "string" ||
          parsed.data.name.trim() !== binding.name ||
          (
            await resolveRelationSource(
              { name: binding.name, location: file },
              next,
            )
          )?.id !== stableSkillId(id, key)
        )
          fail();
      }
      next.sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      writeJsonAtomic(relationSourcesPath(dataRoot), next);
      await fs.chmod(relationSourcesPath(dataRoot), 0o600);
      return next.sources.find((entry) => entry.id === id)!;
    },
  );
  if (!result) throw new Error("Skill relation graph is busy");
  return result;
}

export interface KnownRelationRoot {
  path: string;
  source?: SkillSource;
  label?: string;
}

export interface EnsureKnownRelationSourcesParams {
  dataRoot: string;
  skills: readonly { name: string; location: string; source?: SkillSource }[];
  roots: readonly KnownRelationRoot[];
  signal?: AbortSignal;
}

export interface EnsureKnownRelationSourcesResult {
  registeredCount: number;
  createdSourceIds: string[];
}

interface ResolvedKnownRoot {
  logicalRoot: string;
  realRoot: string;
  source?: SkillSource;
  label?: string;
}

const syncQueues = new Map<string, Promise<void>>();

function enqueueRelationSourceSync<T>(
  dataRoot: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(dataRoot);
  const previous = syncQueues.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  syncQueues.set(key, tail);
  void tail.finally(() => {
    if (syncQueues.get(key) === tail) syncQueues.delete(key);
  });
  return run;
}

async function resolveKnownRoots(
  roots: readonly KnownRelationRoot[],
  signal?: AbortSignal,
): Promise<ResolvedKnownRoot[]> {
  const seenLogical = new Set<string>();
  const resolved: ResolvedKnownRoot[] = [];
  for (const entry of roots) {
    signal?.throwIfAborted();
    if (!entry.path?.trim()) continue;
    const logicalRoot = path.resolve(entry.path);
    if (seenLogical.has(logicalRoot)) continue;
    seenLogical.add(logicalRoot);
    try {
      const realRoot = await fs.realpath(logicalRoot);
      const stat = await fs.stat(realRoot);
      if (!stat.isDirectory()) continue;
      resolved.push({
        logicalRoot,
        realRoot,
        source: entry.source,
        label: entry.label,
      });
    } catch {
      // Missing or inaccessible root; skip without failing sibling roots.
    }
  }
  resolved.sort((a, b) => b.logicalRoot.length - a.logicalRoot.length);
  return resolved;
}

function relativeSourcePath(
  rootDir: string,
  targetPath: string,
): string | undefined {
  const rel = path.relative(rootDir, targetPath);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  )
    return;
  const posixRel = rel.split(path.sep).join("/");
  return validSourcePath(posixRel) ? posixRel : undefined;
}

async function matchSkillToKnownRoot(
  skill: { name: string; location: string },
  actual: string,
  roots: readonly ResolvedKnownRoot[],
): Promise<{ root: ResolvedKnownRoot; sourcePath: string } | undefined> {
  const resolvedLocation = path.resolve(skill.location);
  for (const root of roots) {
    const candidates = [
      relativeSourcePath(root.logicalRoot, resolvedLocation),
      relativeSourcePath(root.realRoot, actual),
    ];
    for (const sourcePath of candidates) {
      if (!sourcePath) continue;
      if (
        (await bindingFile(
          { root: root.realRoot },
          { name: skill.name, source_path: sourcePath },
        )) === actual
      ) {
        return { root, sourcePath };
      }
    }
  }
  return;
}

async function collectBoundState(registry: RelationSourceRegistry): Promise<{
  boundActualFiles: Set<string>;
  existingLocations: Set<string>;
}> {
  const boundActualFiles = new Set<string>();
  const existingLocations = new Set<string>();
  for (const source of registry.sources) {
    for (const binding of Object.values(source.skills)) {
      existingLocations.add(path.join(source.root, binding.source_path));
      const actual = await bindingFile(source, binding);
      if (actual) boundActualFiles.add(actual);
    }
  }
  return { boundActualFiles, existingLocations };
}

function deriveAutoSkillKey(
  skillName: string,
  sourcePath: string,
  existingSkills: Record<string, RelationSourceBinding>,
): string | undefined {
  let base = canonicalIdentity(skillName);
  if (!validSkillKey(base)) {
    base = base
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/-+$/u, "");
  }
  if (!validSkillKey(base)) {
    base = `skill-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 8)}`;
  }
  if (!validSkillKey(base)) return;
  if (!Object.hasOwn(existingSkills, base)) return base;
  const suffixed = `${base}-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 8)}`;
  if (!validSkillKey(suffixed) || Object.hasOwn(existingSkills, suffixed))
    return;
  return suffixed;
}

function defaultRootLabel(root: ResolvedKnownRoot): string | undefined {
  if (root.label && text(root.label)) return root.label;
  if (root.source) return `${root.source} skills`;
  return;
}

/**
 * Automatically register unregistered valid skills located inside known OpenClaw
 * skill roots. Reuses each root's existing local UUID, preserves existing
 * remote/local bindings without creating duplicate aliases, and fails closed on
 * corrupt or symlinked registry state.
 */
export async function ensureKnownRelationSources(
  params: EnsureKnownRelationSourcesParams,
): Promise<EnsureKnownRelationSourcesResult | undefined> {
  params.signal?.throwIfAborted();
  if (!params.skills.length || !params.roots.length) {
    return { registeredCount: 0, createdSourceIds: [] };
  }
  const sourcesFile = relationSourcesPath(params.dataRoot);
  const directory = path.dirname(sourcesFile);
  try {
    const dirStat = lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  let precheckRegistry: RelationSourceRegistry | undefined;
  try {
    precheckRegistry = readManagedRegistry(params.dataRoot);
  } catch {
    return;
  }
  const resolvedRoots = await resolveKnownRoots(params.roots, params.signal);
  if (!resolvedRoots.length) {
    return { registeredCount: 0, createdSourceIds: [] };
  }
  const boundActualFiles = precheckRegistry
    ? (await collectBoundState(precheckRegistry)).boundActualFiles
    : new Set<string>();
  let hasCandidate = false;
  for (const skill of params.skills) {
    params.signal?.throwIfAborted();
    if (!text(skill.name) || path.basename(skill.location) !== "SKILL.md")
      continue;
    const actual = await resolveConfinedFile(
      path.dirname(skill.location),
      skill.location,
    );
    if (!actual || boundActualFiles.has(actual)) continue;
    if (await matchSkillToKnownRoot(skill, actual, resolvedRoots)) {
      hasCandidate = true;
      break;
    }
  }
  if (!hasCandidate) {
    return { registeredCount: 0, createdSourceIds: [] };
  }

  return enqueueRelationSourceSync(params.dataRoot, async () => {
    params.signal?.throwIfAborted();
    try {
      const dirStat = lstatSync(directory);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    return withFileLock(path.join(directory, "graph.jsonl"), async () => {
      params.signal?.throwIfAborted();
      let current: RelationSourceRegistry | undefined;
      try {
        current = readManagedRegistry(params.dataRoot);
      } catch {
        return undefined;
      }
      const nextSources: RelationSource[] = (current?.sources ?? []).map(
        (source) => ({
          ...source,
          skills: { ...source.skills },
        }),
      );
      const { boundActualFiles, existingLocations } = await collectBoundState({
        version: 1,
        sources: nextSources,
      });
      const localByRoot = new Map<string, RelationSource>();
      const namesBySource = new Map<RelationSource, Set<string>>();
      for (const source of nextSources) {
        if (source.id.startsWith("local:")) {
          localByRoot.set(source.root, source);
        }
        namesBySource.set(
          source,
          new Set(
            Object.values(source.skills).map((binding) =>
              canonicalIdentity(binding.name),
            ),
          ),
        );
      }

      let registeredCount = 0;
      const createdSourceIds: string[] = [];

      for (const skill of params.skills) {
        params.signal?.throwIfAborted();
        if (!text(skill.name) || path.basename(skill.location) !== "SKILL.md")
          continue;
        const actual = await resolveConfinedFile(
          path.dirname(skill.location),
          skill.location,
        );
        if (!actual || boundActualFiles.has(actual)) continue;
        const matched = await matchSkillToKnownRoot(
          skill,
          actual,
          resolvedRoots,
        );
        if (!matched) continue;
        try {
          const parsed = matter(await fs.readFile(actual, "utf8"));
          if (
            typeof parsed.data.name !== "string" ||
            parsed.data.name.trim() !== skill.name
          )
            continue;
        } catch {
          continue;
        }
        const candidateLocation = path.join(
          matched.root.realRoot,
          matched.sourcePath,
        );
        if (existingLocations.has(candidateLocation)) continue;

        let targetSource = localByRoot.get(matched.root.realRoot);
        const canonicalName = canonicalIdentity(skill.name);
        if (
          targetSource &&
          namesBySource.get(targetSource)?.has(canonicalName)
        ) {
          continue;
        }
        const key = deriveAutoSkillKey(
          skill.name,
          matched.sourcePath,
          targetSource?.skills ?? {},
        );
        if (!key) continue;

        if (!targetSource) {
          const id = `local:${randomUUID()}`;
          const label = defaultRootLabel(matched.root);
          targetSource = {
            id,
            root: matched.root.realRoot,
            ...(label === undefined ? {} : { label }),
            skills: {},
          };
          nextSources.push(targetSource);
          localByRoot.set(matched.root.realRoot, targetSource);
          namesBySource.set(targetSource, new Set());
          createdSourceIds.push(id);
        }

        Object.defineProperty(targetSource.skills, key, {
          value: { name: skill.name, source_path: matched.sourcePath },
          enumerable: true,
          writable: true,
          configurable: true,
        });
        boundActualFiles.add(actual);
        existingLocations.add(candidateLocation);
        namesBySource.get(targetSource)!.add(canonicalName);
        registeredCount += 1;
      }

      if (registeredCount === 0) {
        return { registeredCount: 0, createdSourceIds: [] };
      }

      nextSources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const validated = validateRelationSources({
        version: 1,
        sources: nextSources,
      });
      await fs.mkdir(directory, { recursive: true });
      await fs.chmod(directory, 0o700);
      writeJsonAtomic(sourcesFile, validated);
      await fs.chmod(sourcesFile, 0o600);
      return { registeredCount, createdSourceIds };
    });
  });
}
