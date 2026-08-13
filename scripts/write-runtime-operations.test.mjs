import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./write-runtime-operations.mjs", import.meta.url),
);

function temporaryDirectory() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "skill-harness-runtime-operations-"),
  );
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function write(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function sealActive(temporary, activeRoot, paths) {
  const files = [...paths].sort();
  const hashes = files.map((relative) => ({
    path: relative,
    sha256: sha256(
      fs.readFileSync(path.join(activeRoot, ...relative.split("/"))),
    ),
  }));
  const filesManifest = path.join(temporary, "runtime-source.files");
  const hashesManifest = path.join(temporary, "runtime-source.sha256");
  fs.writeFileSync(filesManifest, `${JSON.stringify(files, null, 2)}\n`);
  fs.writeFileSync(hashesManifest, `${JSON.stringify(hashes, null, 2)}\n`);
  return { filesManifest, hashesManifest };
}

function args(activeRoot, stagedRoot, sealed, output) {
  return [
    "--active-root",
    activeRoot,
    "--staged-root",
    stagedRoot,
    "--runtime-source-files",
    sealed.filesManifest,
    "--runtime-source-hashes",
    sealed.hashesManifest,
    "--output",
    output,
  ];
}

test("writes exact sorted create, replace, and delete operations", () => {
  const temporary = temporaryDirectory();
  try {
    const activeRoot = path.join(temporary, "active");
    const stagedRoot = path.join(temporary, "staged");
    const output = path.join(temporary, "runtime-operations.json");
    write(activeRoot, "intents/keep.md", "same\n");
    write(activeRoot, "intents/replace.md", "before\n");
    write(activeRoot, "intents/rename-old.md", "rename\n");
    write(activeRoot, "experiences/react/delete.md", "delete\n");
    write(stagedRoot, "intents/keep.md", "same\n");
    write(stagedRoot, "intents/replace.md", "after\n");
    write(stagedRoot, "intents/rename-new.md", "rename\n");
    write(stagedRoot, "experiences/react/create.md", "create\n");
    const sealed = sealActive(temporary, activeRoot, [
      "experiences/react/delete.md",
      "intents/keep.md",
      "intents/rename-old.md",
      "intents/replace.md",
    ]);

    const result = run(args(activeRoot, stagedRoot, sealed, output));

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      version: 1,
      activePreimages: [
        {
          path: "experiences/react/delete.md",
          sha256: sha256("delete\n"),
        },
        { path: "intents/keep.md", sha256: sha256("same\n") },
        { path: "intents/rename-old.md", sha256: sha256("rename\n") },
        { path: "intents/replace.md", sha256: sha256("before\n") },
      ],
      operations: [
        {
          operation: "create",
          destination: "experiences/react/create.md",
          source: "experiences/react/create.md",
          sha256: sha256("create\n"),
        },
        {
          operation: "delete",
          destination: "experiences/react/delete.md",
          expectedSha256: sha256("delete\n"),
        },
        {
          operation: "create",
          destination: "intents/rename-new.md",
          source: "intents/rename-new.md",
          sha256: sha256("rename\n"),
        },
        {
          operation: "delete",
          destination: "intents/rename-old.md",
          expectedSha256: sha256("rename\n"),
        },
        {
          operation: "replace",
          destination: "intents/replace.md",
          source: "intents/replace.md",
          sha256: sha256("after\n"),
          expectedSha256: sha256("before\n"),
        },
      ],
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("returns STALE for added, missing, or modified active source files", () => {
  const temporary = temporaryDirectory();
  try {
    const activeRoot = path.join(temporary, "active");
    const stagedRoot = path.join(temporary, "staged");
    const output = path.join(temporary, "runtime-operations.json");
    write(activeRoot, "intents/a.md", "a\n");
    write(stagedRoot, "intents/a.md", "a\n");
    const sealed = sealActive(temporary, activeRoot, ["intents/a.md"]);
    fs.writeFileSync(output, "approved-before\n");

    const mutations = [
      () => write(activeRoot, "intents/b.md", "b\n"),
      () => fs.rmSync(path.join(activeRoot, "intents", "a.md")),
      () => write(activeRoot, "intents/a.md", "changed\n"),
    ];
    for (const mutate of mutations) {
      fs.rmSync(activeRoot, { recursive: true, force: true });
      write(activeRoot, "intents/a.md", "a\n");
      mutate();
      const result = run(args(activeRoot, stagedRoot, sealed, output));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "STALE\n");
      assert.equal(fs.readFileSync(output, "utf8"), "approved-before\n");
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects malformed, duplicate, escaping, and mismatched source manifests", () => {
  const temporary = temporaryDirectory();
  try {
    const activeRoot = path.join(temporary, "active");
    const stagedRoot = path.join(temporary, "staged");
    const output = path.join(temporary, "operations.json");
    write(activeRoot, "intents/a.md", "a\n");
    write(stagedRoot, "intents/a.md", "a\n");
    const sealed = sealActive(temporary, activeRoot, ["intents/a.md"]);
    const variants = [
      ["../outside.md"],
      [path.join(temporary, "outside.md")],
      ["intents/a.md", "intents/a.md"],
      ["unknown/a.md"],
    ];
    for (const files of variants) {
      fs.writeFileSync(sealed.filesManifest, JSON.stringify(files));
      const result = run(args(activeRoot, stagedRoot, sealed, output));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /source manifest is invalid/);
      assert.equal(fs.existsSync(output), false);
    }

    const restored = sealActive(temporary, activeRoot, ["intents/a.md"]);
    fs.writeFileSync(
      restored.hashesManifest,
      JSON.stringify([{ path: "intents/a.md", sha256: "0".repeat(64) }]),
    );
    const mismatch = run(args(activeRoot, stagedRoot, restored, output));
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.stdout, "STALE\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects symbolic links and non-Markdown files in owned trees", () => {
  const temporary = temporaryDirectory();
  try {
    const activeRoot = path.join(temporary, "active");
    const stagedRoot = path.join(temporary, "staged");
    const output = path.join(temporary, "operations.json");
    write(activeRoot, "intents/a.md", "a\n");
    const sealed = sealActive(temporary, activeRoot, ["intents/a.md"]);
    write(stagedRoot, "intents/a.md", "a\n");
    fs.symlinkSync("a.md", path.join(stagedRoot, "intents", "alias.md"));

    const symlink = run(args(activeRoot, stagedRoot, sealed, output));
    assert.equal(symlink.status, 1);
    assert.match(symlink.stdout, /symbolic links are not allowed/);

    fs.rmSync(path.join(stagedRoot, "intents", "alias.md"));
    write(stagedRoot, "intents/note.txt", "not markdown\n");
    const nonMarkdown = run(args(activeRoot, stagedRoot, sealed, output));
    assert.equal(nonMarkdown.status, 1);
    assert.match(nonMarkdown.stdout, /only Markdown files are allowed/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("requires at least one staged intent and permits an absent experiences root", () => {
  const temporary = temporaryDirectory();
  try {
    const activeRoot = path.join(temporary, "active");
    const stagedRoot = path.join(temporary, "staged");
    fs.mkdirSync(activeRoot, { recursive: true });
    fs.mkdirSync(stagedRoot, { recursive: true });
    const sealed = sealActive(temporary, activeRoot, []);
    const output = path.join(temporary, "operations.json");

    const empty = run(args(activeRoot, stagedRoot, sealed, output));
    assert.equal(empty.status, 1);
    assert.match(empty.stdout, /staged intents must contain Markdown files/);

    write(stagedRoot, "intents/only.md", "only\n");
    const valid = run(args(activeRoot, stagedRoot, sealed, output));
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      version: 1,
      activePreimages: [],
      operations: [
        {
          operation: "create",
          destination: "intents/only.md",
          source: "intents/only.md",
          sha256: sha256("only\n"),
        },
      ],
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
