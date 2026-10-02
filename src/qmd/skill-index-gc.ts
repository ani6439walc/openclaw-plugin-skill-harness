import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileLock,
  readJsonFile,
  withFileLock,
  writeJsonAtomic,
} from "../file-utils.js";

export const SKILL_INDEX_GC_GRACE_MS = 24 * 60 * 60 * 1000;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
interface GcState {
  schemaVersion: 1;
  orphanSince: Record<string, number>;
  retiredAgentSince: Record<string, number>;
}
interface Mapping {
  name: string;
  fingerprint: string;
}

function directory(target: string, create = false): boolean {
  if (!fs.existsSync(target)) {
    // lstat distinguishes an absent path from a dangling symlink.
    try {
      fs.lstatSync(target);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!create) return false;
    fs.mkdirSync(target, { recursive: true });
  }
  return fs.lstatSync(target).isDirectory();
}
function regularFile(target: string): boolean {
  return fs.lstatSync(target).isFile();
}

function validExistingLock(target: string): boolean {
  try {
    const entry = fs.lstatSync(target);
    if (!entry.isDirectory() || !regularFile(path.join(target, "owner.json")))
      return false;
    const owner = readJsonFile<{ pid?: unknown; createdAtMs?: unknown }>(
      path.join(target, "owner.json"),
    );
    return (
      Number.isInteger(owner?.pid) &&
      Number(owner.pid) > 0 &&
      typeof owner.createdAtMs === "number" &&
      Number.isFinite(owner.createdAtMs)
    );
  } catch (error) {
    // Missing owner metadata remains an unknown lock, not an absent lock.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      fs.lstatSync(target);
      return false;
    } catch (missing) {
      return (missing as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}

function marks(value: unknown): value is Record<string, number> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (time) => typeof time === "number" && Number.isFinite(time) && time >= 0,
    )
  );
}

