import { describe, expect, it } from "vitest";
import { parseInertYamlFrontmatter } from "./frontmatter.js";

describe("parseInertYamlFrontmatter", () => {
  it("parses standard, yaml, yml, and plain markdown documents", () => {
    expect(
      parseInertYamlFrontmatter(
        "---\nname: alpha\ndescription: demo\n---\nBody\n",
      ),
    ).toEqual({
      data: { name: "alpha", description: "demo" },
      content: "Body\n",
    });

    expect(
      parseInertYamlFrontmatter("---yaml\nname: beta\n---\nBeta body\n"),
    ).toEqual({
      data: { name: "beta" },
      content: "Beta body\n",
    });

    expect(
      parseInertYamlFrontmatter("---YML\r\nname: gamma\r\n---\r\nGamma\r\n"),
    ).toEqual({
      data: { name: "gamma" },
      content: "Gamma\r\n",
    });

    expect(parseInertYamlFrontmatter("Plain markdown body\n")).toEqual({
      data: {},
      content: "Plain markdown body\n",
    });

    expect(parseInertYamlFrontmatter("----\nnot frontmatter\n")).toEqual({
      data: {},
      content: "----\nnot frontmatter\n",
    });

    expect(
      parseInertYamlFrontmatter(
        "\uFEFF---\nname: bom-skill\ndescription: utf8 bom\n---\nBOM body\n",
      ),
    ).toEqual({
      data: { name: "bom-skill", description: "utf8 bom" },
      content: "BOM body\n",
    });
  });

  it("rejects executable and non-YAML frontmatter formats before parsing", () => {
    const sentinelKey = "__skillHarnessFrontmatterExecSentinel__";
    const globals = globalThis as Record<string, unknown>;
    delete globals[sentinelKey];

    try {
      for (const raw of [
        `---js\n(() => { globalThis.${sentinelKey} = true; return { name: "pwn" }; })()\n---\nBody\n`,
        `\uFEFF---js\n(() => { globalThis.${sentinelKey} = true; return { name: "pwn" }; })()\n---\nBody\n`,
        `---javascript\n(() => { globalThis.${sentinelKey} = true; return { name: "pwn" }; })()\n---\nBody\n`,
        `---json\n{"name":"json-skill"}\n---\nBody\n`,
        `---coffee\nname: coffee-skill\n---\nBody\n`,
        `---toml\nname = "toml-skill"\n---\nBody\n`,
      ]) {
        expect(() => parseInertYamlFrontmatter(raw)).toThrow(
          "Unsupported frontmatter format",
        );
      }
      expect(globals[sentinelKey]).toBeUndefined();
    } finally {
      delete globals[sentinelKey];
    }
  });

  it("rejects YAML executable tags and non-object frontmatter payloads", () => {
    expect(() =>
      parseInertYamlFrontmatter(
        "---\nname: !!js/function 'function () { return \"pwn\"; }'\n---\nBody\n",
      ),
    ).toThrow();
    expect(() =>
      parseInertYamlFrontmatter("---\n- item-a\n- item-b\n---\nBody\n"),
    ).toThrow("Invalid frontmatter data");
    expect(() =>
      parseInertYamlFrontmatter("---\njust-a-scalar\n---\nBody\n"),
    ).toThrow("Invalid frontmatter data");
  });
});
