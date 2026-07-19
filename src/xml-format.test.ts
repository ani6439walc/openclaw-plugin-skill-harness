import { describe, expect, it } from "vitest";

import { indentXmlLines } from "./xml-format.js";

describe("indentXmlLines", () => {
  it("indents each non-empty line by two spaces per level", () => {
    expect(indentXmlLines("first\nsecond")).toBe("  first\n  second");
    expect(indentXmlLines("first\nsecond", 2)).toBe("    first\n    second");
  });

  it("preserves relative whitespace and leaves blank lines empty", () => {
    expect(indentXmlLines("first\n\n  nested\n\tTabbed\n   ")).toBe(
      "  first\n\n    nested\n  \tTabbed\n",
    );
  });
});
