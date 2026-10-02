#!/usr/bin/env node
import { runRelationImportCli } from "../../../dist/src/skills/relation-import.js";
try {
  await runRelationImportCli(process.argv.slice(2));
} catch {
  // Never print model/provider errors: they can contain credentials or evidence.
  console.error(
    "Relation import failed. Check arguments, source, configuration and checkpoint; no raw provider error is printed.",
  );
  process.exitCode = 1;
}
