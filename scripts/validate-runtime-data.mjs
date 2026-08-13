#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_ARGUMENTS = [
  "dist-root",
  "intents",
  "experiences",
  "visible-skills-manifest",
];

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }

    const name = token.slice(2);
    if (!REQUIRED_ARGUMENTS.includes(name)) {
      throw new Error(`unknown argument: --${name}`);
    }
    if (values.has(name)) {
      throw new Error(`duplicate argument: --${name}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    values.set(name, path.resolve(value));
    index += 1;
  }

  const missing = REQUIRED_ARGUMENTS.filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new Error(
      "required: --dist-root, --intents, --experiences, --visible-skills-manifest",
    );
  }

  return Object.fromEntries(values);
}

function listMarkdownFiles(root) {
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
  } catch {
    return [];
  }

  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.toLowerCase().endsWith(".md")) {
          files.push(path.relative(root, absolutePath));
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(path.relative(root, absolutePath));
      }
    }
  };

  visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function readVisibleSkillsManifest(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("visible-skills manifest is invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "agents,version" ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.agents)
  ) {
    throw new Error("visible-skills manifest is invalid");
  }

  const sources = new Set([
    "workspace",
    "project-agent",
    "personal-agent",
    "managed",
    "plugin",
    "bundled",
    "extra",
  ]);
  const fingerprintPattern = /^[a-f0-9]{64}$/u;
  const result = Object.create(null);
  const seenAgents = new Set();
  for (const agent of parsed.agents) {
    if (
      !agent ||
      typeof agent !== "object" ||
      Array.isArray(agent) ||
      Object.keys(agent).sort().join(",") !== "id,inventory" ||
      typeof agent.id !== "string" ||
      agent.id !== agent.id.trim().toLowerCase() ||
      !agent.id ||
      seenAgents.has(agent.id) ||
      !Array.isArray(agent.inventory)
    ) {
      throw new Error("visible-skills manifest is invalid");
    }
    seenAgents.add(agent.id);

    const seenSkills = new Set();
    const names = [];
    for (const identity of agent.inventory) {
      const canonicalName =
        typeof identity?.name === "string"
          ? identity.name.trim().toLowerCase()
          : "";
      if (
        !identity ||
        typeof identity !== "object" ||
        Array.isArray(identity) ||
        Object.keys(identity).sort().join(",") !==
          "fingerprint,name,source,winnerFingerprint" ||
        typeof identity.name !== "string" ||
        identity.name !== identity.name.trim() ||
        !canonicalName ||
        seenSkills.has(canonicalName) ||
        !sources.has(identity.source) ||
        !fingerprintPattern.test(identity.winnerFingerprint) ||
        !fingerprintPattern.test(identity.fingerprint)
      ) {
        throw new Error("visible-skills manifest is invalid");
      }
      seenSkills.add(canonicalName);
      names.push(canonicalName);
    }
    result[agent.id] = names;
  }
  return result;
}

function sanitizeError(message, replacements) {
  let sanitized = String(message);
  for (const [absolutePath, label] of replacements) {
    sanitized = sanitized.split(absolutePath).join(label);
  }
  return sanitized;
}

function formatIntentError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const file = typeof error.file === "string" ? error.file : "unknown";
    const message =
      typeof error.message === "string" ? error.message : "invalid";
    return `${file}: ${message}`;
  }
  return String(error);
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const replacements = [
    [args["visible-skills-manifest"], "visible-skills-manifest"],
    [args.experiences, "experiences"],
    [args.intents, "intents"],
    [args["dist-root"], "dist"],
  ].sort((left, right) => right[0].length - left[0].length);

  try {
    const visibleSkillsByAgent = readVisibleSkillsManifest(
      args["visible-skills-manifest"],
    );
    const routingValidatorUrl = pathToFileURL(
      path.join(args["dist-root"], "src", "intents", "routing-validation.js"),
    ).href;
    const experienceValidatorUrl = pathToFileURL(
      path.join(args["dist-root"], "src", "experiences", "index.js"),
    ).href;
    const [
      { validateRoutingIntentDirectory },
      { validateExperienceDirectory },
    ] = await Promise.all([
      import(routingValidatorUrl),
      import(experienceValidatorUrl),
    ]);

    if (
      typeof validateRoutingIntentDirectory !== "function" ||
      typeof validateExperienceDirectory !== "function"
    ) {
      throw new Error("dist validators are unavailable");
    }

    const intentResult = validateRoutingIntentDirectory(args.intents);
    const experienceResult = validateExperienceDirectory({
      experienceDirectory: args.experiences,
      visibleSkillsByAgent,
    });
    const intentFiles = listMarkdownFiles(args.intents);
    const experienceFiles = listMarkdownFiles(args.experiences);

    process.stdout.write(
      `intents: ${intentFiles.length} Markdown ${intentFiles.length === 1 ? "file" : "files"}, ${intentResult.intents.length} parsed\n`,
    );
    process.stdout.write(
      `experiences: ${experienceFiles.length} Markdown ${experienceFiles.length === 1 ? "file" : "files"}, ${experienceResult.entries.length} valid\n`,
    );

    for (const error of intentResult.errors) {
      const formatted = sanitizeError(formatIntentError(error), replacements);
      const relative = formatted.startsWith("intents/")
        ? formatted.slice("intents/".length)
        : formatted;
      process.stdout.write(`intents/${relative}\n`);
    }
    for (const error of experienceResult.errors) {
      process.stdout.write(
        `experiences/${error.file}: ${sanitizeError(error.message, replacements)}\n`,
      );
    }

    if (!intentResult.valid || !experienceResult.valid) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`runtime validation failed: ${sanitizeError(message, replacements)}`);
  }
}

await main();
