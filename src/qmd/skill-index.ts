import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { createStore, QMDStore } from "@wei840222/qmd";
import matter from "gray-matter";
import { logger } from "../../api.js";
import type { AvailableSkill } from "../skills/types.js";
import type { ResolvedQmdConfig } from "../types.js";
import { weightedReciprocalRankFusion } from "./rrf.js";

const META_COLLECTION = "skill-meta";
const BODY_COLLECTION = "skill-body";
const REFS_COLLECTION = "skill-references";
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_CANDIDATE_LIMIT = 40;
const MAX_EVIDENCE_PER_SKILL = 3;

type QmdCreateStore = typeof createStore;

type CollectionKind = "meta" | "body" | "reference";

type SearchHit = {
  skillName: string;
  collection: string;
  path: string;
  score: number;
  snippet?: string;
  explain?: unknown;
};

export type SkillQmdEvidence = {
  collection: string;
  path: string;
  score: number;
  snippet?: string;
  explain?: unknown;
};

export type SkillQmdSearchHit = {
  name: string;
  score: number;
  evidence?: SkillQmdEvidence[];
};

export type SkillQmdIndexStatus = "idle" | "building" | "ready" | "failed";

export interface SkillQmdIndex {
  schedule(agentId: string, skills: readonly AvailableSkill[]): void;
  search(params: {
    agentId: string;
    query: string;
    limit: number;
    includeEvidence?: boolean;
  }): Promise<SkillQmdSearchHit[] | undefined>;
  getStatus(agentId: string): SkillQmdIndexStatus;
  close(): Promise<void>;
}

type AgentState = {
  status: SkillQmdIndexStatus;
  store?: QMDStore;
  generationRoot?: string;
  currentFingerprint?: string;
  expectedFingerprint?: string;
  desired?: {
    fingerprint: string;
    skills: readonly AvailableSkill[];
  };
  running?: Promise<void>;
  failedFingerprint?: string;
  consecutiveFailures: number;
  nextRetryAtMs: number;
  lastScheduleStartedAtMs: number;
  generation: number;
  cooldownTimer?: unknown;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findLastPathSegmentIndex(
  parts: readonly string[],
  candidates: readonly string[],
): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (candidates.includes(parts[index]!)) return index;
  }
  return -1;
}

export function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "_";
  const encoded = encodeURIComponent(trimmed)
    .replaceAll("*", "%2A")
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
  return encoded.length <= 180 ? encoded : `${hash(trimmed).slice(0, 24)}`;
}

async function listReferenceFiles(skillDir: string): Promise<string[]> {
  const referencesRoot = path.join(skillDir, "references");
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(
          path.relative(referencesRoot, entryPath).split(path.sep).join("/"),
        );
      }
    }
  }

  await walk(referencesRoot);
  return files;
}

async function referenceFingerprint(skillDir: string): Promise<string[]> {
  const files = await listReferenceFiles(skillDir);
  const identities: string[] = [];
  for (const relative of files) {
    try {
      const absolute = path.join(skillDir, "references", relative);
      const raw = await fs.readFile(absolute);
      identities.push(`${relative}:${hash(raw.toString("utf8"))}`);
    } catch {
      identities.push(`${relative}:missing`);
    }
  }
  return identities;
}

async function snapshotFingerprint(
  agentId: string,
  skills: readonly AvailableSkill[],
  config: ResolvedQmdConfig,
): Promise<string> {
  const ordered = [...skills].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const skillEntries = await Promise.all(
    ordered.map(async (skill) => {
      let bodyHash = "missing";
      try {
        bodyHash = hash(await fs.readFile(skill.location, "utf8"));
      } catch {
        bodyHash = "missing";
      }
      return {
        name: skill.name,
        source: skill.source ?? null,
        location: skill.location,
        description: skill.description,
        bodyHash,
        references: await referenceFingerprint(path.dirname(skill.location)),
      };
    }),
  );
  return hash(
    JSON.stringify({
      agentId,
      skills: skillEntries,
      qmd: config,
    }),
  );
}

function documentBody(params: {
  skill: AvailableSkill;
  kind: CollectionKind;
  relativePath: string;
  content: string;
}): string {
  return matter.stringify(`${params.content.trimEnd()}\n`, {
    skill: params.skill.name,
    source: params.skill.source ?? "extra",
    kind: params.kind,
    path: params.relativePath,
  });
}

