import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FileLock, writeJsonAtomic } from "../file-utils.js";
import {
  createSkillIndexGc,
  SKILL_INDEX_GC_GRACE_MS,
} from "./skill-index-gc.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
describe("skill index garbage collection", () => {
  let root: string;
  let now: number;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-index-gc-"));
    now = 100;
    fs.mkdirSync(path.join(root, "agents"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const gc = () => createSkillIndexGc({ skillsRoot: root, nowMs: () => now });
  function index(id = a) {
    const target = path.join(root, "indexes", id);
    fs.mkdirSync(path.join(target, "docs"), { recursive: true });
    fs.writeFileSync(path.join(target, "skill-search.sqlite"), "database");
    return target;
  }
  function mapping(name: string, id = a) {
    writeJsonAtomic(path.join(root, "agents", `${name}.json`), {
      schemaVersion: 1,
      fingerprint: id,
      allowedSkillNames: ["test"],
    });
  }
  it("persists the full grace period across coordinator restarts", async () => {
    const target = index();
    expect((await gc().collect()).removedIndexes).toEqual([]);
    now += SKILL_INDEX_GC_GRACE_MS - 1;
    expect((await gc().collect()).removedIndexes).toEqual([]);
    now++;
    expect((await gc().collect()).removedIndexes).toEqual([a]);
    expect(fs.existsSync(target)).toBe(false);
  });
  it("clears orphan age on restored references and preserves shared references", async () => {
    index();
    await gc().collect();
    mapping("one");
    mapping("two");
    now += SKILL_INDEX_GC_GRACE_MS;
    expect((await gc().collect()).removedIndexes).toEqual([]);
    fs.unlinkSync(path.join(root, "agents", "one.json"));
    expect((await gc().collect()).removedIndexes).toEqual([]);
    fs.unlinkSync(path.join(root, "agents", "two.json"));
    expect((await gc().collect()).removedIndexes).toEqual([]);
    now += SKILL_INDEX_GC_GRACE_MS;
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("aborts a sweep if any mapping is corrupt or a symlink", async () => {
    index();
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    mapping("valid", b);
    const bad = path.join(root, "agents", "bad.json");
    fs.writeFileSync(bad, "{");
    expect((await gc().collect()).removedIndexes).toEqual([]);
    fs.unlinkSync(bad);
    fs.symlinkSync(path.join(root, "agents", "valid.json"), bad);
    expect((await gc().collect()).removedIndexes).toEqual([]);
    fs.unlinkSync(bad);
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("protects lifetime leases across independent instances until both release", async () => {
    index();
    const releaseOne = await gc().acquire(a, false);
    const releaseTwo = await gc().acquire(a, false);
    expect(releaseOne).toBeTypeOf("function");
    expect(releaseTwo).toBeTypeOf("function");
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    expect((await gc().collect()).removedIndexes).toEqual([]);
    releaseOne!();
    expect((await gc().collect()).removedIndexes).toEqual([]);
    releaseTwo!();
    releaseTwo!();
    expect((await gc().collect()).removedIndexes).toEqual([a]);
    expect(fs.existsSync(path.join(root, "leases", a))).toBe(false);
  });
  it("does not wait for a build lock or a catalog lock", async () => {
    const target = index();
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    const build = new FileLock(target);
    expect(await build.acquire()).toBe(true);
    expect((await gc().collect()).removedIndexes).toEqual([]);
    build.release();
    const catalog = new FileLock(path.join(root, "catalog"));
    expect(await catalog.acquire()).toBe(true);
    expect((await gc().collect()).removedIndexes).toEqual([]);
    catalog.release();
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("waits for removed-agent grace, cancels on restoration, then starts index grace", async () => {
    index();
    mapping("gone");
    await gc().collect({ activeAgentKeys: () => [] });
    now += SKILL_INDEX_GC_GRACE_MS;
    expect(
      (await gc().collect({ activeAgentKeys: () => ["gone"] })).removedAgents,
    ).toEqual([]);
    expect(
      (await gc().collect({ activeAgentKeys: () => [] })).removedAgents,
    ).toEqual([]);
    now += SKILL_INDEX_GC_GRACE_MS;
    const release = await gc().acquire(a, false);
    expect(
      (await gc().collect({ activeAgentKeys: () => [] })).removedAgents,
    ).toEqual([]);
    release!();
    expect(await gc().collect({ activeAgentKeys: () => [] })).toEqual({
      removedAgents: ["gone"],
      removedIndexes: [],
    });
    now += SKILL_INDEX_GC_GRACE_MS;
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("retains mappings when the authoritative agent catalog is unavailable", async () => {
    index();
    mapping("agent");
    await gc().collect({ activeAgentKeys: () => [] });
    now += SKILL_INDEX_GC_GRACE_MS;
    expect(
      (await gc().collect({ activeAgentKeys: () => undefined })).removedAgents,
    ).toEqual([]);
    expect(fs.existsSync(path.join(root, "agents", "agent.json"))).toBe(true);
  });
  it("ignores symlink index directories and does not follow a symlink skills root", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, "indexes"));
    fs.symlinkSync(outside, path.join(root, "indexes", a));
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    expect((await gc().collect()).removedIndexes).toEqual([]);
    const link = path.join(root, "linked");
    fs.symlinkSync(outside, link);
    expect(
      await createSkillIndexGc({ skillsRoot: link }).acquire(b, true),
    ).toBeUndefined();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("creates leases before builds and requires existing documents/database for discovery", async () => {
    expect(await gc().acquire(a, false)).toBeUndefined();
    const release = await gc().acquire(a, true);
    expect(release).toBeTypeOf("function");
    expect(await gc().acquire(a, false)).toBeUndefined();
    release!();
    expect(await gc().acquire("../escape", true)).toBeUndefined();
  });
  it("preserves indexes with unknown or malformed lease owners", async () => {
    index();
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    const leaseRoot = path.join(
      root,
      "leases",
      a,
      "11111111-1111-1111-1111-111111111111.lock",
    );
    fs.mkdirSync(leaseRoot, { recursive: true });
    expect((await gc().collect()).removedIndexes).toEqual([]);
    writeJsonAtomic(path.join(leaseRoot, "owner.json"), {
      pid: -1,
      createdAtMs: now,
    });
    expect((await gc().collect()).removedIndexes).toEqual([]);
    fs.rmSync(leaseRoot, { recursive: true });
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("reclaims abandoned leases only after their owner exits", async () => {
    index();
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(child.status).toBe(0);
    const leaseRoot = path.join(
      root,
      "leases",
      a,
      "11111111-1111-1111-1111-111111111111.lock",
    );
    writeJsonAtomic(path.join(leaseRoot, "owner.json"), {
      pid: child.pid,
      createdAtMs: Date.now(),
    });
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("does not prune a removed agent while its build lock is held", async () => {
    const target = index();
    mapping("gone");
    await gc().collect({ activeAgentKeys: () => [] });
    now += SKILL_INDEX_GC_GRACE_MS;
    const build = new FileLock(target);
    expect(await build.acquire()).toBe(true);
    expect(
      (await gc().collect({ activeAgentKeys: () => [] })).removedAgents,
    ).toEqual([]);
    build.release();
    expect(
      (await gc().collect({ activeAgentKeys: () => [] })).removedAgents,
    ).toEqual(["gone"]);
  });
  it("skips cleanup if the mapping directory is missing", async () => {
    index();
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    fs.rmdirSync(path.join(root, "agents"));
    expect((await gc().collect()).removedIndexes).toEqual([]);
  });
  it("rechecks the active catalog immediately before removing a mapping", async () => {
    index();
    mapping("restored");
    await gc().collect({ activeAgentKeys: () => [] });
    now += SKILL_INDEX_GC_GRACE_MS;
    let calls = 0;
    expect(
      (
        await gc().collect({
          activeAgentKeys: () => (++calls === 1 ? [] : ["restored"]),
        })
      ).removedAgents,
    ).toEqual([]);
    expect(fs.existsSync(path.join(root, "agents", "restored.json"))).toBe(
      true,
    );
  });
  it("serializes concurrent catalog writers", async () => {
    const owner = gc();
    const written = await Promise.all([
      owner.withCatalog(async () => {
        mapping("one");
        return "one";
      }),
      owner.withCatalog(async () => {
        mapping("two");
        return "two";
      }),
    ]);
    expect(written).toEqual(["one", "two"]);
  });
  it("retires a mapping with live leases only when another active agent retains its index", async () => {
    const target = index();
    mapping("retired");
    mapping("current");
    const release = await gc().acquire(a, false);
    await gc().collect({ activeAgentKeys: () => ["current"] });
    now += SKILL_INDEX_GC_GRACE_MS;
    expect(await gc().collect({ activeAgentKeys: () => ["current"] })).toEqual({
      removedAgents: ["retired"],
      removedIndexes: [],
    });
    expect(fs.existsSync(path.join(root, "agents", "current.json"))).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    release!();
  });
  it("rechecks the active shared reference after waiting for locks", async () => {
    index();
    mapping("retired");
    mapping("current");
    const release = await gc().acquire(a, false);
    await gc().collect({ activeAgentKeys: () => ["current"] });
    now += SKILL_INDEX_GC_GRACE_MS;
    let calls = 0;
    expect(
      (
        await gc().collect({
          activeAgentKeys: () => (++calls === 1 ? ["current"] : []),
        })
      ).removedAgents,
    ).toEqual([]);
    release!();
  });
  it("restarts orphan grace after usage between collection passes", async () => {
    index();
    await gc().collect();
    now += SKILL_INDEX_GC_GRACE_MS - 1;
    const release = await gc().acquire(a, false);
    expect(release).toBeTypeOf("function");
    release!();
    now++;
    expect((await gc().collect()).removedIndexes).toEqual([]);
    now += SKILL_INDEX_GC_GRACE_MS - 1;
    expect((await gc().collect()).removedIndexes).toEqual([]);
    now++;
    expect((await gc().collect()).removedIndexes).toEqual([a]);
  });
  it("does not rewrite malformed GC state when acquiring a lease", async () => {
    index();
    fs.writeFileSync(path.join(root, "gc.json"), "{broken");
    const release = await gc().acquire(a, false);
    expect(release).toBeTypeOf("function");
    release!();
    expect(fs.readFileSync(path.join(root, "gc.json"), "utf8")).toBe("{broken");
  });
  it("cancels persisted orphan age when an existing store republishes a mapping", async () => {
    index();
    const coordinator = gc();
    await coordinator.collect();
    now += SKILL_INDEX_GC_GRACE_MS;
    await coordinator.withCatalog(async () => {
      mapping("returning");
      coordinator.markReferenced(a);
    });
    fs.unlinkSync(path.join(root, "agents", "returning.json"));
    expect((await coordinator.collect()).removedIndexes).toEqual([]);
    now += SKILL_INDEX_GC_GRACE_MS;
    expect((await coordinator.collect()).removedIndexes).toEqual([a]);
  });
});