/** Coordinates mapping writes, lifetime store leases, and orphan reclamation. */
export function createSkillIndexGc(params: {
  skillsRoot: string;
  nowMs?: () => number;
}) {
  const { skillsRoot } = params;
  const indexesRoot = path.join(skillsRoot, "indexes");
  const agentsRoot = path.join(skillsRoot, "agents");
  const leasesRoot = path.join(skillsRoot, "leases");
  const statePath = path.join(skillsRoot, "gc.json");
  const nowMs = params.nowMs ?? Date.now;

  async function withCatalog<T>(
    operation: () => Promise<T>,
    maxWaitMs = 1_000,
  ): Promise<T | undefined> {
    if (!directory(skillsRoot, true)) return;
    const lockPath = path.join(skillsRoot, "catalog.lock");
    if (!validExistingLock(lockPath)) return;
    return withFileLock(path.join(skillsRoot, "catalog"), operation, {
      maxWaitMs,
    });
  }

  /** Call only while holding the catalog lock, after publishing a reference. */
  function markReferenced(fingerprint: string): void {
    let state: GcState | undefined;
    try {
      if (regularFile(statePath)) state = readJsonFile<GcState>(statePath);
    } catch {
      // Leave absent, unreadable, or malformed GC state untouched.
    }
    if (
      state?.schemaVersion === 1 &&
      marks(state.orphanSince) &&
      marks(state.retiredAgentSince) &&
      Object.hasOwn(state.orphanSince, fingerprint)
    ) {
      delete state.orphanSince[fingerprint];
      writeJsonAtomic(statePath, state);
    }
  }

  async function acquire(
    fingerprint: string,
    allowCreate: boolean,
  ): Promise<(() => void) | undefined> {
    if (!fingerprintPattern.test(fingerprint)) return;
    try {
      return await withCatalog(async () => {
        if (!directory(indexesRoot, allowCreate)) return;
        const root = path.join(indexesRoot, fingerprint);
        if (!directory(root, allowCreate)) return;
        if (
          !allowCreate &&
          (!directory(path.join(root, "docs")) ||
            !regularFile(path.join(root, "skill-search.sqlite")))
        )
          return;
        if (!directory(leasesRoot, true)) return;
        const leaseRoot = path.join(leasesRoot, fingerprint);
        if (!directory(leaseRoot, true)) return;
        const lease = new FileLock(path.join(leaseRoot, randomUUID()));
        if (!(await lease.acquire({ maxWaitMs: 0 }))) return;
        try {
          markReferenced(fingerprint);
        } catch (error) {
          lease.release();
          throw error;
        }
        let released = false;
        return () => {
          if (!released) {
            released = true;
            lease.release();
          }
        };
      });
    } catch {
      return;
    }
  }

  function mappings(): Mapping[] {
    if (!directory(agentsRoot))
      throw new Error("Unsafe agent mapping directory");
    return fs.readdirSync(agentsRoot).map((name) => {
      const target = path.join(agentsRoot, name);
      if (!name.endsWith(".json") || !regularFile(target))
        throw new Error("Unsafe agent mapping");
      const data = readJsonFile<{
        schemaVersion?: unknown;
        fingerprint?: unknown;
        allowedSkillNames?: unknown;
      }>(target);
      if (
        data?.schemaVersion !== 1 ||
        typeof data.fingerprint !== "string" ||
        !fingerprintPattern.test(data.fingerprint) ||
        !Array.isArray(data.allowedSkillNames) ||
        !data.allowedSkillNames.every((name) => typeof name === "string")
      )
        throw new Error("Invalid agent mapping");
      return { name: name.slice(0, -5), fingerprint: data.fingerprint };
    });
  }

  async function unused(fingerprint: string): Promise<boolean> {
    if (!directory(leasesRoot, true)) return false;
    const root = path.join(leasesRoot, fingerprint);
    if (!fs.existsSync(root)) {
      try {
        fs.lstatSync(root);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    }
    if (!directory(root)) return false;
    for (const name of fs.readdirSync(root)) {
      if (
        !/^[a-f0-9-]{36}\.lock$/u.test(name) ||
        !directory(path.join(root, name))
      )
        return false;
      const ownerPath = path.join(root, name, "owner.json");
      if (!regularFile(ownerPath)) return false;
      const owner = readJsonFile<{ pid?: unknown; createdAtMs?: unknown }>(
        ownerPath,
      );
      if (
        !Number.isInteger(owner?.pid) ||
        Number(owner.pid) <= 0 ||
        typeof owner.createdAtMs !== "number" ||
        !Number.isFinite(owner.createdAtMs)
      )
        return false;
      const lease = new FileLock(path.join(root, name.slice(0, -5)));
      if (!(await lease.acquire({ maxWaitMs: 0 }))) return false;
      lease.release();
    }
    return true;
  }

  async function collect(
    options: {
      /** Authoritative active agent mapping filename stems, evaluated under the lock. */
      activeAgentKeys?: () => readonly string[] | undefined;
    } = {},
  ): Promise<{ removedIndexes: string[]; removedAgents: string[] }> {
    const result = {
      removedIndexes: [] as string[],
      removedAgents: [] as string[],
    };
    try {
      await withCatalog(async () => {
        if (!directory(indexesRoot, true)) return;
        let refs = mappings(); // Validate the entire catalog before any destructive work.
        if (fs.existsSync(statePath) && !regularFile(statePath)) return;
        const state: GcState = fs.existsSync(statePath)
          ? readJsonFile<GcState>(statePath)
          : { schemaVersion: 1, orphanSince: {}, retiredAgentSince: {} };
        if (
          (fs.existsSync(statePath) && !regularFile(statePath)) ||
          state?.schemaVersion !== 1 ||
          !marks(state.orphanSince) ||
          !marks(state.retiredAgentSince)
        )
          return;
        state.orphanSince = Object.assign(
          Object.create(null) as Record<string, number>,
          state.orphanSince,
        );
        state.retiredAgentSince = Object.assign(
          Object.create(null) as Record<string, number>,
          state.retiredAgentSince,
        );
        const persistedAgentKeys = new Set(refs.map((mapping) => mapping.name));
        for (const key of Object.keys(state.retiredAgentSince)) {
          if (!persistedAgentKeys.has(key)) delete state.retiredAgentSince[key];
        }
        const now = nowMs();
        const active = options.activeAgentKeys?.();
        const activeSet = active === undefined ? undefined : new Set(active);
        for (const mapping of refs) {
          if (!activeSet || activeSet.has(mapping.name)) {
            delete state.retiredAgentSince[mapping.name];
            continue;
          }
          const since = Object.hasOwn(state.retiredAgentSince, mapping.name)
            ? state.retiredAgentSince[mapping.name]!
            : now;
          state.retiredAgentSince[mapping.name] = since;
          if (now - since < SKILL_INDEX_GC_GRACE_MS) continue;
          const buildRoot = path.join(indexesRoot, mapping.fingerprint);
          if (!validExistingLock(`${buildRoot}.lock`)) continue;
          const build = new FileLock(buildRoot);
          if (!(await build.acquire({ maxWaitMs: 0 }))) continue;
          try {
            const indexUnused = await unused(mapping.fingerprint);
            const latestActive = options.activeAgentKeys?.();
            if (
              latestActive === undefined ||
              latestActive.includes(mapping.name)
            ) {
              delete state.retiredAgentSince[mapping.name];
              continue;
            }
            const sharedWithActiveAgent = mappings().some(
              (other) =>
                other.name !== mapping.name &&
                other.fingerprint === mapping.fingerprint &&
                latestActive.includes(other.name),
            );
            if (!indexUnused && !sharedWithActiveAgent) continue;
            fs.unlinkSync(path.join(agentsRoot, `${mapping.name}.json`));
            delete state.retiredAgentSince[mapping.name];
            result.removedAgents.push(mapping.name);
          } finally {
            build.release();
          }
        }
        refs = mappings();
        const referenced = new Set(refs.map((mapping) => mapping.fingerprint));
        const candidates = fs
          .readdirSync(indexesRoot)
          .filter(
            (name) =>
              fingerprintPattern.test(name) &&
              directory(path.join(indexesRoot, name)),
          );
        for (const name of Object.keys(state.orphanSince)) {
          if (referenced.has(name) || !candidates.includes(name))
            delete state.orphanSince[name];
        }
        for (const fingerprint of candidates) {
          if (referenced.has(fingerprint)) continue;
          const since = Object.hasOwn(state.orphanSince, fingerprint)
            ? state.orphanSince[fingerprint]!
            : now;
          state.orphanSince[fingerprint] = since;
          if (
            now - since < SKILL_INDEX_GC_GRACE_MS ||
            !(await unused(fingerprint))
          )
            continue;
          const root = path.join(indexesRoot, fingerprint);
          if (!validExistingLock(`${root}.lock`)) continue;
          const build = new FileLock(root);
          if (!(await build.acquire({ maxWaitMs: 0 }))) continue;
          try {
            if (
              mappings().some(
                (mapping) => mapping.fingerprint === fingerprint,
              ) ||
              !directory(root)
            )
              continue;
            fs.rmSync(root, { recursive: true });
            try {
              fs.rmdirSync(path.join(leasesRoot, fingerprint));
            } catch {
              // Remove only an empty lease directory; unexpected entries survive.
            }
            delete state.orphanSince[fingerprint];
            result.removedIndexes.push(fingerprint);
          } finally {
            build.release();
          }
        }
        writeJsonAtomic(statePath, state);
      }, 0);
    } catch {
      /* Ambiguous state is retained for a later maintenance pass. */
    }
    return result;
  }
  return { withCatalog, acquire, collect, markReferenced };
}
