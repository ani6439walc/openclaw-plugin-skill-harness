import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const checker = path.join(repoRoot, "scripts/check-intent-contract-types.mjs");

const CONTRACT_TYPES = `
export type IntentDefinition = {
  triggers: string[];
  examples: string[];
  domain: string;
  fastpath: { keywords: string[] };
  guidance: string;
};
export type IntentCatalogEntry = { id: string; definition: IntentDefinition };
`;

const VALID_DEFINITION = `
  triggers: [],
  examples: [],
  domain: "testing",
  fastpath: { keywords: [] },
  guidance: "Use the testing workflow."
`;

function runMiniProject(source) {
  const root = mkdtempSync(path.join(tmpdir(), "intent-contract-"));
  try {
    writeFileSync(path.join(root, "types.ts"), CONTRACT_TYPES);
    writeFileSync(
      path.join(root, "tsconfig.intent-contract.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      }),
    );
    writeFileSync(path.join(root, "fixture.ts"), source);
    return spawnSync(process.execPath, [checker, "--project", "tsconfig.intent-contract.json"], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function expectValid(source) {
  const result = runMiniProject(source);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function expectContractViolation(source, expectedMessage) {
  const result = runMiniProject(source);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /contract violation/i);
  assert.match(output, /fixture\.ts:\d+:/);
  if (expectedMessage) assert.match(output, expectedMessage);
}

test("accepts valid guidance contracts and ignores unrelated diagnostics", () => {
  expectValid(`
    import type { IntentCatalogEntry, IntentDefinition } from "./types.js";
    const definition: IntentDefinition = {${VALID_DEFINITION}};
    const entry: IntentCatalogEntry = { id: "testing", definition };
    const unrelated: number = "pre-existing type debt";
    void entry;
    void unrelated;
  `);
});

test("rejects a missing required guidance field", () => {
  expectContractViolation(`
    import type { IntentDefinition } from "./types.js";
    const definition: IntentDefinition = {
      triggers: [], examples: [], domain: "testing", fastpath: { keywords: [] }
    };
    void definition;
  `);
});

test("rejects direct and spread-inherited legacy prompt fields", () => {
  expectContractViolation(`
    import type { IntentDefinition } from "./types.js";
    const legacy = { prompt: "legacy body" };
    const direct: IntentDefinition = {${VALID_DEFINITION}, prompt: "legacy body" };
    const spread: IntentDefinition = { ...legacy, ${VALID_DEFINITION} };
    void direct;
    void spread;
  `);
});

test("rejects direct and spread-inherited nested fastpath hints", () => {
  expectContractViolation(`
    import type { IntentDefinition } from "./types.js";
    const legacyFastpath = { keywords: [], hint: "legacy fast path" };
    const direct: IntentDefinition = {
      triggers: [], examples: [], domain: "testing",
      fastpath: { keywords: [], hint: "legacy fast path" }, guidance: "Use the testing workflow."
    };
    const spread: IntentDefinition = {
      triggers: [], examples: [], domain: "testing",
      fastpath: { ...legacyFastpath }, guidance: "Use the testing workflow."
    };
    void direct;
    void spread;
  `);
});

test("follows aliased contract imports and untyped identifier call flows", () => {
  expectContractViolation(`
    import type { IntentDefinition as Definition } from "./types.js";
    function accept(definition: Definition) { void definition; }
    const intermediate = {${VALID_DEFINITION}, prompt: "legacy body" };
    accept(intermediate);
  `);
});

test("checks assignment, return-typed, and satisfies contract flows", () => {
  expectContractViolation(`
    import type { IntentDefinition } from "./types.js";
    let assigned: IntentDefinition;
    const source = {${VALID_DEFINITION}, prompt: "legacy body" };
    assigned = source;
    function create(): IntentDefinition {
      return {${VALID_DEFINITION}, prompt: "legacy body" };
    }
    const satisfied = {${VALID_DEFINITION}, prompt: "legacy body" } satisfies IntentDefinition;
    void assigned;
    void create;
    void satisfied;
  `);
});

test("rejects any, unknown, assertion, and suppression-directive bypasses", () => {
  expectContractViolation(`
    import type { IntentDefinition } from "./types.js";
    function accept(definition: IntentDefinition) { void definition; }
    const anyValue: any = {${VALID_DEFINITION}, prompt: "legacy body" };
    const unknownValue: unknown = {${VALID_DEFINITION}, prompt: "legacy body" };
    const asserted = {${VALID_DEFINITION}, prompt: "legacy body" } as unknown as IntentDefinition;
    // @ts-ignore bypasses the missing guidance compiler diagnostic
    const suppressed: IntentDefinition = {
      triggers: [], examples: [], domain: "testing", fastpath: { keywords: [] }
    };
    accept(anyValue);
    accept(unknownValue as IntentDefinition);
    accept(asserted);
    void suppressed;
  `, /suppression directive/i);
});

test("discovers all contract fixture sources from the project config", () => {
  const result = spawnSync(
    process.execPath,
    [checker, "--project", "tsconfig.intent-contract.json", "--list-files"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.error, undefined, result.stderr);
  const files = new Set(result.stdout.trim().split("\n"));
  for (const file of [
    "src/classification/candidates.test.ts",
    "src/skills/tools.test.ts",
    "src/skills/files.test.ts",
    "src/skills/indexer.test.ts",
    "src/intents/skill-references.test.ts",
    "src/stats/aggregator.test.ts",
    "src/classification/prompts.test.ts",
    "src/hooks/index.test.ts",
    "src/review/snapshot-formatter.test.ts",
    "src/review/catalog-projection.test.ts",
  ]) {
    assert.ok(files.has(file), `expected ${file} in discovered source set`);
  }
});
