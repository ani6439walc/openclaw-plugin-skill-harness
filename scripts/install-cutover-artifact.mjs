#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const allowed = new Set([
    "source",
    "destination",
    "payload-files",
    "payload-hashes",
    "extra",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown argument: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`missing value for --${name}`);
    const previous = values.get(name) ?? [];
    previous.push(value);
    values.set(name, previous);
    index += 1;
  }
  const single = (name) => {
    const entries = values.get(name) ?? [];
    if (entries.length !== 1)
      throw new Error(`required exactly once: --${name}`);
    return entries[0];
  };
  const extras = values.get("extra") ?? [];
  if (new Set(extras).size !== extras.length) {
    throw new Error("extra paths must be unique");
  }
  return {
    source: path.resolve(single("source")),
    destination: path.resolve(single("destination")),
    payloadFiles: single("payload-files"),
    payloadHashes: single("payload-hashes"),
    extras,
  };
}

function confinedRelative(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

function regularSourceFile(root, relative, label) {
  if (!confinedRelative(relative)) throw new Error(`${label} path is invalid`);
  let current = root;
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstat(current, label);
    if (!stat) throw new Error(`${label} is missing`);
    if (stat.isSymbolicLink())
      throw new Error(`${label}: symbolic links are not allowed`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label}: parent is not a directory`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
  }
  return current;
}

function readJsonSource(root, relative, label) {
  const file = regularSourceFile(root, relative, label);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function readPayload(args) {
  if (
    !confinedRelative(args.payloadFiles) ||
    !confinedRelative(args.payloadHashes)
  ) {
    throw new Error("payload manifest is invalid");
  }
  const files = readJsonSource(
    args.source,
    args.payloadFiles,
    "payload files manifest",
  );
  const hashes = readJsonSource(
    args.source,
    args.payloadHashes,
    "payload hashes manifest",
  );
  if (!Array.isArray(files) || !Array.isArray(hashes)) {
    throw new Error("payload manifest is invalid");
  }
  const unique = new Set();
  for (const file of files) {
    if (!confinedRelative(file) || unique.has(file)) {
      throw new Error("payload manifest is invalid");
    }
    unique.add(file);
  }
  if (hashes.length !== files.length)
    throw new Error("payload manifest is invalid");
  for (let index = 0; index < hashes.length; index += 1) {
    const item = hashes[index];
    if (
      !item ||
      typeof item !== "object" ||
      item.path !== files[index] ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)
    ) {
      throw new Error("payload manifest is invalid");
    }
  }
  return hashes;
}

function expectedFiles(args) {
  const payload = readPayload(args);
  const expected = new Map();
  for (const item of payload) {
    const source = regularSourceFile(
      args.source,
      item.path,
      `payload ${item.path}`,
    );
    if (sha256File(source) !== item.sha256) {
      throw new Error(`payload hash mismatch: ${item.path}`);
    }
    expected.set(item.path, { source, sha256: item.sha256 });
  }
  for (const extra of args.extras) {
    if (!confinedRelative(extra) || expected.has(extra)) {
      throw new Error("extra paths must be unique and confined");
    }
    const source = regularSourceFile(args.source, extra, `extra ${extra}`);
    expected.set(extra, { source, sha256: sha256File(source) });
  }
  return expected;
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const relative of files.keys()) {
    const segments = relative.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

function scanDestination(root) {
  const files = new Map();
  const directories = new Set();
  const visit = (directory, relativeDirectory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = lstat(absolute, `destination ${relative}`);
      if (!stat) throw new Error(`destination ${relative} disappeared`);
      if (stat.isSymbolicLink())
        throw new Error("destination contains a symbolic link");
      if (stat.isDirectory()) {
        directories.add(relative);
        visit(absolute, relative);
      } else if (stat.isFile()) files.set(relative, sha256File(absolute));
      else throw new Error("destination contains a special file");
    }
  };
  visit(root, "");
  return { files, directories };
}

function exactDestination(root, expected) {
  const stat = lstat(root, "destination");
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const actual = scanDestination(root);
  const directories = expectedDirectories(expected);
  if (
    actual.files.size !== expected.size ||
    actual.directories.size !== directories.size
  ) {
    return false;
  }
  for (const directory of directories) {
    if (!actual.directories.has(directory)) return false;
  }
  for (const [relative, item] of expected) {
    if (actual.files.get(relative) !== item.sha256) return false;
  }
  return true;
}

function copyExpected(expected, temporary) {
  for (const [relative, item] of expected) {
    const destination = path.join(temporary, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(item.source, destination, fs.constants.COPYFILE_EXCL);
    if (sha256File(destination) !== item.sha256) {
      throw new Error(`copied artifact hash mismatch: ${relative}`);
    }
  }
}

function ensureSafeDestinationParent(destination) {
  const parent = path.dirname(destination);
  const missing = [];
  let current = parent;
  while (true) {
    const stat = lstat(current, "destination parent");
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error("destination parent cannot contain a symbolic link");
      }
      if (!stat.isDirectory()) {
        throw new Error("destination parent must be a directory");
      }
      break;
    }
    missing.push(current);
    const next = path.dirname(current);
    if (next === current) {
      throw new Error("destination parent is unavailable");
    }
    current = next;
  }
  for (const directory of missing.reverse()) {
    fs.mkdirSync(directory);
  }
  const finalStat = lstat(parent, "destination parent");
  if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
    throw new Error("destination parent is unsafe");
  }
  return parent;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const sourceStat = lstat(args.source, "source");
  if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error("source must be a non-symbolic-link directory");
  }
  const expected = expectedFiles(args);
  const parent = ensureSafeDestinationParent(args.destination);
  const existing = lstat(args.destination, "destination");
  if (existing) {
    if (exactDestination(args.destination, expected)) {
      process.stdout.write("reused\n");
      return;
    }
    fail("STALE");
    return;
  }

  const temporary = fs.mkdtempSync(
    path.join(parent, `.${path.basename(args.destination)}.tmp-`),
  );
  try {
    copyExpected(expected, temporary);
    if (!exactDestination(temporary, expected)) {
      throw new Error("temporary artifact verification failed");
    }
    if (process.env.SKILL_HARNESS_TEST_FAIL_BEFORE_ARTIFACT_RENAME === "1") {
      throw new Error("injected failure before artifact rename");
    }
    fs.renameSync(temporary, args.destination);
    process.stdout.write("installed\n");
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