export async function writeSkillSnapshot(params: {
  docsRoot: string;
  skills: readonly AvailableSkill[];
}): Promise<Record<string, { path: string; pattern: string }>> {
  const metaRoot = path.join(params.docsRoot, "meta");
  const bodyRoot = path.join(params.docsRoot, "body");
  const referencesRoot = path.join(params.docsRoot, "references");
  await Promise.all([
    fs.mkdir(metaRoot, { recursive: true }),
    fs.mkdir(bodyRoot, { recursive: true }),
    fs.mkdir(referencesRoot, { recursive: true }),
  ]);

  for (const skill of params.skills) {
    const skillSegment = safePathSegment(skill.name);
    const skillDir = path.dirname(skill.location);
    const metaPath = path.join(metaRoot, skillSegment, "meta.md");
    const bodyPath = path.join(bodyRoot, skillSegment, "SKILL.md");
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.mkdir(path.dirname(bodyPath), { recursive: true });
    await fs.writeFile(
      metaPath,
      documentBody({
        skill,
        kind: "meta",
        relativePath: "meta.md",
        content: `# ${skill.name}\n\n${skill.description}`.trim(),
      }),
      "utf8",
    );

    let bodyContent = "";
    try {
      bodyContent = await fs.readFile(skill.location, "utf8");
    } catch (error) {
      logger.warn("failed to read skill body for QMD snapshot", {
        error,
        skill: skill.name,
        location: skill.location,
      });
      bodyContent = skill.description;
    }
    await fs.writeFile(
      bodyPath,
      documentBody({
        skill,
        kind: "body",
        relativePath: "SKILL.md",
        content: bodyContent,
      }),
      "utf8",
    );

    for (const relative of await listReferenceFiles(skillDir)) {
      const sourcePath = path.join(skillDir, "references", relative);
      const targetPath = path.join(referencesRoot, skillSegment, relative);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      let content = "";
      try {
        content = await fs.readFile(sourcePath, "utf8");
      } catch (error) {
        logger.warn("failed to read skill reference for QMD snapshot", {
          error,
          skill: skill.name,
          path: relative,
        });
        continue;
      }
      await fs.writeFile(
        targetPath,
        documentBody({
          skill,
          kind: "reference",
          relativePath: `references/${relative}`,
          content,
        }),
        "utf8",
      );
    }
  }

  return {
    [META_COLLECTION]: { path: metaRoot, pattern: "**/*.md" },
    [BODY_COLLECTION]: { path: bodyRoot, pattern: "**/*.md" },
    [REFS_COLLECTION]: { path: referencesRoot, pattern: "**/*" },
  };
}

function parseFrontmatterIdentity(raw: string | undefined): {
  skillName?: string;
  relativePath?: string;
  snippet?: string;
} {
  if (!raw) return {};
  try {
    const parsed = matter(raw);
    return {
      skillName:
        typeof parsed.data.skill === "string"
          ? parsed.data.skill.trim()
          : undefined,
      relativePath:
        typeof parsed.data.path === "string"
          ? parsed.data.path.trim()
          : undefined,
      snippet: parsed.content.trim().slice(0, 240) || undefined,
    };
  } catch {
    return {};
  }
}

function hitId(
  hit: Pick<SearchHit, "skillName" | "collection" | "path">,
): string {
  return `${hit.skillName}\u0000${hit.collection}\u0000${hit.path}`;
}

