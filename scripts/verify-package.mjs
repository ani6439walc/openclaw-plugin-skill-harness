import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const staleArtifacts = [
  "dist/src/classification/instruction-skill-evidence.js",
  "dist/vitest.config.js",
];

for (const artifact of staleArtifacts) {
  const path = resolve(root, artifact);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "stale package sentinel\n");
}

execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });

for (const artifact of staleArtifacts) {
  if (existsSync(resolve(root, artifact))) {
    throw new Error(`build retained stale artifact: ${artifact}`);
  }
}

const packed = JSON.parse(
  execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  }),
);
const packedPaths = packed.files.map((file) => file.path);

for (const artifact of staleArtifacts) {
  if (packedPaths.some((path) => path.includes(artifact))) {
    throw new Error(`package includes removed artifact: ${artifact}`);
  }
}
