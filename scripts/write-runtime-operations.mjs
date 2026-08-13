#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OWNED_ROOTS = ["intents", "experiences"];

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const required = [
    "active-root",
    "staged-root",
    "runtime-source-files",
    "runtime-source-hashes",
    "output",
  ];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!required.includes(name))
      throw new Error(`unknown argument: --${name}`);
    if (values.has(name)) throw new Error(`duplicate argument: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for --${name}`);
    values.set(name, path.resolve(value));
    index += 1;
  }
  const missing = required.filter((name) => !values.has(name));
  if (missing.length)
    throw new Error(`missing required arguments: ${missing.join(", ")}`);
  return Object.fromEntries(values);
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
  if (
    typeof value !== "string" ||
    !value ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..") ||
    !value.endsWith(".md")
  ) {
    return false;
  }
  return OWNED_ROOTS.some((root) => value.startsWith(`${root}/`));
}

function lstat(file, label) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    const code =
      error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "INVALID";
    throw new Error(`${label}: unable to inspect entry (${code})`);
  }
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function scanOwnedTree(root, { requireIntents }) {
  const rootStat = lstat(root, ".");
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("catalog root must be a non-symbolic-link directory");
  }
  const files = new Map();
  for (const ownedRoot of OWNED_ROOTS) {
    const absoluteRoot = path.join(root, ownedRoot);
    const ownedStat = lstat(absoluteRoot, ownedRoot);
    if (!ownedStat) continue;
    if (ownedStat.isSymbolicLink()) {
      throw new Error(`${ownedRoot}: symbolic links are not allowed`);
    }
    if (!ownedStat.isDirectory())
      throw new Error(`${ownedRoot}: must be a directory`);
    const visit = (directory, relativeDirectory) => {
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        const code =
          error && typeof error === "object" && typeof error.code === "string"
            ? error.code
            : "INVALID";
        throw new Error(
          `${relativeDirectory}: unable to read directory (${code})`,
        );
      }
      for (const entry of entries) {
        const relative = `${relativeDirectory}/${entry.name}`;
        const absolute = path.join(directory, entry.name);
        const stat = lstat(absolute, relative);
        if (!stat)
          throw new Error(`${relative}: entry disappeared during scan`);
        if (stat.isSymbolicLink()) {
          throw new Error(`${relative}: symbolic links are not allowed`);
        }
        if (stat.isDirectory()) visit(absolute, relative);
        else if (stat.isFile()) {
          if (!entry.name.endsWith(".md")) {
            throw new Error(`${relative}: only Markdown files are allowed`);
          }
          files.set(relative, sha256File(absolute));
        } else throw new Error(`${relative}: special files are not allowed`);
      }
    };
    visit(absoluteRoot, ownedRoot);
  }
  if (
    requireIntents &&
    ![...files.keys()].some((relative) => relative.startsWith("intents/"))
  ) {
    throw new Error("staged intents must contain Markdown files");
  }
  return files;
}

function readJsonFile(file, label) {
  const stat = lstat(file, label);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("source manifest is invalid");
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("source manifest is invalid");
  }
}

function readSourceManifest(filesFile, hashesFile) {
  const files = readJsonFile(filesFile, "source files manifest");
  const hashes = readJsonFile(hashesFile, "source hashes manifest");
  if (
    !Array.isArray(files) ||
    !Array.isArray(hashes) ||
    files.length !== hashes.length
  ) {
    throw new Error("source manifest is invalid");
  }
  const result = new Map();
  for (let index = 0; index < files.length; index += 1) {
    const relative = files[index];
    const item = hashes[index];
    if (
      !confinedOwnedPath(relative) ||
      result.has(relative) ||
      !item ||
      typeof item !== "object" ||
      item.path !== relative ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)
    ) {
      throw new Error("source manifest is invalid");
    }
    result.set(relative, item.sha256);
  }
  const sorted = [...result.keys()].sort(compareCodePoints);
  if (JSON.stringify(sorted) !== JSON.stringify(files)) {
    throw new Error("source manifest is invalid");
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

function buildOperations(active, staged) {
  const destinations = new Set([...active.keys(), ...staged.keys()]);
  const operations = [];
  for (const destination of [...destinations].sort(compareCodePoints)) {
    const before = active.get(destination);
    const after = staged.get(destination);
    if (before === after) continue;
    if (before === undefined) {
      operations.push({
        operation: "create",
        destination,
        source: destination,
        sha256: after,
      });
    } else if (after === undefined) {
      operations.push({
        operation: "delete",
        destination,
        expectedSha256: before,
      });
    } else {
      operations.push({
        operation: "replace",
        destination,
        source: destination,
        sha256: after,
        expectedSha256: before,
      });
    }
  }
  return operations;
}

function buildActivePreimages(active) {
  return [...active.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([path, sha256]) => ({ path, sha256 }));
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

function main() {
  const args = parseArguments(process.argv.slice(2));
  const sealed = readSourceManifest(
    args["runtime-source-files"],
    args["runtime-source-hashes"],
  );
  const active = scanOwnedTree(args["active-root"], { requireIntents: false });
  if (!sameMap(sealed, active)) {
    fail("STALE");
    return;
  }
  const staged = scanOwnedTree(args["staged-root"], { requireIntents: true });
  atomicWriteJson(args.output, {
    version: 1,
    activePreimages: buildActivePreimages(active),
    operations: buildOperations(active, staged),
  });
  process.stdout.write("sealed operations\n");
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
