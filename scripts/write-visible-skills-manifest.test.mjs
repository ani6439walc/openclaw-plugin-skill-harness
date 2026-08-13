import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(
  new URL("./write-visible-skills-manifest.mjs", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function temporaryDirectory() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "skill-harness-visible-skills-"),
  );
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeSkill(directory, name, description) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

async function expectedInventory({ distRoot, stateDir, config, agentId, env }) {
  const [{ resolveSkillInventory }, { resolveAgentWorkspaceDir }] =
    await Promise.all([
      import(
        pathToFileURL(path.join(distRoot, "src", "skills", "indexer.js")).href
      ),
      import("openclaw/plugin-sdk/agent-runtime"),
    ]);
  const api = {
    config,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: { resolveAgentWorkspaceDir },
    },
  };
  const previousHome = process.env.HOME;
  process.env.HOME = env.HOME;
  try {
    return await resolveSkillInventory({ api, agentId, cacheTtlMs: 0 });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

test("emits production inventory identities for canonical configured agents", async () => {
  const temporary = temporaryDirectory();
  try {
    const stateDir = path.join(temporary, "state");
    const home = path.join(temporary, "home");
    const mainWorkspace = path.join(temporary, "main-workspace");
    const writerWorkspace = path.join(temporary, "writer-workspace");
    const output = path.join(temporary, "visible-skills.json");
    const config = {
      agents: {
        list: [
          { id: "main", workspace: mainWorkspace },
          { id: "writer", workspace: writerWorkspace },
        ],
      },
      plugins: {
        entries: {
          "skill-harness": {
            enabled: true,
            config: { agents: [" Main ", "writer", "MAIN"] },
          },
        },
      },
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify(config),
    );
    writeSkill(
      path.join(mainWorkspace, "skills", "main-only"),
      "Main-Only",
      "Main.",
    );
    writeSkill(
      path.join(writerWorkspace, "skills", "writer-only"),
      "writer-only",
      "Writer.",
    );

    const build = spawnSync("pnpm", ["run", "build"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const distRoot = path.join(repositoryRoot, "dist");
    const result = run(
      ["--dist-root", distRoot, "--state-dir", stateDir, "--output", output],
      { HOME: home },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const manifest = JSON.parse(fs.readFileSync(output, "utf8"));
    const expectedMain = await expectedInventory({
      distRoot,
      stateDir,
      config,
      agentId: "main",
      env: { HOME: home },
    });
    const expectedWriter = await expectedInventory({
      distRoot,
      stateDir,
      config,
      agentId: "writer",
      env: { HOME: home },
    });
    assert.deepEqual(manifest, {
      version: 1,
      agents: [
        { id: "main", inventory: expectedMain },
        { id: "writer", inventory: expectedWriter },
      ],
    });
    const mainOnly = manifest.agents[0].inventory.find(
      (skill) => skill.name === "Main-Only",
    );
    assert.equal(mainOnly.name, "Main-Only");
    assert.match(mainOnly.winnerFingerprint, /^[a-f0-9]{64}$/);
    assert.match(mainOnly.fingerprint, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("compare detects current plugin scope and inventory drift", () => {
  const temporary = temporaryDirectory();
  try {
    const stateDir = path.join(temporary, "state");
    const workspace = path.join(temporary, "workspace");
    const output = path.join(temporary, "visible-skills.json");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      agents: { list: [{ id: "main", workspace }] },
      plugins: {
        entries: {
          "skill-harness": { config: { agents: ["main"] } },
        },
      },
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config));
    writeSkill(path.join(workspace, "skills", "one"), "one", "One.");
    const distRoot = path.join(repositoryRoot, "dist");

    const create = run([
      "--dist-root",
      distRoot,
      "--state-dir",
      stateDir,
      "--output",
      output,
    ]);
    assert.equal(create.status, 0, create.stdout + create.stderr);
    const approved = fs.readFileSync(output);

    const current = run([
      "--dist-root",
      distRoot,
      "--state-dir",
      stateDir,
      "--compare",
      output,
    ]);
    assert.equal(current.status, 0, current.stdout + current.stderr);

    config.plugins.entries["skill-harness"].config.agents = ["main", "writer"];
    fs.writeFileSync(configPath, JSON.stringify(config));
    const staleScope = run([
      "--dist-root",
      distRoot,
      "--state-dir",
      stateDir,
      "--compare",
      output,
    ]);
    assert.equal(staleScope.status, 1);
    assert.equal(staleScope.stdout, "STALE\n");

    config.plugins.entries["skill-harness"].config.agents = ["main"];
    fs.writeFileSync(configPath, JSON.stringify(config));
    writeSkill(path.join(workspace, "skills", "two"), "two", "Two.");
    const staleInventory = run([
      "--dist-root",
      distRoot,
      "--state-dir",
      stateDir,
      "--compare",
      output,
    ]);
    assert.equal(staleInventory.status, 1);
    assert.equal(staleInventory.stdout, "STALE\n");
    assert.deepEqual(fs.readFileSync(output), approved);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed for malformed config and unresolved inventory", () => {
  const temporary = temporaryDirectory();
  try {
    const stateDir = path.join(temporary, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const output = path.join(temporary, "visible-skills.json");
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{invalid");

    const malformed = run([
      "--dist-root",
      path.join(repositoryRoot, "dist"),
      "--state-dir",
      stateDir,
      "--output",
      output,
    ]);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stdout, /openclaw config is not valid JSON/);
    assert.equal(fs.existsSync(output), false);
    assert.doesNotMatch(malformed.stdout, new RegExp(temporary));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed for malformed production inventory identities", () => {
  const temporary = temporaryDirectory();
  try {
    const stateDir = path.join(temporary, "state");
    const distRoot = path.join(temporary, "dist");
    const output = path.join(temporary, "visible-skills.json");
    const config = {
      plugins: {
        entries: {
          "skill-harness": { config: { agents: ["main"] } },
        },
      },
    };
    fs.mkdirSync(path.join(distRoot, "src", "skills"), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify(config),
    );
    fs.writeFileSync(path.join(distRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(distRoot, "src", "config.js"),
      "export function resolveConfig() { return { agents: ['main'] }; }",
    );

    const base = {
      name: "react",
      source: "workspace",
      winnerFingerprint: "1".repeat(64),
      fingerprint: "2".repeat(64),
    };
    const variants = [
      [{ ...base, name: " React " }],
      [base, { ...base }],
      [{ ...base, source: "unknown" }],
      [{ ...base, extra: true }],
    ];
    for (const inventory of variants) {
      fs.writeFileSync(
        path.join(distRoot, "src", "skills", "indexer.js"),
        `export async function resolveSkillInventory() { return ${JSON.stringify(inventory)}; }`,
      );
      const result = run([
        "--dist-root",
        distRoot,
        "--state-dir",
        stateDir,
        "--output",
        output,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /invalid identity/);
      assert.equal(fs.existsSync(output), false);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
