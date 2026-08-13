import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./apply-runtime-data.mjs", import.meta.url),
);
const secureScript = fileURLToPath(
  new URL("./apply-runtime-data-secure.py", import.meta.url),
);

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-harness-apply-runtime-"));
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runScript(scriptPath, args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}


function instrumentSecureScript(temporary, marker, injected) {
  const instrumented = path.join(temporary, "instrumented-apply-runtime-data.py");
  const source = fs.readFileSync(secureScript, "utf8");
  assert.equal(source.includes(marker), true, `missing marker: ${marker}`);
  fs.writeFileSync(instrumented, source.replace(marker, `${injected}${marker}`));
  return instrumented;
}

function instrumentRuntimeScript(temporary, marker, injected) {
  const directory = path.join(temporary, "instrumented-runtime");
  fs.mkdirSync(directory);
  const helper = fs.readFileSync(secureScript, "utf8");
  assert.equal(helper.includes(marker), true, `missing marker: ${marker}`);
  fs.writeFileSync(
    path.join(directory, "apply-runtime-data-secure.py"),
    helper.replace(marker, `${injected}${marker}`),
  );
  const instrumented = path.join(directory, "apply-runtime-data.mjs");
  fs.copyFileSync(script, instrumented);
  return instrumented;
}


function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function write(root, relativePath, content) {
  const destination = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function fixture(temporary) {
  const artifact = path.join(temporary, "artifact");
  const active = path.join(temporary, "active");
  write(artifact, "intents/create.md", "create\n");
  write(artifact, "intents/replace.md", "after\n");
  write(active, "intents/replace.md", "before\n");
  write(active, "experiences/react/delete.md", "delete\n");
  const operations = [
    {
      operation: "delete",
      destination: "experiences/react/delete.md",
      expectedSha256: sha256("delete\n"),
    },
    {
      operation: "create",
      destination: "intents/create.md",
      source: "intents/create.md",
      sha256: sha256("create\n"),
    },
    {
      operation: "replace",
      destination: "intents/replace.md",
      source: "intents/replace.md",
      sha256: sha256("after\n"),
      expectedSha256: sha256("before\n"),
    },
  ];
  write(
    artifact,
    "runtime-operations.json",
    `${JSON.stringify(
      {
        version: 1,
        activePreimages: [
          {
            path: "experiences/react/delete.md",
            sha256: sha256("delete\n"),
          },
          {
            path: "intents/replace.md",
            sha256: sha256("before\n"),
          },
        ],
        operations,
      },
      null,
      2,
    )}\n`,
  );
  return {
    artifact,
    active,
    operationItems: operations,
    operations: path.join(artifact, "runtime-operations.json"),
  };
}

function args(item, mode) {
  return [
    "--artifact-root",
    item.artifact,
    "--active-root",
    item.active,
    "--operations",
    item.operations,
    mode,
  ];
}


test("dry-run validates the exact transition without writing", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const beforeReplace = fs.readFileSync(
      path.join(item.active, "intents", "replace.md"),
    );
    const beforeDelete = fs.readFileSync(
      path.join(item.active, "experiences", "react", "delete.md"),
    );

    const result = run(args(item, "--dry-run"));

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "dry-run 3 operations\n");
    assert.equal(
      fs.existsSync(path.join(item.active, "intents", "create.md")),
      false,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(item.active, "intents", "replace.md")),
      beforeReplace,
    );
    assert.deepEqual(
      fs.readFileSync(
        path.join(item.active, "experiences", "react", "delete.md"),
      ),
      beforeDelete,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("applies create, replace, and delete with atomic file replacement", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    write(item.active, "sessions/private.json", "untouched\n");

    const result = run(args(item, "--apply"));

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "applied 3 operations\n");
    assert.equal(
      fs.readFileSync(path.join(item.active, "intents", "create.md"), "utf8"),
      "create\n",
    );
    assert.equal(
      fs.readFileSync(path.join(item.active, "intents", "replace.md"), "utf8"),
      "after\n",
    );
    assert.equal(
      fs.existsSync(
        path.join(item.active, "experiences", "react", "delete.md"),
      ),
      false,
    );
    assert.equal(
      fs.readFileSync(
        path.join(item.active, "sessions", "private.json"),
        "utf8",
      ),
      "untouched\n",
    );
    assert.deepEqual(fs.readdirSync(path.join(item.active, "intents")).sort(), [
      "create.md",
      "replace.md",
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("ignores inherited former test-hook environment variables", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);

    const result = run(args(item, "--apply"), {
      SKILL_HARNESS_TEST_MUTATE_BEFORE_RUNTIME_OPERATION: "0",
      SKILL_HARNESS_TEST_MUTATE_AFTER_RUNTIME_COPY: "2",
      SKILL_HARNESS_TEST_SYMLINK_AFTER_RUNTIME_COPY: "2",
      SKILL_HARNESS_TEST_SYMLINK_ACTIVE_ROOT_AFTER_RUNTIME_COPY: "2",
      SKILL_HARNESS_TEST_SYMLINK_BEFORE_RUNTIME_OPERATION: "0",
      SKILL_HARNESS_TEST_FAIL_AFTER_RUNTIME_OPERATION: "0",
      SKILL_HARNESS_TEST_SYMLINK_TARGET: path.join(temporary, "outside"),
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "applied 3 operations\n");
    assert.equal(
      fs.readFileSync(path.join(item.active, "intents", "replace.md"), "utf8"),
      "after\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("creates a destination when its entire owned parent tree is absent", () => {
  const temporary = temporaryDirectory();
  try {
    const artifact = path.join(temporary, "artifact");
    const active = path.join(temporary, "active");
    fs.mkdirSync(active, { recursive: true });
    write(artifact, "experiences/react/new.md", "new\n");
    const operations = path.join(artifact, "runtime-operations.json");
    fs.writeFileSync(
      operations,
      JSON.stringify({
        version: 1,
        activePreimages: [],
        operations: [
          {
            operation: "create",
            destination: "experiences/react/new.md",
            source: "experiences/react/new.md",
            sha256: sha256("new\n"),
          },
        ],
      }),
    );

    const result = run([
      "--artifact-root",
      artifact,
      "--active-root",
      active,
      "--operations",
      operations,
      "--apply",
    ]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      fs.readFileSync(
        path.join(active, "experiences", "react", "new.md"),
        "utf8",
      ),
      "new\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("returns STALE before writing when any active preimage drifted", () => {
  const temporary = temporaryDirectory();
  try {
    const mutations = [
      (item) => write(item.active, "intents/create.md", "occupied\n"),
      (item) => write(item.active, "intents/replace.md", "drift\n"),
      (item) =>
        fs.rmSync(path.join(item.active, "experiences", "react", "delete.md")),
    ];
    for (const mutate of mutations) {
      const caseRoot = fs.mkdtempSync(path.join(temporary, "case-"));
      const item = fixture(caseRoot);
      mutate(item);
      const result = run(args(item, "--apply"));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "STALE\n");
      assert.equal(
        fs.readFileSync(
          path.join(item.active, "intents", "replace.md"),
          "utf8",
        ),
        mutate === mutations[1] ? "drift\n" : "before\n",
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("returns STALE before writing when an artifact source hash drifted", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    write(item.artifact, "intents/create.md", "drift\n");

    const result = run(args(item, "--apply"));

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "STALE\n");
    assert.equal(
      fs.existsSync(path.join(item.active, "intents", "create.md")),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(item.active, "intents", "replace.md"), "utf8"),
      "before\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("returns STALE for added, missing, or modified unchanged active files", () => {
  const temporary = temporaryDirectory();
  try {
    for (const mutate of [
      (item) => write(item.active, "intents/extra.md", "extra\n"),
      (item) => fs.rmSync(path.join(item.active, "intents", "unchanged.md")),
      (item) => write(item.active, "intents/unchanged.md", "modified\n"),
    ]) {
      const caseRoot = fs.mkdtempSync(path.join(temporary, "case-"));
      const item = fixture(caseRoot);
      write(item.active, "intents/unchanged.md", "unchanged\n");
      const manifest = JSON.parse(fs.readFileSync(item.operations, "utf8"));
      manifest.activePreimages.push({
        path: "intents/unchanged.md",
        sha256: sha256("unchanged\n"),
      });
      fs.writeFileSync(
        item.operations,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      mutate(item);

      const result = run(args(item, "--dry-run"));

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "STALE\n");
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects malformed, duplicate, unsorted, unknown, and escaping operations", () => {
  const temporary = temporaryDirectory();
  try {
    const variants = [
      [
        {
          operation: "create",
          destination: "../outside.md",
          source: "intents/create.md",
          sha256: sha256("create\n"),
        },
      ],
      [
        {
          operation: "create",
          destination: "intents/create.md",
          source: "intents/create.md",
          sha256: sha256("create\n"),
        },
        {
          operation: "delete",
          destination: "intents/create.md",
          expectedSha256: sha256("create\n"),
        },
      ],
      [
        {
          operation: "create",
          destination: "intents/z.md",
          source: "intents/create.md",
          sha256: sha256("create\n"),
        },
        {
          operation: "create",
          destination: "intents/a.md",
          source: "intents/create.md",
          sha256: sha256("create\n"),
        },
      ],
      [{ operation: "chmod", destination: "intents/a.md" }],
      [
        {
          operation: "create",
          destination: "sessions/private.md",
          source: "intents/create.md",
          sha256: sha256("create\n"),
        },
      ],
    ];
    for (const operations of variants) {
      const caseRoot = fs.mkdtempSync(path.join(temporary, "case-"));
      const item = fixture(caseRoot);
      const manifest = JSON.parse(fs.readFileSync(item.operations, "utf8"));
      manifest.operations = operations;
      fs.writeFileSync(item.operations, JSON.stringify(manifest));
      const result = run(args(item, "--dry-run"));
      assert.equal(result.status, 1);
      assert.match(result.stdout, /operations manifest is invalid/);
    }

    const legacyCase = fixture(path.join(temporary, "legacy-case"));
    const legacy = JSON.parse(fs.readFileSync(legacyCase.operations, "utf8"));
    fs.writeFileSync(legacyCase.operations, JSON.stringify(legacy.operations));
    const legacyResult = run(args(legacyCase, "--dry-run"));
    assert.equal(legacyResult.status, 1);
    assert.match(legacyResult.stdout, /operations manifest is invalid/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects symlink artifact sources and active destination ancestors", () => {
  const temporary = temporaryDirectory();
  try {
    const sourceCase = fixture(path.join(temporary, "source-case"));
    fs.rmSync(path.join(sourceCase.artifact, "intents", "create.md"));
    write(temporary, "outside.md", "create\n");
    fs.symlinkSync(
      path.join(temporary, "outside.md"),
      path.join(sourceCase.artifact, "intents", "create.md"),
    );
    const sourceResult = run(args(sourceCase, "--dry-run"));
    assert.equal(sourceResult.status, 1);
    assert.match(sourceResult.stdout, /symbolic links are not allowed/);

    const activeCase = fixture(path.join(temporary, "active-case"));
    fs.rmSync(path.join(activeCase.active, "experiences"), {
      recursive: true,
      force: true,
    });
    fs.symlinkSync(
      path.join(temporary, "outside-active"),
      path.join(activeCase.active, "experiences"),
    );
    const activeResult = run(args(activeCase, "--dry-run"));
    assert.equal(activeResult.status, 1);
    assert.match(activeResult.stdout, /symbolic links are not allowed/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("does not rename through an owned-ancestor swap after final verification", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-final-rename");
    write(outside, "replace.md", "outside\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "        if operation == \"create\":\n",
      `        if operation == "replace":
            os.rename(
            os.path.join(args.active_root_path, "intents"),
            os.path.join(args.active_root_path, "intents-swapped"),
            )
            with open(
            os.path.join(os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_TARGET"], temporary),
            "w",
            encoding="utf-8",
            ) as handle:
                handle.write("outside temporary sentinel\\n")
            os.symlink(
            os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_TARGET"],
            os.path.join(args.active_root_path, "intents"),
            target_is_directory=True,
            )

`,
    );

    const result = runScript(
      instrumented,
      args(item, "--apply"),
      {
        SKILL_HARNESS_TEST_FINAL_SWAP_TARGET: outside,
      },
    );

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(
      fs.readFileSync(path.join(outside, "replace.md"), "utf8"),
      "outside\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("does not unlink through an owned-ancestor swap after final verification", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-final-unlink");
    write(outside, "react/delete.md", "outside delete\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "            temporary, temporary_fd = make_temporary(parent_fd, name)\n",
      `            os.rename(
                os.path.join(args.active_root_path, "experiences"),
                os.path.join(args.active_root_path, "experiences-swapped"),
            )
            os.symlink(
                os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_TARGET"],
                os.path.join(args.active_root_path, "experiences"),
                target_is_directory=True,
            )

`,
    );

    const result = runScript(
      instrumented,
      args(item, "--apply"),
      {
        SKILL_HARNESS_TEST_FINAL_SWAP_TARGET: outside,
      },
    );

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(
      fs.readFileSync(path.join(outside, "react", "delete.md"), "utf8"),
      "outside delete\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("requires the operations manifest to be inside the artifact", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-operations.json");
    fs.copyFileSync(item.operations, outside);
    item.operations = outside;

    const result = run(args(item, "--dry-run"));

    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /operations manifest must be inside artifact root/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
