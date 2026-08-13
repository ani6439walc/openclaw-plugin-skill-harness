#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set([
    "root",
    "include-root",
    "optional-include-root",
    "output",
    "compare",
  ]);
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
    if (entries.length > 1) throw new Error(`duplicate argument: --${name}`);
    return entries[0];
  };
  const root = single("root");
  const output = single("output");
  const compare = single("compare");
  if (!root || Boolean(output) === Boolean(compare)) {
    throw new Error(
      "required: --root and exactly one of --output or --compare",
    );
  }

  const requiredRoots = values.get("include-root") ?? [];
  const optionalRoots = values.get("optional-include-root") ?? [];
  if (output && requiredRoots.length + optionalRoots.length === 0) {
    throw new Error("at least one root name is required");
  }
  return {
    root: path.resolve(root),
    requiredRoots,
    optionalRoots,
    output: output ? path.resolve(output) : undefined,
    compare: compare ? path.resolve(compare) : undefined,
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

function validateRootNames(requiredRoots, optionalRoots) {
  const names = [...requiredRoots, ...optionalRoots];
  const unique = new Set(names);
  if (
    unique.size !== names.length ||
    names.some(
      (name) =>
        !name ||
        path.isAbsolute(name) ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\"),
    )
  ) {
    throw new Error("root names must be unique confined path segments");
  }
}

function lstat(absolutePath, label) {
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

function scanRoot(root, name, optional) {
  const absoluteRoot = path.join(root, name);
  const rootStat = lstat(absoluteRoot, name);
  if (!rootStat) {
    if (!optional) throw new Error(`required root is missing: ${name}`);
    return { name, optional, present: false, entries: [] };
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`${name}: symbolic links are not allowed`);
  }
  if (!rootStat.isDirectory())
    throw new Error(`${name}: root must be a directory`);

  const entries = [];
  const visit = (directory, relativeDirectory) => {
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const code =
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "INVALID";
      throw new Error(
        `${name}/${relativeDirectory || "."}: unable to read directory (${code})`,
      );
    }
    for (const child of children) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const absolute = path.join(directory, child.name);
      const stat = lstat(absolute, `${name}/${relative}`);
      if (!stat)
        throw new Error(`${name}/${relative}: entry disappeared during scan`);
      if (stat.isSymbolicLink()) {
        throw new Error(`${name}/${relative}: symbolic links are not allowed`);
      }
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        visit(absolute, relative);
      } else if (stat.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          sha256: createHash("sha256")
            .update(fs.readFileSync(absolute))
            .digest("hex"),
        });
      } else {
        throw new Error(`${name}/${relative}: special files are not allowed`);
      }
    }
  };
  visit(absoluteRoot, "");
  entries.sort((left, right) => compareCodePoints(left.path, right.path));
  return { name, optional, present: true, entries };
}

function buildManifest(root, requiredRoots, optionalRoots) {
  validateRootNames(requiredRoots, optionalRoots);
  const rootStat = lstat(root, ".");
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("manifest root must be a non-symbolic-link directory");
  }
  const roots = [
    ...requiredRoots.map((name) => scanRoot(root, name, false)),
    ...optionalRoots.map((name) => scanRoot(root, name, true)),
  ].sort((left, right) => compareCodePoints(left.name, right.name));
  return { version: 1, roots };
}

function readApproved(file) {
  const stat = lstat(file, "approved tree manifest");
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("approved tree manifest must be a regular file");
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.roots)) {
    throw new Error("approved tree manifest is invalid");
  }
  const requiredRoots = [];
  const optionalRoots = [];
  for (const item of parsed.roots) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.name !== "string" ||
      typeof item.optional !== "boolean" ||
      typeof item.present !== "boolean" ||
      !Array.isArray(item.entries)
    ) {
      throw new Error("approved tree manifest is invalid");
    }
    (item.optional ? optionalRoots : requiredRoots).push(item.name);
  }
  validateRootNames(requiredRoots, optionalRoots);
  return { parsed, requiredRoots, optionalRoots };
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
  if (args.compare) {
    const approved = readApproved(args.compare);
    const current = buildManifest(
      args.root,
      approved.requiredRoots,
      approved.optionalRoots,
    );
    if (JSON.stringify(current) !== JSON.stringify(approved.parsed)) {
      fail("STALE");
      return;
    }
    process.stdout.write("current\n");
    return;
  }
  const manifest = buildManifest(
    args.root,
    args.requiredRoots,
    args.optionalRoots,
  );
  atomicWriteJson(args.output, manifest);
  process.stdout.write(`sealed ${manifest.roots.length} roots\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
