#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const secureApplier = fileURLToPath(
  new URL("./apply-runtime-data-secure.py", import.meta.url),
);

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const values = new Map();
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run" || token === "--apply") {
      if (mode) throw new Error("choose exactly one mode");
      mode = token.slice(2);
      continue;
    }
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!["artifact-root", "active-root", "operations"].includes(name)) {
      throw new Error(`unknown argument: --${name}`);
    }
    if (values.has(name)) throw new Error(`duplicate argument: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for --${name}`);
    values.set(name, path.resolve(value));
    index += 1;
  }
  if (
    !mode ||
    !values.has("artifact-root") ||
    !values.has("active-root") ||
    !values.has("operations")
  ) {
    throw new Error(
      "required: --artifact-root, --active-root, --operations, and one mode",
    );
  }
  return {
    artifactRoot: values.get("artifact-root"),
    activeRoot: values.get("active-root"),
    operations: values.get("operations"),
    mode,
  };
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function confinedOwnedPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    value.endsWith(".md") &&
    value
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..") &&
    (value.startsWith("intents/") || value.startsWith("experiences/"))
  );
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
}

function assertRoot(root, label, allowCreate = false) {
  const stat = lstat(root);
  if (!stat && allowCreate) return;
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory`);
  }
}

function resolveConfined(root, relative, label) {
  const rootStat = lstat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a non-symbolic-link directory`);
  }
  let current = root;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstat(current);
    if (!stat) {
      return {
        absolute: path.join(root, ...segments),
        exists: false,
      };
    }
    if (stat.isSymbolicLink())
      throw new Error(`${label}: symbolic links are not allowed`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label}: ancestor is not a directory`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`${label}: destination is not a regular file`);
    }
  }
  return { absolute: current, exists: true };
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function scanActivePreimages(root) {
  const result = new Map();
  for (const ownedRoot of ["intents", "experiences"]) {
    const absoluteRoot = path.join(root, ownedRoot);
    const ownedStat = lstat(absoluteRoot);
    if (!ownedStat) continue;
    if (ownedStat.isSymbolicLink())
      throw new Error(`${ownedRoot}: symbolic links are not allowed`);
    if (!ownedStat.isDirectory())
      throw new Error(`${ownedRoot}: must be a directory`);
    const visit = (directory, relativeDirectory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = `${relativeDirectory}/${entry.name}`;
        const absolute = path.join(directory, entry.name);
        const stat = lstat(absolute);
        if (!stat)
          throw new Error(`${relative}: entry disappeared during scan`);
        if (stat.isSymbolicLink())
          throw new Error(`${relative}: symbolic links are not allowed`);
        if (stat.isDirectory()) visit(absolute, relative);
        else if (stat.isFile()) {
          if (!entry.name.endsWith(".md"))
            throw new Error(`${relative}: only Markdown files are allowed`);
          result.set(relative, sha256File(absolute));
        } else throw new Error(`${relative}: special files are not allowed`);
      }
    };
    visit(absoluteRoot, ownedRoot);
  }
  return result;
}

function sameMap(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function readOperations(args) {
  const relative = path
    .relative(args.artifactRoot, args.operations)
    .split(path.sep)
    .join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("operations manifest must be inside artifact root");
  }
  const manifestFile = resolveConfined(
    args.artifactRoot,
    relative,
    "operations manifest",
  );
  if (!manifestFile.exists) throw new Error("operations manifest is invalid");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestFile.absolute, "utf8"));
  } catch {
    throw new Error("operations manifest is invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "activePreimages,operations,version" ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.activePreimages) ||
    !Array.isArray(parsed.operations)
  ) {
    throw new Error("operations manifest is invalid");
  }
  const activePreimages = new Map();
  let previousPreimage;
  for (const item of parsed.activePreimages) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "path,sha256" ||
      !confinedOwnedPath(item.path) ||
      activePreimages.has(item.path) ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      (previousPreimage !== undefined &&
        compareCodePoints(previousPreimage, item.path) >= 0)
    ) {
      throw new Error("operations manifest is invalid");
    }
    activePreimages.set(item.path, item.sha256);
    previousPreimage = item.path;
  }
  const operations = parsed.operations;
  const seen = new Set();
  let previous;
  for (const item of operations) {
    if (
      !item ||
      typeof item !== "object" ||
      !confinedOwnedPath(item.destination) ||
      seen.has(item.destination)
    ) {
      throw new Error("operations manifest is invalid");
    }
    if (
      previous !== undefined &&
      compareCodePoints(previous, item.destination) >= 0
    ) {
      throw new Error("operations manifest is invalid");
    }
    seen.add(item.destination);
    previous = item.destination;
    if (item.operation === "delete") {
      if (
        Object.keys(item).sort().join(",") !==
          "destination,expectedSha256,operation" ||
        typeof item.expectedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.expectedSha256)
      )
        throw new Error("operations manifest is invalid");
    } else if (item.operation === "create" || item.operation === "replace") {
      const expectedKeys =
        item.operation === "create"
          ? "destination,operation,sha256,source"
          : "destination,expectedSha256,operation,sha256,source";
      if (
        Object.keys(item).sort().join(",") !== expectedKeys ||
        !confinedOwnedPath(item.source) ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.sha256) ||
        (item.operation === "replace" &&
          (typeof item.expectedSha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(item.expectedSha256)))
      )
        throw new Error("operations manifest is invalid");
    } else throw new Error("operations manifest is invalid");
  }
  return { activePreimages, operations, serialized: JSON.stringify(parsed) };
}

function preflight(args, operations) {
  const prepared = [];
  for (const item of operations) {
    const destination = resolveConfined(
      args.activeRoot,
      item.destination,
      `active ${item.destination}`,
    );
    if (item.operation === "create") {
      if (destination.exists) return;
    } else if (
      !destination.exists ||
      sha256File(destination.absolute) !== item.expectedSha256
    ) {
      return;
    }
    let source;
    if (item.operation !== "delete") {
      source = resolveConfined(
        args.artifactRoot,
        item.source,
        `artifact ${item.source}`,
      );
      if (!source.exists || sha256File(source.absolute) !== item.sha256) return;
    }
    prepared.push({
      item,
      relativeDestination: item.destination,
      destination: destination.absolute,
      source: source?.absolute,
    });
  }
  return prepared;
}

function applyAll(args, manifest) {
  const activeRootFd = fs.openSync(
    args.activeRoot,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const artifactRootFd = fs.openSync(
    args.artifactRoot,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const command = [
    secureApplier,
    "--active-root-path",
    args.activeRoot,
    "--active-root-fd",
    "3",
    "--artifact-root-fd",
    "4",
  ];
  try {
    const result = spawnSync("python3", command, {
      encoding: "utf8",
      input: manifest.serialized,
      stdio: ["pipe", "pipe", "pipe", activeRootFd, artifactRootFd],
    });
    if (result.error || result.status !== 0) {
      if (result.stderr.trim() === "STALE") return "STALE";
      throw new Error("secure runtime operation failed");
    }
  } finally {
    fs.closeSync(artifactRootFd);
    fs.closeSync(activeRootFd);
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  assertRoot(args.artifactRoot, "artifact root");
  assertRoot(args.activeRoot, "active root");
  const manifest = readOperations(args);
  if (
    !sameMap(manifest.activePreimages, scanActivePreimages(args.activeRoot))
  ) {
    fail("STALE");
    return;
  }
  const operations = manifest.operations;
  const prepared = preflight(args, operations);
  if (!prepared) {
    fail("STALE");
    return;
  }
  if (args.mode === "dry-run") {
    process.stdout.write(`dry-run ${operations.length} operations\n`);
    return;
  }
  try {
    if (applyAll(args, manifest) === "STALE") {
      fail("STALE");
      return;
    }
  } catch {
    fail("partial failure during secure runtime apply");
    return;
  }
  process.stdout.write(`applied ${operations.length} operations\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
