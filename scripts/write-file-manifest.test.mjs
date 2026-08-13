import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./write-file-manifest.mjs", import.meta.url),
);

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-harness-file-manifest-"));
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

test("writes sorted path and byte-hash manifests for required and optional patterns", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    const filesOutput = path.join(temporary, "runtime.files.json");
    const hashesOutput = path.join(temporary, "runtime.sha256.json");
    write(root, "intents/β.md", "beta\n");
    write(root, "intents/alpha file.md", "alpha\n");
    write(root, "experiences/react/forms.md", "forms\n");
    write(root, "sessions/private.json", "must not be included\n");

    const result = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--optional-include",
      "experiences/**/*.md",
      "--files-output",
      filesOutput,
      "--hash-output",
      hashesOutput,
    ]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(filesOutput, "utf8")), [
      "experiences/react/forms.md",
      "intents/alpha file.md",
      "intents/β.md",
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(hashesOutput, "utf8")), [
      {
        path: "experiences/react/forms.md",
        sha256: sha256("forms\n"),
      },
      {
        path: "intents/alpha file.md",
        sha256: sha256("alpha\n"),
      },
      { path: "intents/β.md", sha256: sha256("beta\n") },
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("allows an unmatched optional pattern", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    write(root, "intents/only.md", "only\n");

    const result = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--optional-include",
      "experiences/**/*.md",
      "--files-output",
      path.join(temporary, "files.json"),
      "--hash-output",
      path.join(temporary, "hashes.json"),
    ]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects an unmatched required pattern without writing either manifest", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    fs.mkdirSync(root, { recursive: true });
    const filesOutput = path.join(temporary, "files.json");
    const hashesOutput = path.join(temporary, "hashes.json");

    const result = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--files-output",
      filesOutput,
      "--hash-output",
      hashesOutput,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /required pattern matched no files/);
    assert.equal(fs.existsSync(filesOutput), false);
    assert.equal(fs.existsSync(hashesOutput), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects symbolic links in a scanned prefix", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    write(root, "intents/real.md", "real\n");
    fs.symlinkSync("real.md", path.join(root, "intents", "alias.md"));

    const result = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--files-output",
      path.join(temporary, "files.json"),
      "--hash-output",
      path.join(temporary, "hashes.json"),
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /symbolic links are not allowed/);
    assert.doesNotMatch(result.stdout, new RegExp(temporary));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("compares exact file sets and hashes without rewriting approved manifests", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    const filesOutput = path.join(temporary, "files.json");
    const hashesOutput = path.join(temporary, "hashes.json");
    write(root, "intents/a.md", "before\n");

    const create = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--files-output",
      filesOutput,
      "--hash-output",
      hashesOutput,
    ]);
    assert.equal(create.status, 0, create.stdout + create.stderr);
    const filesBefore = fs.readFileSync(filesOutput);
    const hashesBefore = fs.readFileSync(hashesOutput);

    const current = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--compare-files",
      filesOutput,
      "--compare-hashes",
      hashesOutput,
    ]);
    assert.equal(current.status, 0, current.stdout + current.stderr);

    write(root, "intents/a.md", "after\n");
    const stale = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--compare-files",
      filesOutput,
      "--compare-hashes",
      hashesOutput,
    ]);
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, "STALE\n");
    assert.deepEqual(fs.readFileSync(filesOutput), filesBefore);
    assert.deepEqual(fs.readFileSync(hashesOutput), hashesBefore);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects traversing and absolute include patterns", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    write(root, "intents/a.md", "a\n");

    for (const pattern of ["../outside/*.md", path.join(temporary, "*.md")]) {
      const result = run([
        "--root",
        root,
        "--include",
        pattern,
        "--files-output",
        path.join(temporary, "files.json"),
        "--hash-output",
        path.join(temporary, "hashes.json"),
      ]);
      assert.equal(result.status, 1);
      assert.match(
        result.stdout,
        /include pattern must be relative and confined/,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects using one path for both output manifests", () => {
  const temporary = temporaryDirectory();
  try {
    const root = path.join(temporary, "runtime");
    const output = path.join(temporary, "manifest.json");
    write(root, "intents/a.md", "a\n");

    const result = run([
      "--root",
      root,
      "--include",
      "intents/*.md",
      "--files-output",
      output,
      "--hash-output",
      output,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stdout, /manifest paths must be distinct/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
