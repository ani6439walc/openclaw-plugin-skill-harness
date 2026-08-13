#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const allowed = new Set(["dist-root", "state-dir", "output", "compare"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown argument: --${name}`);
    if (values.has(name)) throw new Error(`duplicate argument: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for --${name}`);
    values.set(name, path.resolve(value));
    index += 1;
  }
  const distRoot = values.get("dist-root");
  const stateDir = values.get("state-dir");
  const output = values.get("output");
  const compare = values.get("compare");
  if (!distRoot || !stateDir || Boolean(output) === Boolean(compare)) {
    throw new Error(
      "required: --dist-root, --state-dir, and exactly one of --output or --compare",
    );
  }
  return { distRoot, stateDir, output, compare };
}

function lstatRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

function readConfig(stateDir) {
  const file = path.join(stateDir, "openclaw.json");
  lstatRegularFile(file, "openclaw config");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid root");
    }
    return parsed;
  } catch {
    throw new Error("openclaw config is not valid JSON");
  }
}

function canonicalAgents(values) {
  if (!Array.isArray(values))
    throw new Error("resolved agent scope is invalid");
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string")
      throw new Error("resolved agent scope is invalid");
    const id = value.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  if (result.length === 0) throw new Error("resolved agent scope is empty");
  return result;
}

function validateInventory(inventory) {
  if (!Array.isArray(inventory))
    throw new Error("skill inventory is unresolved");
  const sources = new Set([
    "workspace",
    "project-agent",
    "personal-agent",
    "managed",
    "plugin",
    "bundled",
    "extra",
  ]);
  const seen = new Set();
  for (const item of inventory) {
    const canonicalName =
      typeof item?.name === "string" ? item.name.trim().toLowerCase() : "";
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !==
        "fingerprint,name,source,winnerFingerprint" ||
      typeof item.name !== "string" ||
      item.name !== item.name.trim() ||
      !canonicalName ||
      seen.has(canonicalName) ||
      !sources.has(item.source) ||
      typeof item.winnerFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.winnerFingerprint) ||
      typeof item.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.fingerprint)
    ) {
      throw new Error("skill inventory contains an invalid identity");
    }
    seen.add(canonicalName);
  }
}

async function createManifest(args) {
  const config = readConfig(args.stateDir);
  const configUrl = pathToFileURL(
    path.join(args.distRoot, "src", "config.js"),
  ).href;
  const indexerUrl = pathToFileURL(
    path.join(args.distRoot, "src", "skills", "indexer.js"),
  ).href;
  const [configModule, indexerModule, pluginConfigModule, agentRuntimeModule] =
    await Promise.all([
      import(configUrl),
      import(indexerUrl),
      import("openclaw/plugin-sdk/plugin-config-runtime"),
      import("openclaw/plugin-sdk/agent-runtime"),
    ]);
  if (
    typeof configModule.resolveConfig !== "function" ||
    typeof indexerModule.resolveSkillInventory !== "function" ||
    typeof pluginConfigModule.resolveLivePluginConfigObject !== "function" ||
    typeof agentRuntimeModule.resolveAgentWorkspaceDir !== "function"
  ) {
    throw new Error("required production inventory exports are unavailable");
  }

  const pluginConfig = pluginConfigModule.resolveLivePluginConfigObject(
    () => config,
    "skill-harness",
    {},
  );
  const resolved = configModule.resolveConfig(pluginConfig ?? {});
  const agentIds = canonicalAgents(resolved.agents);
  const api = {
    config,
    runtime: {
      state: { resolveStateDir: () => args.stateDir },
      agent: {
        resolveAgentWorkspaceDir: agentRuntimeModule.resolveAgentWorkspaceDir,
      },
    },
  };
  const agents = [];
  for (const id of agentIds) {
    const inventory = await indexerModule.resolveSkillInventory({
      api,
      agentId: id,
      cacheTtlMs: 0,
    });
    validateInventory(inventory);
    agents.push({ id, inventory });
  }
  return { version: 1, agents };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}

function readApproved(file) {
  lstatRegularFile(file, "approved visible-skills manifest");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.agents)) {
    throw new Error("approved visible-skills manifest is invalid");
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = await createManifest(args);
  if (args.compare) {
    const approved = readApproved(args.compare);
    if (JSON.stringify(manifest) !== JSON.stringify(approved)) {
      fail("STALE");
      return;
    }
    process.stdout.write("current\n");
    return;
  }
  atomicWriteJson(args.output, manifest);
  process.stdout.write(`sealed ${manifest.agents.length} agents\n`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
