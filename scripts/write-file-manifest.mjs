#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VALUE_ARGUMENTS = new Set([
  "root",
  "include",
  "optional-include",
  "files-output",
  "hash-output",
  "compare-files",
  "compare-hashes",
]);

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!VALUE_ARGUMENTS.has(name))
      throw new Error(`unknown argument: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    const previous = values.get(name) ?? [];
    previous.push(value);
    values.set(name, previous);
    index += 1;
  }

  const single = (name) => {
    const entries = values.get(name) ?? [];
    if (entries.length > 1) throw new Error(`duplicate argument: --${name}`);
    return entries[0];
  };
  const root = single("root");
  const includes = values.get("include") ?? [];
  const optionalIncludes = values.get("optional-include") ?? [];
  if (!root || includes.length === 0) {
    throw new Error("required: --root and at least one --include");
  }

  const output = {
    files: single("files-output"),
    hashes: single("hash-output"),
  };
  const compare = {
    files: single("compare-files"),
    hashes: single("compare-hashes"),
  };
  const outputMode = Boolean(output.files || output.hashes);
  const compareMode = Boolean(compare.files || compare.hashes);
  if (
    outputMode === compareMode ||
    (outputMode && (!output.files || !output.hashes)) ||
    (compareMode && (!compare.files || !compare.hashes))
  ) {
    throw new Error(
      "provide exactly one complete --files-output/--hash-output or --compare-files/--compare-hashes pair",
    );
  }
  const pair = outputMode ? output : compare;
  if (path.resolve(pair.files) === path.resolve(pair.hashes)) {
    throw new Error("manifest paths must be distinct");
  }

  return {
    root: path.resolve(root),
    includes,
    optionalIncludes,
    output: outputMode
      ? {
          files: path.resolve(output.files),
          hashes: path.resolve(output.hashes),
        }
      : undefined,
    compare: compareMode
      ? {
          files: path.resolve(compare.files),
          hashes: path.resolve(compare.hashes),
        }
      : undefined,
  };
}

function validatePattern(pattern) {
  if (
    !pattern ||
    path.isAbsolute(pattern) ||
    pattern.includes("\\") ||
    pattern.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("include pattern must be relative and confined");
  }
  if (/[[\]{}?!]/u.test(pattern)) {
    throw new Error("include pattern uses unsupported glob syntax");
  }
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (value) => value.codePointAt(0));
  const b = Array.from(right, (value) => value.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function globRegex(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character !== "*") {
      source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      continue;
    }
    if (pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else {
      source += "[^/]*";
    }
  }
  return new RegExp(`${source}$`, "u");
}

function staticPrefix(pattern) {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) return pattern;
  const slash = pattern.lastIndexOf("/", wildcard);
  return slash < 0 ? "" : pattern.slice(0, slash);
}

function lstatOrThrow(absolutePath, label) {
  try {
    return fs.lstatSync(absolutePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    const code =
      error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "INVALID";
    throw new Error(`${label}: unable to inspect entry (${code})`);
  }
}

function scanPrefix(root, prefix) {
  const start = path.join(root, ...prefix.split("/").filter(Boolean));
  const startStat = lstatOrThrow(start, prefix || ".");
  if (!startStat) return [];
  if (startStat.isSymbolicLink()) {
    throw new Error(`${prefix || "."}: symbolic links are not allowed`);
  }
  if (startStat.isFile()) return [prefix];
  if (!startStat.isDirectory()) {
    throw new Error(`${prefix || "."}: non-regular entries are not allowed`);
  }

  const files = [];
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
        `${relativeDirectory || "."}: unable to read directory (${code})`,
      );
    }
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = lstatOrThrow(absolute, relative);
      if (!stat) throw new Error(`${relative}: entry disappeared during scan`);
      if (stat.isSymbolicLink()) {
        throw new Error(`${relative}: symbolic links are not allowed`);
      }
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push(relative);
      else throw new Error(`${relative}: non-regular entries are not allowed`);
    }
  };
  visit(start, prefix);
  return files;
}

function createManifest(root, requiredPatterns, optionalPatterns) {
  const rootStat = lstatOrThrow(root, ".");
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("manifest root must be a non-symbolic-link directory");
  }

  const patterns = [
    ...requiredPatterns.map((pattern) => ({ pattern, required: true })),
    ...optionalPatterns.map((pattern) => ({ pattern, required: false })),
  ];
  const scanned = new Map();
  const selected = new Set();
  for (const item of patterns) {
    validatePattern(item.pattern);
    const prefix = staticPrefix(item.pattern);
    if (!scanned.has(prefix)) scanned.set(prefix, scanPrefix(root, prefix));
    const matcher = globRegex(item.pattern);
    const matches = scanned
      .get(prefix)
      .filter((relative) => matcher.test(relative));
    if (item.required && matches.length === 0) {
      throw new Error(`required pattern matched no files: ${item.pattern}`);
    }
    for (const match of matches) selected.add(match);
  }

  const files = [...selected].sort(compareCodePoints);
  const hashes = files.map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    const stat = lstatOrThrow(absolute, relative);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${relative}: file changed during hashing`);
    }
    return {
      path: relative,
      sha256: createHash("sha256")
        .update(fs.readFileSync(absolute))
        .digest("hex"),
    };
  });
  return { files, hashes };
}

function readJson(file, label) {
  const stat = lstatOrThrow(file, label);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const manifest = createManifest(
    args.root,
    args.includes,
    args.optionalIncludes,
  );
  if (args.compare) {
    const files = readJson(args.compare.files, "approved files manifest");
    const hashes = readJson(args.compare.hashes, "approved hashes manifest");
    if (
      !sameJson(files, manifest.files) ||
      !sameJson(hashes, manifest.hashes)
    ) {
      fail("STALE");
      return;
    }
    process.stdout.write("current\n");
    return;
  }

  atomicWriteJson(args.output.files, manifest.files);
  atomicWriteJson(args.output.hashes, manifest.hashes);
  process.stdout.write(`sealed ${manifest.files.length} files\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
