import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("does not retain the removed generated-hint pipeline phase", () => {
  const source = readFileSync(
    new URL("./pipeline-events.ts", import.meta.url),
    "utf8",
  );

  expect(source).not.toContain(["hint", "generate"].join("-"));
});
