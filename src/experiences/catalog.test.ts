import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  SkillExperienceCatalog,
  validateExperienceDirectory,
} from "./catalog.js";

function experience(
  params: {
    skill?: string;
    summary?: string;
    keywords?: readonly string[];
    body?: string;
    extra?: string;
  } = {},
): string {
  return `---
skill: ${params.skill ?? "react"}
summary: ${params.summary ?? "Reliable React forms"}
keywords:
${(params.keywords ?? ["forms", "validation"])
  .map((keyword) => `  - ${keyword}`)
  .join("\n")}
${params.extra ?? ""}---
${params.body ?? "Use controlled inputs and validate at the boundary."}
`;
}

function visibleSkillsManifest(
  skillsByAgent: Record<string, readonly string[]>,
): string {
  return JSON.stringify({
    version: 1,
    agents: Object.entries(skillsByAgent).map(([id, skills]) => ({
      id,
      inventory: skills.map((name, index) => ({
        name,
        source: "workspace",
        winnerFingerprint: (index % 2 === 0 ? "1" : "2").repeat(64),
        fingerprint: (index % 2 === 0 ? "3" : "4").repeat(64),
      })),
    })),
  });
}

describe("SkillExperienceCatalog", () => {
  let dataRoot: string;
  let experienceRoot: string;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "experience-catalog-"));
    experienceRoot = path.join(dataRoot, "experiences");
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  function writeEntry(
    skill: string,
    entryId: string,
    content = experience({ skill }),
  ): string {
    const directory = path.join(experienceRoot, skill);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${entryId}.md`);
    fs.writeFileSync(file, content);
    return file;
  }

  it("treats an absent root as an empty catalog", () => {
    const catalog = SkillExperienceCatalog.create(dataRoot);

    expect(catalog.listForSkills(["react"])).toEqual([]);
    expect(catalog.resolve("react/forms")).toBeUndefined();
    expect(catalog.search({ skillNames: ["react"] })).toEqual([]);
  });

  it("rejects a dangling symbolic-link root instead of treating it as absent", () => {
    fs.symlinkSync(path.join(dataRoot, "missing-experiences"), experienceRoot);

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: [] },
    });

    expect(result).toEqual({
      valid: false,
      entries: [],
      errors: [
        { file: ".", message: "experience root cannot be a symbolic link" },
      ],
    });
    const catalog = SkillExperienceCatalog.create(dataRoot);
    expect(catalog.listForSkills(["react"])).toEqual([]);
    expect(catalog.resolve("react/forms")).toBeUndefined();
  });

  it("loads strict entries with stable skill/entry identity", () => {
    const file = writeEntry("react", "forms");
    const catalog = SkillExperienceCatalog.create(dataRoot);

    expect(catalog.resolve("react/forms")).toEqual({
      identity: "react/forms",
      skill: "react",
      entryId: "forms",
      summary: "Reliable React forms",
      keywords: ["forms", "validation"],
      body: "Use controlled inputs and validate at the boundary.",
      path: file,
    });
    expect(catalog.listForSkills([" REACT "])).toEqual([
      expect.objectContaining({ identity: "react/forms" }),
    ]);
    expect(catalog.resolve("../secrets/token")).toBeUndefined();
  });

  it("rescans on every operation so live additions and deletions are visible", () => {
    const catalog = SkillExperienceCatalog.create(dataRoot);
    expect(catalog.listForSkills(["react"])).toEqual([]);

    const file = writeEntry("react", "forms");
    expect(
      catalog.listForSkills(["react"]).map((entry) => entry.identity),
    ).toEqual(["react/forms"]);

    fs.unlinkSync(file);
    expect(catalog.listForSkills(["react"])).toEqual([]);
  });

  it("ranks by identity, exact keyword count, summary phrases, body phrases, then identity", () => {
    writeEntry(
      "react",
      "forms",
      experience({
        skill: "react",
        summary: "Forms only",
        keywords: ["forms"],
        body: "forms forms forms",
      }),
    );
    writeEntry(
      "react",
      "keyword-rich",
      experience({
        skill: "react",
        summary: "Other",
        keywords: ["forms", "FORMS"],
        body: "unrelated",
      }),
    );
    writeEntry(
      "react",
      "summary-rich",
      experience({
        skill: "react",
        summary: "forms forms",
        keywords: ["other"],
        body: "forms forms forms forms",
      }),
    );
    const catalog = SkillExperienceCatalog.create(dataRoot);

    expect(
      catalog
        .search({ skillNames: ["react"], query: "react/forms" })
        .map((entry) => entry.identity),
    ).toEqual(["react/forms"]);
    expect(
      catalog
        .search({ skillNames: ["react"], query: "forms" })
        .map((entry) => entry.identity),
    ).toEqual(["react/forms", "react/summary-rich"]);
    expect(
      catalog
        .search({ skillNames: ["react"], query: "", limit: 2 })
        .map((entry) => entry.identity),
    ).toEqual(["react/forms", "react/summary-rich"]);
  });

  it("normalizes NFKC, whitespace, and locale-independent lowercase for lookup and search", () => {
    writeEntry(
      "react",
      "forms",
      experience({
        skill: "react",
        summary: "ＦＯＲＭＳ   GUIDE",
        keywords: ["ＦＯＲＭＳ"],
      }),
    );
    const catalog = SkillExperienceCatalog.create(dataRoot);

    expect(
      catalog.search({ skillNames: ["ＲＥＡＣＴ"], query: " forms  guide " }),
    ).toEqual([expect.objectContaining({ identity: "react/forms" })]);
  });

  it("rejects malformed schema, bounds, and parent mismatch during validation", () => {
    writeEntry("react", "unknown", experience({ extra: "owner: agent\n" }));
    writeEntry("react", "mismatch", experience({ skill: "vue" }));
    writeEntry(
      "react",
      "long-summary",
      experience({ summary: "😀".repeat(241) }),
    );
    writeEntry("react", "long-body", experience({ body: "😀".repeat(12_001) }));
    writeEntry(
      "react",
      "long-keyword",
      experience({ keywords: ["😀".repeat(65)] }),
    );
    writeEntry(
      "react",
      "duplicate-keyword",
      experience({ keywords: ["Forms", " forms "] }),
    );
    writeEntry("react", "empty-keywords", experience({ keywords: [] }));
    writeEntry(
      "react",
      "many-keywords",
      experience({ keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) }),
    );
    writeEntry("react", "malformed", "---\nskill: [\n---\nbody");

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react", "vue"] },
    });

    expect(result.valid).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.errors.map((error) => error.file)).toEqual(
      expect.arrayContaining([
        "react/duplicate-keyword.md",
        "react/empty-keywords.md",
        "react/long-body.md",
        "react/long-keyword.md",
        "react/long-summary.md",
        "react/malformed.md",
        "react/many-keywords.md",
        "react/mismatch.md",
        "react/unknown.md",
      ]),
    );
  });

  it("reports non-object YAML frontmatter without aborting directory validation", () => {
    writeEntry("react", "scalar", "---\nhello\n---\nbody");
    writeEntry("react", "array", "---\n[]\n---\nbody");
    writeEntry("react", "valid");

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react"] },
    });

    expect(result.valid).toBe(false);
    expect(result.entries.map((entry) => entry.identity)).toEqual([
      "react/valid",
    ]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        {
          file: "react/array.md",
          message: "frontmatter must be an object",
        },
        {
          file: "react/scalar.md",
          message: "frontmatter must be an object",
        },
      ]),
    );
  });

  it("validates every markdown file and reports skills invisible to every configured agent", () => {
    writeEntry("react", "forms");
    writeEntry("vue", "signals", experience({ skill: "vue" }));
    writeEntry("secret", "token", experience({ skill: "secret" }));

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react"], specialist: ["vue"] },
    });

    expect(result.entries.map((entry) => entry.identity)).toEqual([
      "react/forms",
      "vue/signals",
    ]);
    expect(result.errors).toContainEqual({
      file: "secret/token.md",
      message: "skill secret is not visible to any configured agent",
    });
  });

  it("rejects invalid path segments, duplicate canonical identities, and symlinks", () => {
    writeEntry("React", "forms", experience({ skill: "react" }));
    writeEntry("react", "forms", experience({ skill: "react" }));
    writeEntry("react", "bad name", experience({ skill: "react" }));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "experience-outside-"),
    );
    fs.writeFileSync(
      path.join(outside, "leak.md"),
      experience({ skill: "escape" }),
    );
    fs.symlinkSync(outside, path.join(experienceRoot, "escape"), "dir");
    fs.symlinkSync(
      path.join(outside, "leak.md"),
      path.join(experienceRoot, "react", "linked.md"),
    );

    try {
      const result = validateExperienceDirectory({
        experienceDirectory: experienceRoot,
        visibleSkillsByAgent: { main: ["react", "escape"] },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toMatch(
        /normalized/,
      );
      expect(result.errors.map((error) => error.message)).toContain(
        "duplicate canonical identity react/forms",
      );
      expect(result.errors.map((error) => error.message).join("\n")).toMatch(
        /symbolic link|confined/,
      );
      const catalog = SkillExperienceCatalog.create(dataRoot);
      expect(catalog.listForSkills(["react"])).toEqual([
        expect.objectContaining({ identity: "react/forms" }),
      ]);
      expect(catalog.resolve("escape/leak")).toBeUndefined();
      expect(catalog.resolve("react/linked")).toBeUndefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports noncanonical Markdown extensions instead of silently skipping them", () => {
    const directory = path.join(experienceRoot, "react");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "forms.MD"),
      experience({ skill: "react" }),
    );

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react"] },
    });

    expect(result.valid).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.errors).toContainEqual({
      file: "react/forms.MD",
      message: "experience Markdown filename must use the .md extension",
    });
  });
});

describe("validate-runtime-data CLI", () => {
  it("requires all paths, imports validators from the exact dist root, and prints relative results", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-validation-cli-"),
    );
    const distRoot = path.join(root, "custom-dist");
    const intents = path.join(root, "runtime", "intents");
    const experiences = path.join(root, "runtime", "experiences");
    const manifest = path.join(root, "visible.json");
    fs.mkdirSync(path.join(distRoot, "src", "intents"), { recursive: true });
    fs.mkdirSync(path.join(distRoot, "src", "experiences"), {
      recursive: true,
    });
    fs.mkdirSync(intents, { recursive: true });
    fs.mkdirSync(path.join(experiences, "react"), { recursive: true });
    fs.writeFileSync(path.join(distRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(intents, "good.md"), "intent");
    fs.writeFileSync(path.join(intents, "bad.md"), "intent");
    fs.writeFileSync(path.join(experiences, "react", "forms.md"), "experience");
    fs.writeFileSync(manifest, visibleSkillsManifest({ main: ["React"] }));
    fs.writeFileSync(
      path.join(distRoot, "src", "intents", "routing-validation.js"),
      `export function validateRoutingIntentDirectory(directory) {
        if (!directory.endsWith("intents")) throw new Error("wrong intents path");
        return { valid: false, intents: [{ id: "good", file: "good.md", definition: {} }], errors: [directory + "/bad.md: invalid routing data"] };
      }`,
    );
    fs.writeFileSync(
      path.join(distRoot, "src", "experiences", "index.js"),
      `export function validateExperienceDirectory(params) {
        if (!params.experienceDirectory.endsWith("experiences")) throw new Error("wrong experiences path");
        if (params.visibleSkillsByAgent.main[0] !== "react") throw new Error("wrong manifest");
        return { valid: false, entries: [{ identity: "react/forms" }], errors: [{ file: "react/bad.md", message: params.experienceDirectory + "/secret must stay hidden" }] };
      }`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/validate-runtime-data.mjs"),
          "--dist-root",
          distRoot,
          "--intents",
          intents,
          "--experiences",
          experiences,
          "--visible-skills-manifest",
          manifest,
        ],
        { cwd: path.resolve("."), encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("intents: 2 Markdown files, 1 parsed");
      expect(result.stdout).toContain("experiences: 1 Markdown file, 1 valid");
      expect(result.stdout).toContain("intents/bad.md: invalid routing data");
      expect(result.stdout).toContain(
        "experiences/react/bad.md: experiences/secret must stay hidden",
      );
      expect(result.stdout).not.toContain(root);
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints the validator error before enumerating a file-target intent-root symlink", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-validation-cli-symlink-"),
    );
    const distRoot = path.join(root, "dist");
    const target = path.join(root, "intent-target");
    const intents = path.join(root, "intents");
    const experiences = path.join(root, "experiences");
    const manifest = path.join(root, "visible.json");
    fs.mkdirSync(path.join(distRoot, "src", "intents"), { recursive: true });
    fs.mkdirSync(path.join(distRoot, "src", "experiences"), {
      recursive: true,
    });
    fs.mkdirSync(experiences);
    fs.writeFileSync(path.join(distRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(target, "not a directory");
    fs.symlinkSync(target, intents, "file");
    fs.writeFileSync(manifest, visibleSkillsManifest({ main: [] }));
    fs.writeFileSync(
      path.join(distRoot, "src", "intents", "routing-validation.js"),
      `export function validateRoutingIntentDirectory() {
        return { valid: false, intents: [], errors: [".: intent root cannot be a symbolic link"] };
      }`,
    );
    fs.writeFileSync(
      path.join(distRoot, "src", "experiences", "index.js"),
      `export function validateExperienceDirectory() {
        return { valid: true, entries: [], errors: [] };
      }`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/validate-runtime-data.mjs"),
          "--dist-root",
          distRoot,
          "--intents",
          intents,
          "--experiences",
          experiences,
          "--visible-skills-manifest",
          manifest,
        ],
        { cwd: path.resolve("."), encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("intents: 0 Markdown files, 0 parsed");
      expect(result.stdout).toContain(
        "intents/.: intent root cannot be a symbolic link",
      );
      expect(result.stdout).not.toContain("ENOTDIR");
      expect(result.stdout).not.toContain(root);
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a root-inspection validator error when summary enumeration cannot inspect the root", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-validation-cli-root-error-"),
    );
    const distRoot = path.join(root, "dist");
    const parentFile = path.join(root, "not-a-directory");
    const intents = path.join(parentFile, "intents");
    const experiences = path.join(root, "experiences");
    const manifest = path.join(root, "visible.json");
    fs.mkdirSync(path.join(distRoot, "src", "intents"), { recursive: true });
    fs.mkdirSync(path.join(distRoot, "src", "experiences"), {
      recursive: true,
    });
    fs.mkdirSync(experiences);
    fs.writeFileSync(path.join(distRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(parentFile, "not a directory");
    fs.writeFileSync(manifest, visibleSkillsManifest({ main: [] }));
    fs.writeFileSync(
      path.join(distRoot, "src", "intents", "routing-validation.js"),
      `export function validateRoutingIntentDirectory() {
        return { valid: false, intents: [], errors: [".: unable to inspect intent root (ENOTDIR)"] };
      }`,
    );
    fs.writeFileSync(
      path.join(distRoot, "src", "experiences", "index.js"),
      `export function validateExperienceDirectory() {
        return { valid: true, entries: [], errors: [] };
      }`,
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/validate-runtime-data.mjs"),
          "--dist-root",
          distRoot,
          "--intents",
          intents,
          "--experiences",
          experiences,
          "--visible-skills-manifest",
          manifest,
        ],
        { cwd: path.resolve("."), encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("intents: 0 Markdown files, 0 parsed");
      expect(result.stdout).toContain(
        "intents/.: unable to inspect intent root (ENOTDIR)",
      );
      expect(result.stdout).not.toContain("runtime validation failed");
      expect(result.stdout).not.toContain(root);
      expect(result.stderr).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves validator errors when summary enumeration cannot read a nested directory", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-validation-cli-unreadable-"),
    );
    const distRoot = path.join(root, "dist");
    const intents = path.join(root, "intents");
    const nested = path.join(intents, "nested");
    const experiences = path.join(root, "experiences");
    const manifest = path.join(root, "visible.json");
    fs.mkdirSync(path.join(distRoot, "src", "intents"), { recursive: true });
    fs.mkdirSync(path.join(distRoot, "src", "experiences"), {
      recursive: true,
    });
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(experiences);
    fs.writeFileSync(path.join(distRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(intents, "valid.md"), "intent");
    fs.writeFileSync(manifest, visibleSkillsManifest({ main: [] }));
    fs.writeFileSync(
      path.join(distRoot, "src", "intents", "routing-validation.js"),
      `export function validateRoutingIntentDirectory() {
        return { valid: false, intents: [{ id: "valid" }], errors: ["nested: unable to read directory (EACCES)"] };
      }`,
    );
    fs.writeFileSync(
      path.join(distRoot, "src", "experiences", "index.js"),
      `export function validateExperienceDirectory() {
        return { valid: true, entries: [], errors: [] };
      }`,
    );
    fs.chmodSync(nested, 0o000);

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/validate-runtime-data.mjs"),
          "--dist-root",
          distRoot,
          "--intents",
          intents,
          "--experiences",
          experiences,
          "--visible-skills-manifest",
          manifest,
        ],
        { cwd: path.resolve("."), encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("intents: 1 Markdown file, 1 parsed");
      expect(result.stdout).toContain(
        "intents/nested: unable to read directory (EACCES)",
      );
      expect(result.stdout).not.toContain("runtime validation failed");
      expect(result.stdout).not.toContain(root);
      expect(result.stderr).toBe("");
    } finally {
      fs.chmodSync(nested, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the legacy agent-to-string-array manifest", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-validation-cli-legacy-manifest-"),
    );
    const manifest = path.join(root, "visible.json");
    fs.writeFileSync(manifest, JSON.stringify({ main: ["react"] }));

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/validate-runtime-data.mjs"),
          "--dist-root",
          path.join(root, "dist"),
          "--intents",
          path.join(root, "intents"),
          "--experiences",
          path.join(root, "experiences"),
          "--visible-skills-manifest",
          manifest,
        ],
        { cwd: path.resolve("."), encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("visible-skills manifest is invalid");
      expect(result.stdout).not.toContain(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate identities and malformed private fingerprints", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "runtime-validation-cli-invalid-manifest-"),
    );
    const manifest = path.join(root, "visible.json");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "main",
            inventory: [
              {
                name: "react",
                source: "workspace",
                winnerFingerprint: "not-a-fingerprint",
                fingerprint: "3".repeat(64),
              },
              {
                name: " React ",
                source: "workspace",
                winnerFingerprint: "1".repeat(64),
                fingerprint: "3".repeat(64),
              },
            ],
          },
        ],
      }),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/validate-runtime-data.mjs"),
          "--dist-root",
          path.join(root, "dist"),
          "--intents",
          path.join(root, "intents"),
          "--experiences",
          path.join(root, "experiences"),
          "--visible-skills-manifest",
          manifest,
        ],
        { cwd: path.resolve("."), encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("visible-skills manifest is invalid");
      expect(result.stdout).not.toContain(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails without every required argument", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/validate-runtime-data.mjs"),
        "--dist-root",
        "dist",
      ],
      { cwd: path.resolve("."), encoding: "utf-8" },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "required: --dist-root, --intents, --experiences, --visible-skills-manifest",
    );
  });
});
