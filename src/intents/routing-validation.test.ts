import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { validateRoutingIntentDirectory } from "./routing-validation.js";

function intentMarkdown(
  params: {
    guidance?: string;
    frontmatter?: string;
    body?: string;
  } = {},
): string {
  const guidance =
    params.guidance ?? "Route this request using stable evidence.";
  return `---
triggers:
  - "  route this  "
examples:
  - "  route this example  "
domain: "  routing  "
${params.frontmatter ?? ""}guidance: ${JSON.stringify(guidance)}
---
${params.body ?? ""}`;
}

describe("validateRoutingIntentDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-intent-validator-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(file: string, content: string): void {
    fs.writeFileSync(path.join(dir, file), content);
  }

  function errors(): string[] {
    return validateRoutingIntentDirectory(dir).errors;
  }

  it("accepts routing-only intents, normalizes values, and defaults fastpath", () => {
    write("simple.md", intentMarkdown());
    write(
      "complete.md",
      intentMarkdown({
        guidance: "  Keep routing focused！  ",
        frontmatter: `skills:
  - "  Alpha.Skill  "
  - "beta-skill"
candidate:
  scope: cross-flow
  keywords:
    - "  exact candidate  "
fastpath:
  keywords:
    - "  exact route  "
`,
      }),
    );

    expect(validateRoutingIntentDirectory(dir, ["complete", "simple"])).toEqual(
      {
        valid: true,
        errors: [],
        intents: [
          {
            id: "complete",
            file: "complete.md",
            definition: {
              triggers: ["route this"],
              examples: ["route this example"],
              domain: "routing",
              skills: ["Alpha.Skill", "beta-skill"],
              candidate: {
                scope: "cross-flow",
                keywords: ["exact candidate"],
              },
              fastpath: { keywords: ["exact route"] },
              guidance: "Keep routing focused！",
            },
          },
          {
            id: "simple",
            file: "simple.md",
            definition: {
              triggers: ["route this"],
              examples: ["route this example"],
              domain: "routing",
              fastpath: { keywords: [] },
              guidance: "Route this request using stable evidence.",
            },
          },
        ],
      },
    );
  });

  it("accepts empty examples and counts guidance limits by Unicode code points", () => {
    write(
      "boundary.md",
      `---
triggers: ["route"]
examples: []
domain: "routing"
guidance: "${"😀".repeat(299)}."
---
`,
    );

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects missing, empty, multiline, and overlong guidance", () => {
    write(
      "empty.md",
      `---
triggers: ["route"]
examples: []
domain: routing
guidance: "   "
---
`,
    );
    write("long.md", intentMarkdown({ guidance: `${"😀".repeat(300)}.` }));
    write(
      "missing.md",
      `---
triggers: ["route"]
examples: []
domain: routing
---
`,
    );
    write(
      "multiline.md",
      `---
triggers: ["route"]
examples: []
domain: routing
guidance: |-
  Route this request.
  Keep it focused.
---
`,
    );
    write(
      "unicode-multiline.md",
      intentMarkdown({ guidance: "Route this request.\u2028Keep it focused." }),
    );

    expect(errors()).toEqual(
      expect.arrayContaining([
        "empty.md: guidance must be a non-empty string",
        "long.md: guidance must contain at most 300 Unicode code points",
        "missing.md: guidance must be a non-empty string",
        "multiline.md: guidance must be one line",
        "unicode-multiline.md: guidance must be one line",
      ]),
    );
  });

  it("enforces the structural one-sentence guidance grammar", () => {
    const invalid: Record<string, string> = {
      "bullet.md": "- Route this request.",
      "command.md": "$ pnpm test.",
      "corepack.md": "corepack pnpm test.",
      "echo.md": "echo routing status.",
      "env.md": "env pnpm test.",
      "env-assignment.md": "env MODE=strict pnpm test.",
      "kill.md": "kill process safely.",
      "directive-invoke.md": "Invoke the routing skill.",
      "directive-load.md": "Load the routing skill.",
      "directive-read.md": "Read the routing skill.",
      "directive-use.md": "Use the routing skill.",
      "fence.md": "```sh run this command.```",
      "heading.md": "## Route this request.",
      "multiple.md": "Route this request. Then verify it.",
      "assignment.md": "MODE=strict pnpm test.",
      "mkdir.md": "mkdir routing-output.",
      "nested-path.md": "Inspect config/routing before deciding.",
      "numbered.md": "1. Route this request.",
      "path.md": "Read ../routing/config before deciding.",
      "perl.md": "perl -e 'print 1'.",
      "printf.md": "printf routing-status.",
      "route.md": "route requests using stable evidence.",
      "rsync.md": "rsync routing data.",
      "true.md": "true before routing.",
      "windows-path.md": "Inspect C:\\routing\\config before deciding.",
      "whoami.md": "whoami before routing.",
      "whoami-separator.md": "whoami; route safely.",
      "zero.md": "Route this request",
    };
    for (const [file, guidance] of Object.entries(invalid)) {
      write(file, intentMarkdown({ guidance }));
    }

    const result = errors();
    for (const file of ["multiple.md", "zero.md"]) {
      expect(result).toContain(
        `${file}: guidance must contain exactly one terminal delimiter and it must be the final code point`,
      );
    }
    for (const file of ["bullet.md", "fence.md", "heading.md", "numbered.md"]) {
      expect(result).toContain(
        `${file}: guidance must not start with a Markdown list, heading, or fence`,
      );
    }
    for (const file of [
      "command.md",
      "corepack.md",
      "echo.md",
      "env.md",
      "env-assignment.md",
      "kill.md",
      "assignment.md",
      "mkdir.md",
      "perl.md",
      "printf.md",
      "true.md",
      "whoami.md",
      "whoami-separator.md",
    ]) {
      expect(result).toContain(
        `${file}: guidance must not start with a shell command prefix`,
      );
    }
    for (const file of ["route.md", "rsync.md"]) {
      expect(result).toContain(
        `${file}: guidance must start with an uppercase ASCII letter when it starts with an ASCII letter`,
      );
    }
    for (const file of [
      "directive-invoke.md",
      "directive-load.md",
      "directive-read.md",
      "directive-use.md",
    ]) {
      expect(result).toContain(
        `${file}: guidance must not direct the agent to use, load, read, or invoke a skill`,
      );
    }
    for (const file of ["nested-path.md", "path.md", "windows-path.md"]) {
      expect(result).toContain(
        `${file}: guidance must not contain an absolute or relative path`,
      );
    }
  });

  it("accepts natural sentences that begin with words shared by command names", () => {
    write(
      "go.md",
      intentMarkdown({ guidance: "Go carefully when routing requests." }),
    );
    write(
      "make.md",
      intentMarkdown({ guidance: "Make routing decisions reversible." }),
    );
    write(
      "set.md",
      intentMarkdown({ guidance: "Set clear routing boundaries." }),
    );
    write(
      "chinese.md",
      intentMarkdown({ guidance: "使用穩定證據處理路由請求。" }),
    );

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("rejects legacy and unknown fields plus non-empty Markdown bodies", () => {
    write(
      "body.md",
      intentMarkdown({ body: "## Guidelines\n- Legacy instructions.\n" }),
    );
    write(
      "hint.md",
      intentMarkdown({
        frontmatter: `fastpath:
  keywords: ["route"]
  hint: "Legacy hint."
`,
      }),
    );
    write(
      "unknown.md",
      intentMarkdown({ frontmatter: "enabled: true\nname: Legacy\n" }),
    );
    write(
      "unknown-candidate.md",
      intentMarkdown({ frontmatter: "candidate:\n  weight: 2\n" }),
    );
    write(
      "unknown-fastpath.md",
      intentMarkdown({ frontmatter: "fastpath:\n  mode: exact\n" }),
    );

    expect(errors()).toEqual(
      expect.arrayContaining([
        "body.md: Markdown body must be empty",
        "hint.md: fastpath.hint is not supported",
        "unknown.md: unsupported top-level field enabled",
        "unknown.md: unsupported top-level field name",
        "unknown-candidate.md: candidate contains unsupported field weight",
        "unknown-fastpath.md: fastpath contains unsupported field mode",
      ]),
    );
  });

  it("rejects malformed routing field values", () => {
    write(
      "bad-arrays.md",
      `---
triggers: ["route", ""]
examples: example
domain: ""
skills: ["valid", 3]
guidance: "Route this request."
---
`,
    );
    write(
      "bad-candidate.md",
      intentMarkdown({
        frontmatter: `candidate:
  scope: global
  keywords: ["valid", ""]
`,
      }),
    );
    write(
      "bad-fastpath.md",
      intentMarkdown({ frontmatter: "fastpath: exact\n" }),
    );
    write(
      "implicit-scalars.md",
      intentMarkdown({
        frontmatter: `candidate: 2026-08-12
fastpath:
  keywords: 2026-08-12
`,
      }),
    );

    expect(errors()).toEqual(
      expect.arrayContaining([
        "bad-arrays.md: triggers must contain at least one non-empty string and only non-empty strings",
        "bad-arrays.md: examples must be an array containing only non-empty strings",
        "bad-arrays.md: domain must be a non-empty string",
        "bad-arrays.md: skills must be an array containing only non-empty strings",
        "bad-candidate.md: candidate.scope must be cross-flow when provided",
        "bad-candidate.md: candidate.keywords must be an array containing only non-empty strings",
        "bad-fastpath.md: fastpath must be an object",
        "implicit-scalars.md: candidate must be an object",
        "implicit-scalars.md: fastpath.keywords must be an array containing only non-empty strings",
      ]),
    );
  });

  it("rejects duplicate IDs, duplicate canonical skills, path-like skills, and missing targets deterministically", () => {
    write(
      "ALPHA.md",
      intentMarkdown({
        frontmatter: `skills:
  - " Routing-Skill "
  - "routing-skill"
  - "../private-skill"
  - "group/child"
`,
      }),
    );
    write("alpha.md", intentMarkdown());

    const result = validateRoutingIntentDirectory(dir, ["ALPHA", "missing"]);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      "ALPHA.md: duplicate skill name routing-skill after trim/lowercase normalization",
      "ALPHA.md: skill name must not be path-like: ../private-skill",
      "ALPHA.md: skill name must not be path-like: group/child",
      "alpha.md: duplicate intent id alpha already used by ALPHA.md",
      "target intent not found: missing",
    ]);
  });

  it("reports noncanonical Markdown extensions instead of silently skipping them", () => {
    write("valid.md", intentMarkdown());
    write("hidden.MD", intentMarkdown());

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: false,
      errors: [
        "hidden.MD: intent Markdown filename must use the .md extension",
      ],
    });
  });

  it("rejects nested intent Markdown files instead of silently skipping them", () => {
    write("valid.md", intentMarkdown());
    const nested = path.join(dir, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "malformed.md"), intentMarkdown());

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: false,
      errors: [
        "nested/malformed.md: intent Markdown files must be directly under the intent directory",
      ],
    });
  });

  it("returns a deterministic relative error when a nested directory cannot be read", () => {
    write("valid.md", intentMarkdown());
    const nested = path.join(dir, "nested");
    fs.mkdirSync(nested);
    fs.chmodSync(nested, 0o000);

    try {
      expect(validateRoutingIntentDirectory(dir)).toMatchObject({
        valid: false,
        errors: ["nested: unable to read directory (EACCES)"],
        intents: [expect.objectContaining({ id: "valid" })],
      });
    } finally {
      fs.chmodSync(nested, 0o700);
    }
  });

  it("returns a relative error when a listed entry cannot be inspected", () => {
    write("valid.md", intentMarkdown());
    fs.chmodSync(dir, 0o444);

    try {
      expect(validateRoutingIntentDirectory(dir)).toMatchObject({
        valid: false,
        errors: ["valid.md: unable to inspect entry (EACCES)"],
        intents: [],
      });
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it("rejects nested and non-Markdown symbolic links instead of silently skipping them", () => {
    write("valid.md", intentMarkdown());
    const outsideDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "routing-intent-validator-nested-outside-"),
    );
    const outsideFile = path.join(path.dirname(dir), "outside.txt");
    fs.writeFileSync(
      path.join(outsideDirectory, "external.md"),
      intentMarkdown(),
      "utf-8",
    );
    fs.writeFileSync(outsideFile, "external", "utf-8");
    fs.symlinkSync(outsideDirectory, path.join(dir, "nested"), "dir");
    fs.symlinkSync(outsideFile, path.join(dir, "notes.txt"), "file");

    try {
      expect(validateRoutingIntentDirectory(dir)).toMatchObject({
        valid: false,
        errors: [
          "nested: symbolic links are not allowed",
          "notes.txt: symbolic links are not allowed",
        ],
        intents: [expect.objectContaining({ id: "valid" })],
      });
    } finally {
      fs.rmSync(outsideDirectory, { recursive: true, force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects a symbolic-link intent root instead of validating external files", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "routing-intent-validator-outside-"),
    );
    const linkedRoot = path.join(path.dirname(dir), "linked-intents");
    fs.writeFileSync(
      path.join(outside, "external.md"),
      intentMarkdown(),
      "utf-8",
    );
    fs.symlinkSync(outside, linkedRoot);

    try {
      expect(validateRoutingIntentDirectory(linkedRoot)).toMatchObject({
        valid: false,
        errors: [".: intent root cannot be a symbolic link"],
        intents: [],
      });
    } finally {
      fs.rmSync(linkedRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a dangling symbolic-link intent root before the missing-root fallback", () => {
    const linkedRoot = path.join(path.dirname(dir), "dangling-intents");
    fs.symlinkSync(path.join(path.dirname(dir), "missing-intents"), linkedRoot);

    try {
      expect(validateRoutingIntentDirectory(linkedRoot)).toMatchObject({
        valid: false,
        errors: [".: intent root cannot be a symbolic link"],
        intents: [],
      });
    } finally {
      fs.unlinkSync(linkedRoot);
    }
  });

  it("does not expose the declared host path for a truly missing root", () => {
    const missingRoot = path.join(path.dirname(dir), "private-missing-intents");

    const result = validateRoutingIntentDirectory(missingRoot);

    expect(result).toEqual({
      valid: false,
      errors: ["no intent Markdown files found"],
      intents: [],
    });
    expect(result.errors.join("\n")).not.toContain(missingRoot);
  });

  it("returns a relative error when the declared root cannot be inspected", () => {
    const parentFile = path.join(path.dirname(dir), "not-a-directory");
    const invalidRoot = path.join(parentFile, "intents");
    fs.writeFileSync(parentFile, "regular file", "utf-8");

    try {
      expect(validateRoutingIntentDirectory(invalidRoot)).toMatchObject({
        valid: false,
        errors: [".: unable to inspect intent root (ENOTDIR)"],
        intents: [],
      });
    } finally {
      fs.rmSync(parentFile, { force: true });
    }
  });

  it("rejects symbolic-link intent files instead of parsing outside content", () => {
    const outside = path.join(path.dirname(dir), "outside.md");
    fs.writeFileSync(outside, intentMarkdown(), "utf-8");
    fs.symlinkSync(outside, path.join(dir, "linked.md"));

    expect(validateRoutingIntentDirectory(dir)).toMatchObject({
      valid: false,
      errors: ["linked.md: symbolic links are not allowed"],
    });
  });

  it("returns a relative error when a scanned Markdown file cannot be reinspected", () => {
    write("valid.md", intentMarkdown());
    const originalLstatSync = fs.lstatSync;
    let validFileInspections = 0;
    fsDefault.lstatSync = ((target: fs.PathLike) => {
      if (String(target).endsWith(`${path.sep}valid.md`)) {
        validFileInspections += 1;
        if (validFileInspections === 2) {
          const error = new Error(
            "must not leak this path",
          ) as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
      return originalLstatSync(target);
    }) as typeof fsDefault.lstatSync;
    syncBuiltinESMExports();

    try {
      expect(validateRoutingIntentDirectory(dir)).toMatchObject({
        valid: false,
        errors: ["valid.md: unable to inspect intent Markdown file (EACCES)"],
        intents: [],
      });
    } finally {
      fsDefault.lstatSync = originalLstatSync;
      syncBuiltinESMExports();
    }
  });

  it("returns a relative error when a validated Markdown file cannot be read", () => {
    write("valid.md", intentMarkdown());
    fs.chmodSync(path.join(dir, "valid.md"), 0o000);

    try {
      expect(validateRoutingIntentDirectory(dir)).toMatchObject({
        valid: false,
        errors: ["valid.md: unable to read or parse intent Markdown (EACCES)"],
        intents: [],
      });
    } finally {
      fs.chmodSync(path.join(dir, "valid.md"), 0o600);
    }
  });

  it("parses every Markdown file without writing to the directory", () => {
    write("a.md", intentMarkdown());
    write("b.md", "not frontmatter");
    const before = fs.readdirSync(dir).map((file) => ({
      file,
      content: fs.readFileSync(path.join(dir, file), "utf-8"),
      mtimeMs: fs.statSync(path.join(dir, file)).mtimeMs,
    }));

    const result = validateRoutingIntentDirectory(dir);

    expect(result.errors.some((error) => error.startsWith("b.md:"))).toBe(true);
    expect(
      fs.readdirSync(dir).map((file) => ({
        file,
        content: fs.readFileSync(path.join(dir, file), "utf-8"),
        mtimeMs: fs.statSync(path.join(dir, file)).mtimeMs,
      })),
    ).toEqual(before);
  });
});
