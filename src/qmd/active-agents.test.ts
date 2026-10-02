import { describe, expect, it } from "vitest";
import { activeAgentIdsFromConfig } from "./active-agents.js";

describe("activeAgentIdsFromConfig", () => {
  it("keeps implicit main, normalized configured agents and explicit working sets", () => {
    expect(
      activeAgentIdsFromConfig(
        { agents: { entries: { ＣＯＤＥＲ: {}, main: {} } } },
        ["writer", "CODER"],
      ),
    ).toEqual(["main", "coder", "writer"]);
  });
  it.each([
    undefined,
    null,
    {},
    { agents: {} },
    { agents: { entries: [] } },
    { agents: { entries: { coder: null } } },
    { agents: { entries: { coder: [] } } },
    { agents: { entries: { " ": {} } } },
  ])("refuses incomplete or malformed authority: %j", (config) => {
    expect(activeAgentIdsFromConfig(config, ["writer"])).toBeUndefined();
  });
  it("accepts an explicitly empty registry", () => {
    expect(activeAgentIdsFromConfig({ agents: { entries: {} } }, [])).toEqual([
      "main",
    ]);
  });
});
