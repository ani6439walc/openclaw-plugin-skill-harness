#!/usr/bin/env node
// Run after pnpm run build; exercises the read-only production-validator CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const script = fileURLToPath(
  new URL("./validate-experiences.mjs", import.meta.url),
);
let root;
let experiences;
let entry;
let skills;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "experience-cli-test-"));
  experiences = path.join(root, "experiences");
  entry = path.join(experiences, "example");
  fs.mkdirSync(entry, { recursive: true });
  for (const [name, text] of Object.entries({
    "summary.md": "Reusable procedure.",
    "keywords.md": "procedure",
    "body.md": "PRIVATE_BODY: perform and verify the procedure.",
    "skills.md": "example-skill",
  })) {
    fs.writeFileSync(path.join(entry, name), text);
  }
  skills = path.join(root, "visible.json");
  fs.writeFileSync(
    skills,
    JSON.stringify({ main: [], worker: ["example-skill"] }),
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function snapshot(directory) {
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return [[file, fs.readlinkSync(file)]];
      if (stat.isDirectory()) return [[file, "directory"], ...snapshot(file)];
      return [[file, fs.readFileSync(file)]];
    });
}

function validate(extra = []) {
  const before = snapshot(root);
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--experiences-dir",
      experiences,
      "--visible-skills-file",
      skills,
      ...extra,
    ],
    { encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes("PRIVATE_BODY"));
  assert.ok(!result.stdout.includes(root));
  assert.deepEqual(snapshot(root), before);
  return { code: result.status, report: JSON.parse(result.stdout) };
}

test("accepts valid entries with complete all-agent visibility", () => {
  assert.deepEqual(validate(), {
    code: 0,
    report: { valid: true, entryCount: 1, errors: [] },
  });
});

test("rejects content limits and invisible associated skills", () => {
  fs.writeFileSync(path.join(entry, "summary.md"), "x".repeat(241));
  let result = validate();
  assert.equal(result.code, 1);
  assert.match(JSON.stringify(result.report), /240/);
  fs.writeFileSync(path.join(entry, "summary.md"), "Summary.");
  fs.writeFileSync(skills, '{"main": []}');
  result = validate();
  assert.equal(result.code, 1);
  assert.match(JSON.stringify(result.report), /not visible/);
});

test("rejects missing roots, symlink roots and symlink entry files", () => {
  const saved = path.join(root, "saved");
  fs.renameSync(experiences, saved);
  assert.equal(validate().code, 1);
  fs.symlinkSync(saved, experiences, "dir");
  let result = validate();
  assert.equal(result.code, 1);
  assert.match(JSON.stringify(result.report), /symbolic link/);
  fs.unlinkSync(experiences);
  fs.renameSync(saved, experiences);
  fs.unlinkSync(path.join(entry, "body.md"));
  fs.symlinkSync(skills, path.join(entry, "body.md"));
  result = validate();
  assert.equal(result.code, 1);
  assert.match(JSON.stringify(result.report), /symbolic links/);
});

test("rejects malformed visibility files and unsupported or missing arguments", () => {
  for (const content of [
    "not JSON",
    "[]",
    '{"main": "example-skill"}',
    '{"main": [1]}',
  ]) {
    fs.writeFileSync(skills, content);
    const result = validate();
    assert.equal(result.code, 1);
    assert.equal(result.report.valid, false);
  }
  fs.unlinkSync(skills);
  assert.equal(validate().code, 1);
  assert.equal(validate(["--unknown"]).code, 1);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Required/);
});
