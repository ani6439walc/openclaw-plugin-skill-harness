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
  const instrumented = path.join(
    temporary,
    "instrumented-apply-runtime-data.py",
  );
  const source = fs.readFileSync(secureScript, "utf8");
  assert.equal(source.includes(marker), true, `missing marker: ${marker}`);
  fs.writeFileSync(
    instrumented,
    source.replace(marker, `${injected}${marker}`),
  );
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

function instrumentRuntimeScriptLast(temporary, marker, injected) {
  const directory = path.join(temporary, "instrumented-runtime-last");
  fs.mkdirSync(directory);
  const helper = fs.readFileSync(secureScript, "utf8");
  const offset = helper.lastIndexOf(marker);
  assert.notEqual(offset, -1, `missing marker: ${marker}`);
  fs.writeFileSync(
    path.join(directory, "apply-runtime-data-secure.py"),
    `${helper.slice(0, offset)}${injected}${helper.slice(offset)}`,
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

test("does not create missing owned parents through a detached active root", () => {
  const temporary = temporaryDirectory();
  try {
    const artifact = path.join(temporary, "artifact");
    const active = path.join(temporary, "active");
    const marker = path.join(temporary, "missing-parent-swap-marker");
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
    const instrumented = instrumentRuntimeScript(
      temporary,
      "    os.mkdir(name, dir_fd=parent_fd)\n",
      `    with open(os.environ["SKILL_HARNESS_TEST_MISSING_PARENT_SWAP_MARKER"], "w", encoding="utf-8") as handle:
                    handle.write("swapped\\n")
    root_path = active_root_path
    os.rename(root_path, f"{root_path}-swapped")
    os.mkdir(root_path)

`,
    );

    const result = runScript(
      instrumented,
      [
        "--artifact-root",
        artifact,
        "--active-root",
        active,
        "--operations",
        operations,
        "--apply",
      ],
      { SKILL_HARNESS_TEST_MISSING_PARENT_SWAP_MARKER: marker },
    );

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "swapped\n");
    assert.equal(
      fs.existsSync(path.join(`${active}-swapped`, "experiences")),
      false,
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

test("does not leave a copied temporary through an owned-ancestor swap", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-final-rename");
    const marker = path.join(temporary, "final-rename-marker");
    write(outside, "replace.md", "outside\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "        copy_fd(source_fd, temporary_fd)\n",
      `        if destination_segments == ["intents", "replace.md"]:
            os.rename(
            os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "intents"),
            os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "intents-swapped"),
            )
            os.symlink(
            os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_TARGET"],
            os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "intents"),
            target_is_directory=True,
            )
            with open(os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_MARKER"], "w", encoding="utf-8") as handle:
                handle.write("replace\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_FINAL_SWAP_TARGET: outside,
      SKILL_HARNESS_TEST_FINAL_SWAP_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "replace\n");
    assert.equal(
      fs.readFileSync(path.join(outside, "replace.md"), "utf8"),
      "outside\n",
    );
    assert.equal(
      fs.readFileSync(
        path.join(item.active, "intents-swapped", "replace.md"),
        "utf8",
      ),
      "before\n",
    );
    assert.deepEqual(
      fs.readdirSync(path.join(item.active, "intents-swapped")),
      ["create.md", "replace.md"],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("does not create a delete temporary through an owned-ancestor swap", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-final-unlink");
    const marker = path.join(temporary, "final-unlink-marker");
    write(outside, "react/delete.md", "outside delete\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "            temporary, temporary_fd = make_temporary(\n",
      `            os.rename(
                os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "experiences"),
                os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "experiences-swapped"),
            )
            os.symlink(
                os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_TARGET"],
                os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "experiences"),
                target_is_directory=True,
            )
            with open(os.environ["SKILL_HARNESS_TEST_FINAL_SWAP_MARKER"], "w", encoding="utf-8") as handle:
                handle.write("delete\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_FINAL_SWAP_TARGET: outside,
      SKILL_HARNESS_TEST_FINAL_SWAP_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "delete\n");
    assert.equal(
      fs.readFileSync(path.join(outside, "react", "delete.md"), "utf8"),
      "outside delete\n",
    );
    assert.equal(
      fs.readFileSync(
        path.join(item.active, "experiences-swapped", "react", "delete.md"),
        "utf8",
      ),
      "delete\n",
    );
    assert.deepEqual(
      fs.readdirSync(path.join(item.active, "experiences-swapped", "react")),
      ["delete.md"],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("restores a delete exchange when its parent detaches", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-delete-exchange");
    const marker = path.join(temporary, "delete-exchange-marker");
    write(outside, "react/delete.md", "outside delete\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "            swapped_fd = open_regular(parent_fd, temporary)\n",
      `            os.rename(
                os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "experiences"),
                os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "experiences-swapped"),
            )
            os.symlink(
                os.environ["SKILL_HARNESS_TEST_DELETE_EXCHANGE_TARGET"],
                os.path.join(os.readlink(f"/proc/self/fd/{active_root_fd}"), "experiences"),
                target_is_directory=True,
            )
            with open(os.environ["SKILL_HARNESS_TEST_DELETE_EXCHANGE_MARKER"], "w", encoding="utf-8") as handle:
                handle.write("swapped\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_DELETE_EXCHANGE_MARKER: marker,
      SKILL_HARNESS_TEST_DELETE_EXCHANGE_TARGET: outside,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "swapped\n");
    assert.deepEqual(
      fs.readdirSync(path.join(item.active, "experiences-swapped", "react")),
      ["delete.md"],
    );
    assert.equal(
      fs.readFileSync(
        path.join(item.active, "experiences-swapped", "react", "delete.md"),
        "utf8",
      ),
      "delete\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("restores a replace exchange when its parent detaches", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-replace-exchange");
    const marker = path.join(temporary, "replace-exchange-marker");
    write(outside, "replace.md", "outside replace\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      `            renameat2(parent_fd, temporary, parent_fd, name, RENAME_EXCHANGE)
            swapped_fd = open_regular(parent_fd, temporary)
`,
      `            if destination_segments == ["intents", "replace.md"]:
                active_root_path = os.readlink(f"/proc/self/fd/{active_root_fd}")
                intents_path = os.path.join(active_root_path, "intents")
                os.rename(intents_path, f"{intents_path}-swapped")
                os.symlink(
                    os.environ["SKILL_HARNESS_TEST_REPLACE_EXCHANGE_TARGET"],
                    intents_path,
                    target_is_directory=True,
                )
                with open(os.environ["SKILL_HARNESS_TEST_REPLACE_EXCHANGE_MARKER"], "w", encoding="utf-8") as handle:
                    handle.write("swapped\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_REPLACE_EXCHANGE_MARKER: marker,
      SKILL_HARNESS_TEST_REPLACE_EXCHANGE_TARGET: outside,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "swapped\n");
    assert.deepEqual(
      fs.readdirSync(path.join(item.active, "intents-swapped")),
      ["create.md", "replace.md"],
    );
    assert.equal(
      fs.readFileSync(
        path.join(item.active, "intents-swapped", "replace.md"),
        "utf8",
      ),
      "before\n",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("removes an exchanged delete placeholder when its parent detaches", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const outside = path.join(temporary, "outside-delete-placeholder");
    const marker = path.join(temporary, "delete-placeholder-marker");
    write(outside, "react/delete.md", "outside delete\n");
    const instrumented = instrumentRuntimeScript(
      temporary,
      `            os.unlink(temporary, dir_fd=parent_fd)
            try:
                assert_parent_continuity(
                    active_root_path,
                    active_root_fd,
                    destination_segments,
                    parent_fd,
                )
`,
      `            active_root_path = os.readlink(f"/proc/self/fd/{active_root_fd}")
            experiences_path = os.path.join(active_root_path, "experiences")
            os.rename(experiences_path, f"{experiences_path}-swapped")
            os.symlink(
                os.environ["SKILL_HARNESS_TEST_DELETE_PLACEHOLDER_TARGET"],
                experiences_path,
                target_is_directory=True,
            )
            with open(os.environ["SKILL_HARNESS_TEST_DELETE_PLACEHOLDER_MARKER"], "w", encoding="utf-8") as handle:
                handle.write("swapped\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_DELETE_PLACEHOLDER_MARKER: marker,
      SKILL_HARNESS_TEST_DELETE_PLACEHOLDER_TARGET: outside,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "swapped\n");
    assert.deepEqual(
      fs.readdirSync(path.join(item.active, "experiences-swapped", "react")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed when a deleted temporary name is recreated", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const marker = path.join(temporary, "delete-temporary-marker");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "            os.unlink(name, dir_fd=parent_fd)\n",
      `            attacker_fd = os.open(temporary, WRITE_FILE_FLAGS, 0o600, dir_fd=parent_fd)
            try:
                os.write(attacker_fd, b"attacker\\n")
            finally:
                os.close(attacker_fd)
            with open(os.environ["SKILL_HARNESS_TEST_DELETE_TEMPORARY_MARKER"], "w", encoding="utf-8") as handle:
                handle.write("recreated\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_DELETE_TEMPORARY_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "recreated\n");
    assert.equal(
      fs.existsSync(
        path.join(item.active, "experiences", "react", "delete.md"),
      ),
      false,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed when the active root changes after the final postimage scan", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const marker = path.join(temporary, "final-root-marker");
    const instrumented = instrumentRuntimeScriptLast(
      temporary,
      "        assert_root_continuity(args.active_root_path, active_root_fd)\n",
      `        with open(os.environ["SKILL_HARNESS_TEST_FINAL_ROOT_MARKER"], "w", encoding="utf-8") as handle:
            handle.write("swapped\\n")
        active_root_path = os.readlink(f"/proc/self/fd/{active_root_fd}")
        os.rename(active_root_path, f"{active_root_path}-swapped")
        os.mkdir(active_root_path)

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_FINAL_ROOT_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "swapped\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed when an owned root changes after the final postimage scan", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const marker = path.join(temporary, "final-owned-root-marker");
    const instrumented = instrumentRuntimeScriptLast(
      temporary,
      "        assert_owned_roots_continuity(active_root_fd, owned_root_identities)\n",
      `        with open(os.environ["SKILL_HARNESS_TEST_FINAL_OWNED_ROOT_MARKER"], "w", encoding="utf-8") as handle:
            handle.write("swapped\\n")
        active_root_path = os.readlink(f"/proc/self/fd/{active_root_fd}")
        intents_path = os.path.join(active_root_path, "intents")
        os.rename(intents_path, f"{intents_path}-swapped")
        os.mkdir(intents_path)
        replacement_fd = os.open("replacement.md", WRITE_FILE_FLAGS, 0o600, dir_fd=os.open(intents_path, READ_DIRECTORY_FLAGS))
        try:
            os.write(replacement_fd, b"replacement\\n")
        finally:
            os.close(replacement_fd)

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_FINAL_OWNED_ROOT_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "swapped\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("fails closed when owned content changes between final postimage scans", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const marker = path.join(temporary, "final-content-marker");
    const instrumented = instrumentRuntimeScript(
      temporary,
      `        assert_root_continuity(args.active_root_path, active_root_fd)
        final_postimage, final_owned_root_identities = scan_active_preimages(
            active_root_fd
        )
`,
      `        intents_fd = os.open("intents", READ_DIRECTORY_FLAGS, dir_fd=active_root_fd)
        try:
            late_fd = os.open("late.md", WRITE_FILE_FLAGS, 0o600, dir_fd=intents_fd)
            try:
                os.write(late_fd, b"late\\n")
            finally:
                os.close(late_fd)
        finally:
            os.close(intents_fd)
        with open(os.environ["SKILL_HARNESS_TEST_FINAL_CONTENT_MARKER"], "w", encoding="utf-8") as handle:
            handle.write("changed\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_FINAL_CONTENT_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(
      fs.existsSync(marker),
      true,
      `${result.stdout}\n${result.stderr}`,
    );
    assert.equal(fs.readFileSync(marker, "utf8"), "changed\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("removes a staged temporary when its hash changes", () => {
  const temporary = temporaryDirectory();
  try {
    const item = fixture(temporary);
    const marker = path.join(temporary, "temporary-hash-marker");
    const instrumented = instrumentRuntimeScript(
      temporary,
      "        if sha256_fd(temporary_fd) != expected_source:\n",
      `        if destination_segments == ["intents", "create.md"]:
            os.lseek(temporary_fd, 0, os.SEEK_SET)
            os.write(temporary_fd, b"drift\\n")
            with open(os.environ["SKILL_HARNESS_TEST_TEMPORARY_HASH_MARKER"], "w", encoding="utf-8") as handle:
                handle.write("changed\\n")

`,
    );

    const result = runScript(instrumented, args(item, "--apply"), {
      SKILL_HARNESS_TEST_TEMPORARY_HASH_MARKER: marker,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /applied/);
    assert.equal(fs.readFileSync(marker, "utf8"), "changed\n");
    assert.deepEqual(fs.readdirSync(path.join(item.active, "intents")), [
      "replace.md",
    ]);
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
