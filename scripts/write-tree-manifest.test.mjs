import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./write-tree-manifest.mjs", import.meta.url),
);

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-harness-tree-manifest-"));
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

test("seals required and absent optional roots with complete typed trees", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "backup");
    const output = path.join(root, "backup.tree.json");
    write(root, "intents/a.md", "a\n");
    fs.mkdirSync(path.join(root, "intents", "empty"), { recursive: true });

    const result = run([
      "--root",
      root,
      "--include-root",
      "intents",
      "--optional-include-root",
      "experiences",
      "--output",
      output,
    ]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      version: 1,
      roots: [
        {
          name: "experiences",
          optional: true,
          present: false,
          entries: [],
        },
        {
          name: "intents",
          optional: false,
          present: true,
          entries: [
            { path: "a.md", type: "file", sha256: sha256("a\n") },
            { path: "empty", type: "directory" },
          ],
        },
      ],
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects a missing required root without publishing a manifest", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "backup");
    fs.mkdirSync(root, { recursive: true });
    const output = path.join(root, "backup.tree.json");
    const result = run([
      "--root",
      root,
      "--include-root",
      "intents",
      "--output",
      output,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /required root is missing: intents/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("compare detects absent versus empty and byte drift without rewriting the seal", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "backup");
    write(root, "intents/a.md", "before\n");
    const output = path.join(root, "backup.tree.json");
    const create = run([
      "--root",
      root,
      "--include-root",
      "intents",
      "--optional-include-root",
      "experiences",
      "--output",
      output,
    ]);
    assert.equal(create.status, 0, create.stdout + create.stderr);
    const approved = fs.readFileSync(output);

    const current = run(["--root", root, "--compare", output]);
    assert.equal(current.status, 0, current.stdout + current.stderr);

    fs.mkdirSync(path.join(root, "experiences"));
    const stalePresence = run(["--root", root, "--compare", output]);
    assert.equal(stalePresence.status, 1);
    assert.equal(stalePresence.stdout, "STALE\n");

    fs.rmSync(path.join(root, "experiences"), { recursive: true });
    write(root, "intents/a.md", "after\n");
    const staleBytes = run(["--root", root, "--compare", output]);
    assert.equal(staleBytes.status, 1);
    assert.equal(staleBytes.stdout, "STALE\n");
    assert.deepEqual(fs.readFileSync(output), approved);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects symlinks anywhere under a sealed root", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "backup");
    write(root, "intents/a.md", "a\n");
    fs.symlinkSync("a.md", path.join(root, "intents", "alias.md"));
    const result = run([
      "--root",
      root,
      "--include-root",
      "intents",
      "--output",
      path.join(root, "backup.tree.json"),
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /symbolic links are not allowed/);
    assert.doesNotMatch(result.stdout, new RegExp(temporary));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects absolute, nested, traversing, and duplicate root names", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "backup");
    fs.mkdirSync(path.join(root, "intents"), { recursive: true });
    const invalid = [
      ["--include-root", "../intents"],
      ["--include-root", "nested/intents"],
      ["--include-root", path.join(temporary, "intents")],
      ["--include-root", "intents", "--optional-include-root", "intents"],
    ];

    for (const args of invalid) {
      const result = run([
        "--root",
        root,
        ...args,
        "--output",
        path.join(root, "backup.tree.json"),
      ]);
      assert.equal(result.status, 1);
      assert.match(
        result.stdout,
        /root names must be unique confined path segments/,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
