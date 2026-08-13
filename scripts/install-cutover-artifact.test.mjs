import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./install-cutover-artifact.mjs", import.meta.url),
);

function temporaryDirectory() {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "skill-harness-install-artifact-"),
  );
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function write(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function prepareSource(temporary) {
  const source = path.join(temporary, "source");
  write(source, "intents/hello world.md", "hello\n");
  write(source, "experiences/react/表單.md", "forms\n");
  const files = ["experiences/react/表單.md", "intents/hello world.md"];
  const hashes = [
    { path: "experiences/react/表單.md", sha256: hash("forms\n") },
    { path: "intents/hello world.md", sha256: hash("hello\n") },
  ];
  write(source, "runtime-payload.files", `${JSON.stringify(files, null, 2)}\n`);
  write(
    source,
    "runtime-payload.sha256",
    `${JSON.stringify(hashes, null, 2)}\n`,
  );
  write(source, "approval.sha256", "approved metadata\n");
  return source;
}

function installArgs(source, destination) {
  return [
    "--source",
    source,
    "--destination",
    destination,
    "--payload-files",
    "runtime-payload.files",
    "--payload-hashes",
    "runtime-payload.sha256",
    "--extra",
    "runtime-payload.files",
    "--extra",
    "runtime-payload.sha256",
    "--extra",
    "approval.sha256",
  ];
}

test("atomically installs only sealed payload files and explicit extras", () => {
  const temporary = temporaryDirectory();
  try {
    const source = prepareSource(temporary);
    write(source, "not-approved.txt", "exclude\n");
    const destination = path.join(temporary, "artifact");

    const result = run(installArgs(source, destination));

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "installed\n");
    assert.equal(
      fs.readFileSync(
        path.join(destination, "intents", "hello world.md"),
        "utf8",
      ),
      "hello\n",
    );
    assert.equal(
      fs.readFileSync(
        path.join(destination, "experiences", "react", "表單.md"),
        "utf8",
      ),
      "forms\n",
    );
    assert.equal(
      fs.existsSync(path.join(destination, "not-approved.txt")),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(destination, "approval.sha256"), "utf8"),
      "approved metadata\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("reuses only an exact existing destination", () => {
  const temporary = temporaryDirectory();
  try {
    const source = prepareSource(temporary);
    const destination = path.join(temporary, "artifact");
    assert.equal(run(installArgs(source, destination)).status, 0);

    const retry = run(installArgs(source, destination));
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(retry.stdout, "reused\n");

    const variants = [
      () => write(destination, "intents/hello world.md", "modified\n"),
      () => fs.rmSync(path.join(destination, "approval.sha256")),
      () => write(destination, "extra.txt", "extra\n"),
    ];
    for (const mutate of variants) {
      fs.rmSync(destination, { recursive: true, force: true });
      assert.equal(run(installArgs(source, destination)).status, 0);
      mutate();
      const snapshot = fs.readFileSync(
        path.join(destination, "intents", "hello world.md"),
        "utf8",
      );
      const stale = run(installArgs(source, destination));
      assert.equal(stale.status, 1);
      assert.equal(stale.stdout, "STALE\n");
      assert.equal(
        fs.readFileSync(
          path.join(destination, "intents", "hello world.md"),
          "utf8",
        ),
        snapshot,
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects path escapes, absolute paths, duplicate entries, and source symlinks", () => {
  const temporary = temporaryDirectory();
  try {
    const source = prepareSource(temporary);
    const destination = path.join(temporary, "artifact");
    const manifests = [
      ["../outside.md"],
      [path.join(temporary, "outside.md")],
      ["intents/hello world.md", "intents/hello world.md"],
    ];
    for (const files of manifests) {
      write(
        source,
        "runtime-payload.files",
        `${JSON.stringify(files, null, 2)}\n`,
      );
      const result = run(installArgs(source, destination));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /payload manifest is invalid/);
      assert.equal(fs.existsSync(destination), false);
    }

    fs.rmSync(source, { recursive: true, force: true });
    prepareSource(temporary);
    fs.rmSync(path.join(source, "intents", "hello world.md"));
    fs.symlinkSync(
      path.join(temporary, "outside.md"),
      path.join(source, "intents", "hello world.md"),
    );
    write(temporary, "outside.md", "hello\n");
    const symlink = run(installArgs(source, destination));
    assert.equal(symlink.status, 1);
    assert.match(symlink.stdout, /symbolic links are not allowed/);
    assert.equal(fs.existsSync(destination), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects payload hash drift and conflicting extras", () => {
  const temporary = temporaryDirectory();
  try {
    const source = prepareSource(temporary);
    const destination = path.join(temporary, "artifact");
    write(source, "intents/hello world.md", "drift\n");
    const drift = run(installArgs(source, destination));
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /payload hash mismatch/);
    assert.equal(fs.existsSync(destination), false);

    const restored = prepareSource(temporary);
    const duplicateExtra = run([
      ...installArgs(restored, destination),
      "--extra",
      "approval.sha256",
    ]);
    assert.equal(duplicateExtra.status, 1);
    assert.match(duplicateExtra.stdout, /extra paths must be unique/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a failure before rename never publishes a partial destination", () => {
  const temporary = temporaryDirectory();
  try {
    const source = prepareSource(temporary);
    const destination = path.join(temporary, "artifact");
    const result = run(installArgs(source, destination), {
      SKILL_HARNESS_TEST_FAIL_BEFORE_ARTIFACT_RENAME: "1",
    });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /injected failure before artifact rename/);
    assert.equal(fs.existsSync(destination), false);
    const leftovers = fs
      .readdirSync(temporary)
      .filter((name) => name.startsWith(".artifact.tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects a symbolic-link destination parent without writing its target", () => {
  const temporary = temporaryDirectory();
  try {
    const source = prepareSource(temporary);
    const outside = path.join(temporary, "outside");
    const linkedParent = path.join(temporary, "linked-parent");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, linkedParent, "dir");
    const destination = path.join(linkedParent, "artifact");

    const result = run(installArgs(source, destination));

    assert.equal(result.status, 1);
    assert.match(result.stdout, /destination parent.*symbolic link/);
    assert.equal(fs.existsSync(path.join(outside, "artifact")), false);

    fs.mkdirSync(path.join(outside, "artifact"));
    const existing = run(installArgs(source, destination));
    assert.equal(existing.status, 1);
    assert.match(existing.stdout, /destination parent.*symbolic link/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
