#!/usr/bin/env node
import { runOntologyImportCli } from "../../../dist/src/skills/relation-ontology.js";
try {
  await runOntologyImportCli(process.argv.slice(2));
} catch {
  console.error(
    "Ontology rebuild failed. Check source/schema, explicit bindings and pinned plan; no private graph or evidence is printed.",
  );
  process.exitCode = 1;
}