function parseStoreHits(params: {
  results: readonly {
    body?: string;
    filepath?: string;
    file?: string;
    displayPath?: string;
    score: number;
    explain?: unknown;
  }[];
  collection: string;
}): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const result of params.results) {
    if (!Number.isFinite(result.score)) continue;
    const fromBody = parseFrontmatterIdentity(result.body);
    let skillName = fromBody.skillName;
    let relativePath = fromBody.relativePath;
    const filepath = result.filepath ?? result.file ?? result.displayPath;
    if ((!skillName || !relativePath) && filepath) {
      const parts = filepath.split(/[\\/]/u);
      const skillIdx = findLastPathSegmentIndex(parts, [
        "meta",
        "body",
        "references",
      ]);
      if (skillIdx >= 0 && parts[skillIdx + 1]) {
        const encoded = parts[skillIdx + 1];
        try {
          skillName = skillName ?? decodeURIComponent(encoded);
        } catch {
          skillName = skillName ?? encoded;
        }
        const remainder = parts.slice(skillIdx + 2).join("/");
        if (!relativePath) {
          if (remainder) {
            relativePath =
              params.collection === REFS_COLLECTION &&
              !remainder.startsWith("references/")
                ? `references/${remainder}`
                : remainder;
          } else if (params.collection === META_COLLECTION) {
            relativePath = "meta.md";
          } else if (params.collection === BODY_COLLECTION) {
            relativePath = "SKILL.md";
          } else {
            relativePath = "references/unknown";
          }
        }
      }
    }
    if (!skillName) continue;
    hits.push({
      skillName,
      collection: params.collection,
      path: relativePath ?? "unknown",
      score: result.score,
      ...(fromBody.snippet ? { snippet: fromBody.snippet } : {}),
      ...(result.explain === undefined ? {} : { explain: result.explain }),
    });
  }
  return hits;
}

