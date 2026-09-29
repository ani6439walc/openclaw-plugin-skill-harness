import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SkillExperienceCatalog,
  validateExperienceDirectory,
} from "./catalog.js";

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
    id: string,
    params: {
      skills?: readonly string[];
      summary?: string;
      keywords?: readonly string[];
      body?: string;
      extraFiles?: Record<string, string>;
    } = {},
  ): string {
    const directory = path.join(experienceRoot, id);
    fs.mkdirSync(directory, { recursive: true });

    const summary = params.summary ?? "Reliable React forms";
    fs.writeFileSync(path.join(directory, "summary.md"), summary);

    const keywords = params.keywords ?? ["forms", "validation"];
    fs.writeFileSync(
      path.join(directory, "keywords.md"),
      keywords.map((k) => `- ${k}`).join("\n"),
    );

    const body =
      params.body ?? "Use controlled inputs and validate at the boundary.";
    fs.writeFileSync(path.join(directory, "body.md"), body);

    if (params.skills !== undefined) {
      fs.writeFileSync(
        path.join(directory, "skills.md"),
        params.skills.map((s) => `- ${s}`).join("\n"),
      );
    } else {
      fs.writeFileSync(path.join(directory, "skills.md"), "- react\n");
    }

    if (params.extraFiles) {
      for (const [name, content] of Object.entries(params.extraFiles)) {
        fs.writeFileSync(path.join(directory, name), content);
      }
    }

    return directory;
  }

  it("treats an absent root as an empty catalog", () => {
    const catalog = new SkillExperienceCatalog(dataRoot);

    expect(catalog.listForSkills(["react"])).toEqual([]);
    expect(catalog.resolve("forms")).toBeUndefined();
    expect(catalog.search({})).toEqual([]);
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
    const catalog = new SkillExperienceCatalog(dataRoot);
    expect(catalog.listForSkills(["react"])).toEqual([]);
    expect(catalog.resolve("forms")).toBeUndefined();
  });

  it("loads strict entries with id and skills array", () => {
    const dir = writeEntry("forms", {
      skills: ["react", "web"],
      summary: "Reliable React forms",
      keywords: ["forms", "validation"],
      body: "Use controlled inputs and validate at the boundary.",
    });
    const catalog = new SkillExperienceCatalog(dataRoot);

    expect(catalog.resolve("forms")).toEqual({
      id: "forms",
      skills: ["react", "web"],
      summary: "Reliable React forms",
      keywords: ["forms", "validation"],
      body: "Use controlled inputs and validate at the boundary.",
      path: dir,
    });
    expect(catalog.listForSkills([" REACT "])).toEqual([
      expect.objectContaining({ id: "forms" }),
    ]);
    expect(catalog.listForSkills(["web"])).toEqual([
      expect.objectContaining({ id: "forms" }),
    ]);
    expect(catalog.resolve("../secrets/token")).toBeUndefined();
  });

  it("rescans on every operation so live additions and deletions are visible", () => {
    const catalog = new SkillExperienceCatalog(dataRoot);
    expect(catalog.listForSkills(["react"])).toEqual([]);

    const dir = writeEntry("forms");
    expect(catalog.listForSkills(["react"]).map((entry) => entry.id)).toEqual([
      "forms",
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
    expect(catalog.listForSkills(["react"])).toEqual([]);
  });

  it("ranks by id exact, exact keyword count, summary phrases, body phrases, then id", () => {
    writeEntry("forms", {
      skills: ["react"],
      summary: "Forms only",
      keywords: ["forms"],
      body: "forms forms forms",
    });
    writeEntry("keyword-rich", {
      skills: ["react"],
      summary: "Other",
      keywords: ["forms", "FORMS"],
      body: "unrelated",
    });
    writeEntry("summary-rich", {
      skills: ["react"],
      summary: "forms forms",
      keywords: ["other"],
      body: "forms forms forms forms",
    });
    const catalog = new SkillExperienceCatalog(dataRoot);

    expect(catalog.search({ query: "forms" }).map((entry) => entry.id)).toEqual(
      ["forms", "summary-rich"],
    );
    expect(
      catalog.search({ query: "", limit: 2 }).map((entry) => entry.id),
    ).toEqual(["forms", "summary-rich"]);
  });

  it("normalizes NFKC, whitespace, and locale-independent lowercase for lookup and search", () => {
    writeEntry("forms", {
      skills: ["react"],
      summary: "ＦＯＲＭＳ   GUIDE",
      keywords: ["ＦＯＲＭＳ"],
    });
    const catalog = new SkillExperienceCatalog(dataRoot);

    expect(catalog.search({ query: " forms  guide " })).toEqual([
      expect.objectContaining({ id: "forms" }),
    ]);
  });

  it("rejects missing files, bounds, and invalid names during validation", () => {
    writeEntry("unknown-files", { extraFiles: { "extra.txt": "not allowed" } });
    writeEntry("long-summary", { summary: "😀".repeat(241) });
    writeEntry("long-body", { body: "😀".repeat(12_001) });
    writeEntry("long-keyword", { keywords: ["😀".repeat(65)] });
    writeEntry("duplicate-keyword", { keywords: ["Forms", " forms "] });
    writeEntry("empty-keywords", { keywords: [] });
    writeEntry("many-keywords", {
      keywords: Array.from({ length: 13 }, (_, i) => `k${i}`),
    });
    writeEntry("invalid-skill", { skills: ["INVALID SKILL!"] });

    const incompleteDir = path.join(experienceRoot, "incomplete");
    fs.mkdirSync(incompleteDir, { recursive: true });
    fs.writeFileSync(path.join(incompleteDir, "summary.md"), "summary");

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react"] },
    });

    expect(result.valid).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.errors.map((error) => error.file)).toEqual(
      expect.arrayContaining([
        "duplicate-keyword",
        "empty-keywords",
        "incomplete",
        "invalid-skill",
        "long-body",
        "long-keyword",
        "long-summary",
        "many-keywords",
        "unknown-files",
      ]),
    );
  });

  it("validates every experience and reports skills invisible to every configured agent", () => {
    writeEntry("forms", { skills: ["react"] });
    writeEntry("signals", { skills: ["vue"] });
    writeEntry("token", { skills: ["secret"] });

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react"], specialist: ["vue"] },
    });

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "forms",
      "signals",
    ]);
    expect(result.errors).toContainEqual({
      file: "token",
      message: "skill secret is not visible to any configured agent",
    });
  });

  it("allows general experiences without skills", () => {
    writeEntry("general-workflow", { skills: [] });

    const result = validateExperienceDirectory({
      experienceDirectory: experienceRoot,
      visibleSkillsByAgent: { main: ["react"] },
    });

    expect(result.valid).toBe(true);
    expect(result.entries.map((e) => e.id)).toEqual(["general-workflow"]);
    expect(result.entries[0].skills).toEqual([]);
  });

  it("rejects invalid path segments, duplicate canonical ids, and symlinks", () => {
    writeEntry("Forms", { skills: ["react"] });
    writeEntry("forms", { skills: ["react"] });
    writeEntry("bad name", { skills: ["react"] });

    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "experience-outside-"),
    );
    writeEntry("normal", { skills: ["react"] });
    fs.symlinkSync(outside, path.join(experienceRoot, "linked-dir"), "dir");

    try {
      const result = validateExperienceDirectory({
        experienceDirectory: experienceRoot,
        visibleSkillsByAgent: { main: ["react"] },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toMatch(
        /normalized/,
      );
      expect(result.errors.map((error) => error.message)).toContain(
        "duplicate canonical id forms",
      );
      expect(result.errors.map((error) => error.message).join("\n")).toMatch(
        /symbolic link/,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
