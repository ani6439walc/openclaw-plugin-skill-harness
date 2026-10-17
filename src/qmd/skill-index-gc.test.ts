import * as fs from "node:fs";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });
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
  it("queues seven catalog operations without spending the file-lock budget in the local queue", async () => {
    vi.useFakeTimers();
    const coordinator = gc();
    const order: number[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.withCatalog(async () => {
      order.push(0);
      await blocked;
      return 0;
    });
    await vi.waitFor(() => expect(order).toEqual([0]));
    const followers = Array.from({ length: 6 }, (_, index) =>
      coordinator.withCatalog(async () => {
        order.push(index + 1);
        return index + 1;
      }),
    );
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(order).toEqual([0]);
    } finally {
      release();
    }
    expect(await Promise.all([first, ...followers])).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips nonwaiting maintenance while its coordinator is occupied and continues after a rejected operation", async () => {
    const coordinator = gc();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const first = coordinator.withCatalog(async () => {
      entered = true;
      await blocked;
      return true;
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    const maintenance = vi.fn(async () => true);
    try {
      expect(await coordinator.withCatalog(maintenance, 0)).toBeUndefined();
      expect(maintenance).not.toHaveBeenCalled();
    } finally {
      release();
      await first;
    }
    await expect(
      coordinator.withCatalog(async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    expect(await coordinator.withCatalog(async () => "next")).toBe("next");
  });
  it("retains the cross-instance deadline and drains all accepted local work", async () => {
    vi.useFakeTimers();
    const owner = gc();
    const contender = gc();
    let release!: () => void;
    let entered = false;
    const first = owner.withCatalog(async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    const external = vi.fn(async () => true);
    const waiting = contender.withCatalog(external);
    const tail = vi.fn(async () => "tail");
    const follower = owner.withCatalog(tail);
    let drained = false;
    const draining = owner.drain().then(() => {
      drained = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waiting).toBeUndefined();
      expect(external).not.toHaveBeenCalled();
      expect(tail).not.toHaveBeenCalled();
      expect(drained).toBe(false);
    } finally {
      release();
      await first;
    }
    expect(await follower).toBe("tail");
    await draining;
    expect(drained).toBe(true);
    expect(await contender.withCatalog(external)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects a catalog lock owned by another live process", async () => {
    const lockPath = path.join(root, "catalog.lock");
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `
      const fs = require('node:fs');
      const lock = process.argv[1];
      fs.mkdirSync(lock);
      fs.writeFileSync(lock + '/owner.json', JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }));
      process.on('message', () => { fs.rmSync(lock, { recursive: true }); process.exit(0); });
      process.send('ready');
    `,
        lockPath,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = once(child, "exit");
    try {
      await once(child, "message");
      const operation = vi.fn(async () => true);
      const coordinator = gc();
      expect(await coordinator.withCatalog(operation, 0)).toBeUndefined();
      expect(operation).not.toHaveBeenCalled();
      child.send("release");
      expect((await exited)[0]).toBe(0);
      expect(await coordinator.withCatalog(operation)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  });

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