export function createSkillQmdIndex(params: {
  dataRoot: string;
  config: () => ResolvedQmdConfig;
  createStore?: QmdCreateStore;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): SkillQmdIndex {
  const agents = new Map<string, AgentState>();
  const now = () => params.nowMs?.() ?? Date.now();
  const setTimer =
    params.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    params.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  function agentRoot(agentId: string): string {
    return path.join(
      params.dataRoot,
      "qmd",
      "skills",
      safePathSegment(agentId),
    );
  }

  function getState(agentId: string): AgentState {
    const existing = agents.get(agentId);
    if (existing) return existing;
    const created: AgentState = {
      status: "idle",
      consecutiveFailures: 0,
      nextRetryAtMs: 0,
      lastScheduleStartedAtMs: 0,
      generation: 0,
    };
    agents.set(agentId, created);
    return created;
  }

  function clearCooldownTimer(state: AgentState): void {
    if (state.cooldownTimer === undefined) return;
    clearTimer(state.cooldownTimer);
    state.cooldownTimer = undefined;
  }

  function armCooldownResume(agentId: string, state: AgentState): void {
    if (state.cooldownTimer !== undefined || state.running || !state.desired) {
      return;
    }
    const cooldownMs = params.config().skillSearch.scheduleCooldownMs;
    if (cooldownMs <= 0 || !state.store || state.lastScheduleStartedAtMs <= 0) {
      return;
    }
    const remainingMs = Math.max(
      0,
      cooldownMs - (now() - state.lastScheduleStartedAtMs),
    );
    state.cooldownTimer = setTimer(() => {
      state.cooldownTimer = undefined;
      maybeStart(agentId, state);
    }, remainingMs);
  }

  function resetRetryState(state: AgentState): void {
    state.failedFingerprint = undefined;
    state.consecutiveFailures = 0;
    state.nextRetryAtMs = 0;
  }

  function recordBuildFailure(
    state: AgentState,
    fingerprint: string,
    error: unknown,
  ): void {
    state.consecutiveFailures =
      state.failedFingerprint === fingerprint
        ? state.consecutiveFailures + 1
        : 1;
    state.failedFingerprint = fingerprint;
    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (state.consecutiveFailures - 1),
      MAX_RETRY_DELAY_MS,
    );
    state.nextRetryAtMs = now() + delayMs;
    state.status = state.store ? "ready" : "failed";
    logger.warn("failed to refresh QMD skill index", { error, delayMs });
  }

  async function build(
    agentId: string,
    state: AgentState,
    target: { fingerprint: string; skills: readonly AvailableSkill[] },
  ): Promise<void> {
    state.status = "building";
    state.lastScheduleStartedAtMs = now();
    state.generation += 1;
    const generationRoot = path.join(
      agentRoot(agentId),
      `gen-${state.generation}-${target.fingerprint.slice(0, 12)}`,
    );
    let nextStore: QMDStore | undefined;
    try {
      const qmd = params.config();
      if (
        !qmd.embedding.baseUrl ||
        !qmd.embedding.model ||
        !qmd.expansion.baseUrl ||
        !qmd.expansion.model
      ) {
        throw new Error(
          "QMD embedding and expansion endpoints must be configured.",
        );
      }
      await fs.mkdir(generationRoot, { recursive: true });
      const collections = await writeSkillSnapshot({
        docsRoot: path.join(generationRoot, "docs"),
        skills: target.skills,
      });
      // Dynamic import keeps tests able to inject createStore without loading
      // the native QMD package at module evaluation time.
      const createQmdStore =
        params.createStore ?? (await import("@wei840222/qmd")).createStore;
      nextStore = await createQmdStore({
        dbPath: path.join(generationRoot, "skill-search.sqlite"),
        config: {
          collections,
          models: {
            embed_api_url: qmd.embedding.baseUrl,
            embed_api_model: qmd.embedding.model,
            ...(qmd.embedding.apiKey
              ? { embed_api_key: qmd.embedding.apiKey }
              : {}),
            ...(qmd.embedding.dimension
              ? { embed_dimension: qmd.embedding.dimension }
              : {}),
            generate_api_url: qmd.expansion.baseUrl,
            generate_api_model: qmd.expansion.model,
            ...(qmd.expansion.apiKey
              ? { generate_api_key: qmd.expansion.apiKey }
              : {}),
          },
        },
        remoteRequestTimeoutMs: qmd.timeoutMs,
      });
      await nextStore.update();
      await nextStore.embed();

      if (state.desired && state.desired.fingerprint !== target.fingerprint) {
        await nextStore.close();
        await fs
          .rm(generationRoot, { recursive: true, force: true })
          .catch(() => undefined);
        return;
      }

      const previousStore = state.store;
      const previousRoot = state.generationRoot;
      state.store = nextStore;
      state.generationRoot = generationRoot;
      state.currentFingerprint = target.fingerprint;
      state.status = "ready";
      resetRetryState(state);
      if (previousStore) {
        await previousStore.close().catch((error: unknown) => {
          logger.warn("failed to close previous QMD skill index", { error });
        });
      }
      if (previousRoot && previousRoot !== generationRoot) {
        await fs
          .rm(previousRoot, { recursive: true, force: true })
          .catch(() => undefined);
      }
    } catch (error) {
      if (nextStore) await nextStore.close().catch(() => undefined);
      await fs
        .rm(generationRoot, { recursive: true, force: true })
        .catch(() => undefined);
      recordBuildFailure(state, target.fingerprint, error);
    }
  }

  async function runWorker(agentId: string, state: AgentState): Promise<void> {
    try {
      while (state.desired) {
        const cooldownMs = params.config().skillSearch.scheduleCooldownMs;
        const sinceLastStart = now() - state.lastScheduleStartedAtMs;
        if (
          state.store &&
          cooldownMs > 0 &&
          state.lastScheduleStartedAtMs > 0 &&
          sinceLastStart < cooldownMs
        ) {
          break;
        }
        clearCooldownTimer(state);
        const target = state.desired;
        state.desired = undefined;
        await build(agentId, state, target);
      }
    } finally {
      state.running = undefined;
      armCooldownResume(agentId, state);
    }
  }

  function maybeStart(agentId: string, state: AgentState): void {
    if (state.running || !state.desired) return;
    const cooldownMs = params.config().skillSearch.scheduleCooldownMs;
    const sinceLastStart = now() - state.lastScheduleStartedAtMs;
    if (
      state.store &&
      cooldownMs > 0 &&
      state.lastScheduleStartedAtMs > 0 &&
      sinceLastStart < cooldownMs
    ) {
      armCooldownResume(agentId, state);
      return;
    }
    clearCooldownTimer(state);
    state.running = runWorker(agentId, state);
  }

  function scheduleLocked(
    agentId: string,
    skills: readonly AvailableSkill[],
  ): void {
    const state = getState(agentId);
    void (async () => {
      const fingerprint = await snapshotFingerprint(
        agentId,
        skills,
        params.config(),
      );
      if (
        fingerprint === state.currentFingerprint &&
        !state.desired &&
        state.store
      ) {
        state.expectedFingerprint = fingerprint;
        return;
      }
      state.expectedFingerprint = fingerprint;
      if (
        state.failedFingerprint === fingerprint &&
        now() < state.nextRetryAtMs
      ) {
        return;
      }

      state.desired = { fingerprint, skills: [...skills] };
      maybeStart(agentId, state);
    })().catch((error: unknown) => {
      logger.warn("failed to schedule QMD skill index", { error, agentId });
    });
  }

  return {
    schedule(agentId, skills) {
      scheduleLocked(agentId.trim() || "main", skills);
    },
    async search({ agentId, query, limit, includeEvidence }) {
      const state = agents.get(agentId.trim() || "main");
      const activeStore = state?.store;
      if (!activeStore) return;

      const qmd = params.config();
      const candidateLimit = Math.max(limit, DEFAULT_CANDIDATE_LIMIT);
      const collections = [
        {
          name: META_COLLECTION,
          weight: qmd.skillSearch.collectionWeights.meta,
        },
        {
          name: BODY_COLLECTION,
          weight: qmd.skillSearch.collectionWeights.body,
        },
        {
          name: REFS_COLLECTION,
          weight: qmd.skillSearch.collectionWeights.references,
        },
      ];

      try {
        const collectionHits = await Promise.all(
          collections.map(async (collection) => {
            const results = await activeStore.search({
              query,
              collection: collection.name,
              limit: candidateLimit,
              candidateLimit,
              rerank: false,
              includeHyde: false,
              minScore: 0,
            });
            const ranked = parseStoreHits({
              results: results as Array<{
                filepath?: string;
                file?: string;
                displayPath?: string;
                body?: string;
                score: number;
                explain?: unknown;
              }>,
              collection: collection.name,
            }).sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              return hitId(left).localeCompare(hitId(right));
            });
            return { collection, ranked };
          }),
        );

        const fused = weightedReciprocalRankFusion({
          lists: collectionHits.map((entry) =>
            entry.ranked.map((hit) => ({ id: hitId(hit) })),
          ),
          weights: collectionHits.map((entry) => entry.collection.weight),
        });

        const hitById = new Map<string, SearchHit>();
        for (const entry of collectionHits) {
          for (const hit of entry.ranked) {
            hitById.set(hitId(hit), hit);
          }
        }

        const bestBySkill = new Map<
          string,
          { score: number; evidence: SkillQmdEvidence[] }
        >();
        for (const fusedHit of fused) {
          const hit = hitById.get(fusedHit.id);
          if (!hit) continue;
          const evidence: SkillQmdEvidence = {
            collection: hit.collection,
            path: hit.path,
            score: fusedHit.score,
            ...(hit.snippet ? { snippet: hit.snippet } : {}),
            ...(hit.explain === undefined ? {} : { explain: hit.explain }),
          };
          const existing = bestBySkill.get(hit.skillName);
          if (!existing) {
            bestBySkill.set(hit.skillName, {
              score: fusedHit.score,
              evidence: [evidence],
            });
            continue;
          }
          if (fusedHit.score > existing.score) {
            existing.score = fusedHit.score;
          }
          existing.evidence.push(evidence);
          existing.evidence.sort((left, right) => right.score - left.score);
          if (existing.evidence.length > MAX_EVIDENCE_PER_SKILL) {
            existing.evidence.length = MAX_EVIDENCE_PER_SKILL;
          }
        }

        return [...bestBySkill.entries()]
          .map(([name, value]) => ({
            name,
            score: value.score,
            ...(includeEvidence ? { evidence: value.evidence } : {}),
          }))
          .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return left.name.localeCompare(right.name);
          })
          .slice(0, Math.max(1, limit));
      } catch (error) {
        logger.warn("QMD skill search failed", { error, agentId });
        return;
      }
    },
    getStatus(agentId) {
      return agents.get(agentId.trim() || "main")?.status ?? "idle";
    },
    async close() {
      for (const state of agents.values()) {
        state.desired = undefined;
        clearCooldownTimer(state);
      }
      await Promise.all(
        [...agents.values()]
          .map((state) => state.running)
          .filter((running): running is Promise<void> => running !== undefined),
      );
      for (const [agentId, state] of agents.entries()) {
        const activeStore = state.store;
        state.store = undefined;
        state.currentFingerprint = undefined;
        state.expectedFingerprint = undefined;
        resetRetryState(state);
        state.status = "idle";
        if (activeStore) await activeStore.close().catch(() => undefined);
        if (state.generationRoot) {
          await fs
            .rm(state.generationRoot, { recursive: true, force: true })
            .catch(() => undefined);
        }
        await fs
          .rm(agentRoot(agentId), { recursive: true, force: true })
          .catch(() => undefined);
      }
      agents.clear();
    },
  };
}
