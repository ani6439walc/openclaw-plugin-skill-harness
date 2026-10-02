#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      "experiences-dir": { type: "string" },
      "visible-skills-file": { type: "string" },
    },
    allowPositionals: false,
  });
  const directory = values["experiences-dir"];
  const skillsFile = values["visible-skills-file"];
  if (!directory || !skillsFile) {
    throw new Error(
      "Required: --experiences-dir <directory> --visible-skills-file <JSON file>",
    );
  }
  const [{ validateExperienceDirectory }, { readJsonFile }] = await Promise.all(
    [
      import("../../../dist/src/experiences/catalog.js"),
      import("../../../dist/src/file-utils.js"),
    ],
  ).catch(() => {
    throw new Error(
      "Built modules unavailable; run pnpm run build from the package root.",
    );
  });
  const stat = await lstat(directory).catch(() => {
    throw new Error("Experience directory is missing or unreadable.");
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "Experience root must be a directory, not a symbolic link.",
    );
  }
  let visible;
  try {
    visible = readJsonFile(skillsFile);
  } catch {
    throw new Error(
      "Visible skills JSON is missing, unreadable, or malformed.",
    );
  }
  if (
    !visible ||
    typeof visible !== "object" ||
    Array.isArray(visible) ||
    Object.entries(visible).some(
      ([agent, skills]) =>
        !agent.trim() ||
        !Array.isArray(skills) ||
        skills.some((skill) => typeof skill !== "string" || !skill.trim()),
    )
  ) {
    throw new Error(
      "Visible skills must be a JSON object mapping agent IDs to arrays of non-empty skill names.",
    );
  }
  const result = validateExperienceDirectory({
    experienceDirectory: directory,
    visibleSkillsByAgent: visible,
  });
  // Filesystem failures may contain absolute paths; emit a bounded generic error instead.
  const errors = result.errors.map(({ file, message }) => ({
    file,
    message: /(?:ENOENT|EACCES|EPERM|realpath|failed to (?:stat|read))/.test(
      message,
    )
      ? "Experience file could not be inspected."
      : message,
  }));
  process.stdout.write(
    JSON.stringify(
      { valid: result.valid, entryCount: result.entries.length, errors },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = result.valid ? 0 : 1;
}

main().catch((error) => {
  const message = error?.code
    ? "Validation input could not be read."
    : error.message;
  process.stdout.write(
    JSON.stringify({
      valid: false,
      entryCount: 0,
      errors: [{ file: ".", message }],
    }) + "\n",
  );
  process.exitCode = 1;
});
